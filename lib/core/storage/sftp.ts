import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"

import type { SFTPWrapper, Stats } from "ssh2"

import { SFTP_REQUEST_TIMEOUT_MS, WRITE_CHUNK_BYTES } from "./limits"

/**
 * A storage root's SFTP session as promises, with a time limit on every
 * request. It is the one thing in lib/core/storage/ that talks SFTP, and it
 * checks no path itself: files.ts confines every path it hands in to the
 * root's real path first. The session comes from upstream.ts (ssh/client.ts
 * openSftp), opened with the key a request handed in.
 */

export type EntryType = "file" | "folder" | "link" | "other"

export type RemoteStat = {
  type: EntryType
  size: number
  /** Seconds since the epoch, as SFTP has it. */
  mtime: number
  /** The permission bits, without the file type. */
  mode: number
  uid: number
  gid: number
}

/** SFTP's status codes (draft-ietf-secsh-filexfer-02), the ones PCP reads. */
export const SFTP_STATUS = {
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  OP_UNSUPPORTED: 8,
} as const

/** An SFTP request the server answered with a failure. */
export class SftpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = "SftpError"
  }
}

export function sftpStatus(error: unknown): number | null {
  if (error instanceof SftpError) return error.status
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "number" ? code : null
}

function statOf(stats: Stats): RemoteStat {
  const type: EntryType = stats.isSymbolicLink()
    ? "link"
    : stats.isDirectory()
      ? "folder"
      : stats.isFile()
        ? "file"
        : "other"

  return {
    type,
    size: typeof stats.size === "number" ? stats.size : 0,
    mtime: typeof stats.mtime === "number" ? stats.mtime : 0,
    mode: (stats.mode ?? 0) & 0o7777,
    uid: stats.uid ?? 0,
    gid: stats.gid ?? 0,
  }
}

/** What a folder holds, as one batch of READDIR answers gives it. */
export type RemoteEntry = { name: string; stat: RemoteStat }

export type RemoteFs = {
  realpath(path: string): Promise<string>
  /** The entry itself: a symbolic link is a link. */
  lstat(path: string): Promise<RemoteStat>
  /** What a symbolic link points to. */
  stat(path: string): Promise<RemoteStat>
  /**
   * A folder's entries, at most `max` (then `more` is true): the server
   * sends them in batches, and PCP stops asking once it has enough.
   */
  readdir(
    path: string,
    max: number,
  ): Promise<{ entries: RemoteEntry[]; more: boolean }>
  mkdir(path: string, mode: number): Promise<void>
  rmdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
  /** SFTP's own rename, which fails when `to` is there already. */
  rename(from: string, to: string): Promise<void>
  /**
   * A rename that replaces `to`: OpenSSH's posix-rename when the server
   * has it, else `to` removed first.
   */
  replace(from: string, to: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  /** The whole file, read in turn; past `maxBytes` it stops and refuses. */
  readFile(path: string, maxBytes: number): Promise<Buffer>
  /**
   * A file's bytes as a stream, from `start` up to but not at `end` when
   * given (a range of the owner's download, the chunks of a sealed object).
   */
  readStream(path: string, range?: { start?: number; end?: number }): Readable
  /**
   * Writes a new file that must not be there yet (exclusive create), in
   * chunks, with `mode`.
   */
  writeNew(path: string, bytes: Buffer, mode: number): Promise<void>
  /**
   * The same from a stream, as it arrives (a sealed object, a converted
   * file): what it wrote, in bytes. Past `maxBytes` it stops and refuses.
   */
  writeNewFrom(
    path: string,
    source: AsyncIterable<Buffer> | Iterable<Buffer>,
    mode: number,
    maxBytes?: number,
  ): Promise<number>
  /** Ends the session. */
  end(): void
}

function timed<T>(
  what: string,
  run: (done: (error: Error | undefined | null, value?: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(
        new SftpError(
          `The server did not answer ${what} within ${SFTP_REQUEST_TIMEOUT_MS / 1000} seconds.`,
          null,
        ),
      )
    }, SFTP_REQUEST_TIMEOUT_MS)

    try {
      run((error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)

        if (error) {
          const status = sftpStatus(error)
          reject(new SftpError(error.message || String(error), status))
        } else {
          resolve(value as T)
        }
      })
    } catch (error) {
      settled = true
      clearTimeout(timer)
      reject(error)
    }
  })
}

