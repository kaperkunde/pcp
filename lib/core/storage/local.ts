import { createReadStream, type Stats } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"

import { dataDir } from "../data-dir"
import {
  FileTooLargeError,
  SFTP_STATUS,
  SftpError,
  type EntryType,
  type RemoteFs,
  type RemoteStat,
} from "./sftp"

/**
 * The local backend: PCP's own store in its data folder, as the RemoteFs
 * files.ts and encrypted.ts already confine and use for an SSH server's
 * folder. It takes absolute paths and checks none itself, as sftp.ts does;
 * errors come out as SFTP's status codes, so a missing file or a refusal
 * reads the same whichever backend it came from.
 */

/** Where every local store's folder is. */
export function storageDir(): string {
  return path.join(dataDir(), "storage")
}

/** One local store's folder: <data>/storage/<server id>. */
export function localStoreDir(serverId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverId)) {
    throw new Error("a store's id is not a folder name")
  }
  return path.join(storageDir(), serverId)
}

/** Makes a local store's folder when it is not there, for PCP alone. */
export async function ensureLocalStoreDir(serverId: string): Promise<string> {
  const dir = localStoreDir(serverId)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

function statusOf(error: unknown): number {
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT":
    case "ENOTDIR":
      return SFTP_STATUS.NO_SUCH_FILE
    case "EACCES":
    case "EPERM":
      return SFTP_STATUS.PERMISSION_DENIED
    default:
      return SFTP_STATUS.FAILURE
  }
}

/** A failure as sftp.ts would have it. */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof SftpError || error instanceof FileTooLargeError) {
      throw error
    }
    throw new SftpError(
      error instanceof Error ? error.message : String(error),
      statusOf(error),
    )
  }
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
    size: stats.size,
    mtime: Math.floor(stats.mtimeMs / 1000),
    mode: stats.mode & 0o7777,
    uid: stats.uid,
    gid: stats.gid,
  }
}

/** The machine's own file system as a RemoteFs. */
export function localFs(): RemoteFs {
  const local: RemoteFs = {
    realpath: (at) => mapped(() => fs.realpath(at)),
    lstat: (at) => mapped(async () => statOf(await fs.lstat(at))),
    stat: (at) => mapped(async () => statOf(await fs.stat(at))),

    readdir: (at, max) =>
      mapped(async () => {
        const dir = await fs.opendir(at)
        const entries: Array<{ name: string; stat: RemoteStat }> = []
        let more = false

        try {
          for await (const entry of dir) {
            if (entries.length >= max) {
              more = true
              break
            }
            entries.push({
              name: entry.name,
              stat: statOf(await fs.lstat(path.join(at, entry.name))),
            })
          }
        } finally {
          await dir.close().catch(() => {})
        }

        return { entries, more }
      }),

    mkdir: (at, mode) => mapped(() => fs.mkdir(at, { mode }).then(() => {})),
    rmdir: (at) => mapped(() => fs.rmdir(at)),
    unlink: (at) => mapped(() => fs.unlink(at)),

    rename: (from, to) =>
      mapped(async () => {
        // As SFTP's: never over something that is there.
        const there = await fs.lstat(to).catch(() => null)
        if (there) {
          throw new SftpError(`${to} is there already`, SFTP_STATUS.FAILURE)
        }
        await fs.rename(from, to)
      }),

    replace: (from, to) => mapped(() => fs.rename(from, to)),
    chmod: (at, mode) => mapped(() => fs.chmod(at, mode)),

    readFile: (at, maxBytes) =>
      mapped(async () => {
        const handle = await fs.open(at, "r")
        const chunks: Buffer[] = []
        let total = 0

        try {
          for (;;) {
            const buffer = Buffer.alloc(64 * 1024)
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              total,
            )
            if (bytesRead === 0) break
            chunks.push(buffer.subarray(0, bytesRead))
            total += bytesRead
            if (total > maxBytes) throw new FileTooLargeError(total)
          }
        } finally {
          await handle.close()
        }

        return Buffer.concat(chunks)
      }),

    readStream(at, range = {}) {
      const end = range.end ?? Number.POSITIVE_INFINITY
      const start = range.start ?? 0

      if (end <= start) return Readable.from([])

      // createReadStream's end is inclusive.
      return createReadStream(at, {
        start,
        ...(Number.isFinite(end) ? { end: end - 1 } : {}),
        highWaterMark: 64 * 1024,
      })
    },

    writeNew: (at, bytes, mode) =>
      mapped(async () => {
        const handle = await fs.open(at, "wx", mode)
        try {
          await handle.writeFile(bytes)
        } finally {
          await handle.close()
        }
      }),

    writeNewFrom: (at, source, mode, maxBytes) =>
      mapped(async () => {
        const handle = await fs.open(at, "wx", mode)
        let written = 0

        try {
          for await (const chunk of source) {
            if (maxBytes !== undefined && written + chunk.length > maxBytes) {
              throw new FileTooLargeError(written + chunk.length)
            }
            await handle.write(chunk, 0, chunk.length, written)
            written += chunk.length
          }
        } finally {
          await handle.close()
        }

        return written
      }),

    end: () => {},
  }

  return local
}