/** The SFTP session as a RemoteFs. */
export function remoteFs(sftp: SFTPWrapper, release: () => void): RemoteFs {
  const open = (path: string, flags: "r" | "wx", mode?: number) =>
    timed<Buffer>(`opening ${path}`, (done) =>
      mode === undefined
        ? sftp.open(path, flags, done)
        : sftp.open(path, flags, { mode }, done),
    )
  const close = (handle: Buffer) =>
    timed<void>("closing a file", (done) => sftp.close(handle, done))

  const fs: RemoteFs = {
    realpath: (path) =>
      timed<string>(`resolving ${path}`, (done) => sftp.realpath(path, done)),

    lstat: async (path) =>
      statOf(
        await timed<Stats>(`looking at ${path}`, (done) =>
          sftp.lstat(path, done),
        ),
      ),

    stat: async (path) =>
      statOf(
        await timed<Stats>(`looking at ${path}`, (done) =>
          sftp.stat(path, done),
        ),
      ),

    async readdir(path, max) {
      const handle = await timed<Buffer>(`opening ${path}`, (done) =>
        sftp.opendir(path, done),
      )
      const entries: RemoteEntry[] = []
      let more = false

      try {
        for (;;) {
          let batch: Array<{ filename: string; attrs: Stats }>

          try {
            batch = await timed(`reading ${path}`, (done) =>
              sftp.readdir(handle, done),
            )
          } catch (error) {
            if (sftpStatus(error) === SFTP_STATUS.EOF) break
            throw error
          }

          for (const entry of batch) {
            if (entries.length >= max) {
              more = true
              break
            }
            entries.push({ name: entry.filename, stat: statOf(entry.attrs) })
          }

          if (more) break
        }
      } finally {
        await close(handle).catch(() => {})
      }

      return { entries, more }
    },

    mkdir: (path, mode) =>
      timed<void>(`making ${path}`, (done) => sftp.mkdir(path, { mode }, done)),

    rmdir: (path) =>
      timed<void>(`removing ${path}`, (done) => sftp.rmdir(path, done)),

    unlink: (path) =>
      timed<void>(`removing ${path}`, (done) => sftp.unlink(path, done)),

    rename: (from, to) =>
      timed<void>(`renaming ${from}`, (done) => sftp.rename(from, to, done)),

    async replace(from, to) {
      const extensions = (
        sftp as unknown as { _extensions?: Record<string, string> }
      )._extensions

      if (extensions?.["posix-rename@openssh.com"] === "1") {
        await timed<void>(`renaming ${from}`, (done) =>
          sftp.ext_openssh_rename(from, to, done),
        )
        return
      }

      // No atomic replace on this server: the old file goes first. A
      // failure in between leaves the new one under its part name.
      await fs.unlink(to).catch((error) => {
        if (sftpStatus(error) !== SFTP_STATUS.NO_SUCH_FILE) throw error
      })
      await fs.rename(from, to)
    },

    chmod: (path, mode) =>
      timed<void>(`setting ${path}'s mode`, (done) =>
        sftp.setstat(path, { mode }, done),
      ),

    async readFile(path, maxBytes) {
      const handle = await open(path, "r")
      const chunks: Buffer[] = []
      let total = 0

      try {
        for (;;) {
          const room = Math.min(64 * 1024, maxBytes + 1 - total)
          const buffer = Buffer.alloc(Math.max(1, room))
          const read = await timed<number>(`reading ${path}`, (done) =>
            sftp.read(handle, buffer, 0, buffer.length, total, (error, n) =>
              done(error, n),
            ),
          ).catch((error) => {
            if (sftpStatus(error) === SFTP_STATUS.EOF) return 0
            throw error
          })

          if (read === 0) break
          chunks.push(buffer.subarray(0, read))
          total += read

          if (total > maxBytes) {
            throw new FileTooLargeError(total)
          }
        }
      } finally {
        await close(handle).catch(() => {})
      }

      return Buffer.concat(chunks)
    },

    readStream(path, range = {}) {
      return Readable.from(
        (async function* () {
          const handle = await open(path, "r")
          let position = range.start ?? 0
          const end = range.end ?? Number.POSITIVE_INFINITY

          try {
            while (position < end) {
              const buffer = Buffer.alloc(Math.min(64 * 1024, end - position))
              const read = await timed<number>(`reading ${path}`, (done) =>
                sftp.read(
                  handle,
                  buffer,
                  0,
                  buffer.length,
                  position,
                  (error, n) => done(error, n),
                ),
              ).catch((error) => {
                if (sftpStatus(error) === SFTP_STATUS.EOF) return 0
                throw error
              })

              if (read === 0) return
              position += read
              yield buffer.subarray(0, read)
            }
          } finally {
            await close(handle).catch(() => {})
          }
        })(),
      )
    },

    async writeNewFrom(path, source, mode, maxBytes) {
      const handle = await open(path, "wx", mode)
      let at = 0

      try {
        for await (const chunk of source) {
          if (maxBytes !== undefined && at + chunk.length > maxBytes) {
            throw new FileTooLargeError(at + chunk.length)
          }

          for (let from = 0; from < chunk.length; from += WRITE_CHUNK_BYTES) {
            const length = Math.min(WRITE_CHUNK_BYTES, chunk.length - from)
            const position = at + from
            await timed<void>(`writing ${path}`, (done) =>
              sftp.write(handle, chunk, from, length, position, done),
            )
          }
          at += chunk.length
        }
      } finally {
        await close(handle)
      }

      return at
    },

    async writeNew(path, bytes, mode) {
      // "wx": the server makes it or fails, never opens one that is there.
      const handle = await open(path, "wx", mode)

      try {
        for (let at = 0; at < bytes.length; at += WRITE_CHUNK_BYTES) {
          const length = Math.min(WRITE_CHUNK_BYTES, bytes.length - at)
          await timed<void>(`writing ${path}`, (done) =>
            sftp.write(handle, bytes, at, length, at, done),
          )
        }
      } finally {
        await close(handle)
      }
    },

    end: release,
  }

  return fs
}

/** A file larger than the call may read. */
export class FileTooLargeError extends Error {
  constructor(readonly readSoFar: number) {
    super("The file is larger than PCP reads.")
    this.name = "FileTooLargeError"
  }
}

/** A name for a file while it is written: the name, a few random characters. */
export function partSuffix(): string {
  return `.${randomBytes(4).toString("hex")}`
}
