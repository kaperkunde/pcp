import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buffer } from "node:stream/consumers"

import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken, updateApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { decrypt } from "./crypto"
import { downloadByLink, linkKey, pruneFileLinks } from "./file-links"
import { buildGatewayServer, loadGatewayServers } from "./gateway"
import { readRequestLog } from "./request-log"
import { getServer } from "./servers"
import { closeAllSshConnections } from "./ssh/client"
import { startFakeSsh, type FakeSsh } from "./ssh/fake-server"
import { createSshServer } from "./ssh/hosts"
import { CHUNK_BYTES } from "./storage/crypt"
import { localStoreDir } from "./storage/local"
import { createStorageRoot, ensureOwnStore } from "./storage/roots"
import {
  linkCopiesDir,
  linkFileKeyAad,
  openStoreLink,
  parseRange,
  pruneLinkCopies,
  type StoreLinkFile,
} from "./store-links"
import { scratchDatabase } from "./test-db"
import { setServerToolAccess } from "./tool-access"
import { resultKeepers, resultOpener } from "./tool-results"
import {
  callServerTool,
  convertStore,
  syncServerTools,
  withStorageFolder,
} from "./upstream"
import { setupVault } from "./vault"
import { entryCall, listEveryTool } from "./test-handles"

// Public links to one file of a store (share_file): the link's key wraps
// that file's key, PCP's own store is read in place with it alone, any
// other store's file is copied when shared; ranges, what a link serves,
// when it ends, and what the cleanup removes.

const PUBLIC = { publicUrl: "https://pcp.example" }
const BIG = Buffer.from(
  Array.from({ length: CHUNK_BYTES * 2 + 1234 }, (_, i) => (i * 7) % 251),
)

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ id: tokenId } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    shareFiles: true,
  }))
})

afterEach(async () => {
  closeAllSshConnections()
  await cleanup()
})

async function call(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  token = tokenId,
): Promise<CallToolResult> {
  const keepers = resultKeepers(ctx, token)
  return callServerTool(ctx, await getServer(ctx, id), tool, args, {
    ...PUBLIC,
    tokenId: token,
    keep: keepers.text,
    keepBytes: keepers.bytes,
    open: resultOpener(ctx, token),
  })
}

function data(result: CallToolResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
  return result.structuredContent as Record<string, unknown>
}

function refusal(result: CallToolResult): string {
  expect(result.isError).toBe(true)
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

function secretOf(url: unknown): string {
  expect(url).toMatch(/^https:\/\/pcp\.example\/api\/files\/[\w-]{43}$/)
  return String(url).split("/").pop()!
}

async function served(
  secret: string,
  range: string | null = null,
): Promise<StoreLinkFile & { bytes: Buffer }> {
  const file = await openStoreLink(secret, range)
  expect(file?.ok, JSON.stringify(file)).toBe(true)
  const ok = file as StoreLinkFile
  return { ...ok, bytes: await buffer(ok.stream) }
}

async function saveOwn(name: string, bytes: Buffer): Promise<string> {
  const own = await ensureOwnStore(ctx)
  await withStorageFolder(ctx, own, PUBLIC, (folder) =>
    folder.save(name, bytes, { overwrite: true }),
  )
  return own
}

function filesUnder(top: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(at)
      else found.push(at)
    }
  }
  if (fs.existsSync(top)) walk(top)
  return found
}

describe("ranges", () => {
  it("reads one range of bytes, and serves the rest whole", () => {
    expect(parseRange(null, 100)).toEqual({
      offset: 0,
      length: 100,
      partial: false,
    })
    expect(parseRange("bytes=10-19", 100)).toEqual({
      offset: 10,
      length: 10,
      partial: true,
    })
    expect(parseRange("bytes=90-", 100)).toEqual({
      offset: 90,
      length: 10,
      partial: true,
    })
    expect(parseRange("bytes=95-500", 100)).toEqual({
      offset: 95,
      length: 5,
      partial: true,
    })
    expect(parseRange("bytes=-30", 100)).toEqual({
      offset: 70,
      length: 30,
      partial: true,
    })
    expect(parseRange("bytes=-300", 100)).toMatchObject({ offset: 0 })
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable")
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable")
    // Several ranges, another unit, nonsense, an empty file: whole.
    for (const header of ["bytes=0-1,5-6", "items=0-1", "bytes=9-3", "x"]) {
      expect(parseRange(header, 100)).toMatchObject({ partial: false })
    }
    expect(parseRange("bytes=0-10", 0)).toMatchObject({ partial: false })
  })
})

describe("a link to a file of PCP's own store", () => {
  it("wraps that file's key and reads it in place, whole or a range", async () => {
    const own = await saveOwn("film.bin", BIG)
    const before = filesUnder(localStoreDir(own)).length
    const shared = data(await call(own, "share_file", { path: "film.bin" }))

    expect(shared).toMatchObject({
      name: "film.bin",
      size: BIG.length,
      downloads: 5,
    })
    const secret = secretOf(shared.url)

    // No copy: the store's own object, under its own key, wrapped by the
    // link's; the database alone opens nothing.
    expect(filesUnder(localStoreDir(own))).toHaveLength(before)
    expect(filesUnder(linkCopiesDir())).toEqual([])
    const row = await db().fileLink.findFirstOrThrow({
      where: { kind: "store" },
    })
    expect(row).toMatchObject({ storeId: own, ciphertext: null })
    expect(row.secretHash).not.toContain(secret)
    const fileKey = decrypt(
      linkKey(secret, row.id),
      Buffer.from(row.fileKey!),
      linkFileKeyAad(row.id),
    )
    expect(fileKey).toHaveLength(32)
    // Another secret, one character off: never the same one, whatever the
    // last character was.
    const wrong = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`
    expect(wrong).not.toBe(secret)
    expect(() =>
      decrypt(
        linkKey(wrong, row.id),
        Buffer.from(row.fileKey!),
        linkFileKeyAad(row.id),
      ),
    ).toThrow()

    const whole = await served(secret)
    expect(whole).toMatchObject({ partial: false, offset: 0 })
    expect(whole.bytes.equals(BIG)).toBe(true)

    // A range across a chunk's end opens only what it needs.
    const part = await served(
      secret,
      `bytes=${CHUNK_BYTES - 5}-${CHUNK_BYTES + 4}`,
    )
    expect(part).toMatchObject({
      partial: true,
      offset: CHUNK_BYTES - 5,
      length: 10,
      size: BIG.length,
    })
    expect(
      part.bytes.equals(BIG.subarray(CHUNK_BYTES - 5, CHUNK_BYTES + 5)),
    ).toBe(true)

    expect(await openStoreLink(secret, `bytes=${BIG.length}-`)).toMatchObject({
      ok: false,
      status: 416,
      size: BIG.length,
    })

    // Every use in the log, by name.
    const { entries } = await readRequestLog(ctx)
    expect(
      entries
        .filter((entry) => entry.tool === "file_link/store_download")
        .map((entry) => entry.ok)
        .sort(),
    ).toEqual([false, true, true])
  })

  it("ends when the file is changed or deleted", async () => {
    const own = await saveOwn("a.txt", Buffer.from("first"))
    const secret = secretOf(
      data(await call(own, "share_file", { path: "a.txt" })).url,
    )
    expect((await served(secret)).bytes.toString()).toBe("first")

    await saveOwn("a.txt", Buffer.from("second"))
    expect(await openStoreLink(secret, null)).toMatchObject({
      ok: false,
      status: 410,
    })

    const again = secretOf(
      data(await call(own, "share_file", { path: "a.txt" })).url,
    )
    expect((await served(again)).bytes.toString()).toBe("second")
    await call(own, "delete", { path: "a.txt" })
    expect(await openStoreLink(again, null)).toMatchObject({ status: 410 })
  })

  it("serves as many whole files as it was made for, ranges counted", async () => {
    const own = await saveOwn("ten.txt", Buffer.from("0123456789"))
    const secret = secretOf(
      data(await call(own, "share_file", { path: "ten.txt", max_downloads: 2 }))
        .url,
    )

    await served(secret)
    await served(secret, "bytes=0-4")
    await served(secret, "bytes=5-9")
    // Two whole files' worth served: not one byte more.
    expect(await openStoreLink(secret, "bytes=0-0")).toMatchObject({
      ok: false,
      status: 410,
    })
  })

  it("stops at its time, with its token, and for a wrong secret", async () => {
    const own = await saveOwn("a.txt", Buffer.from("hello"))
    const shared = data(
      await call(own, "share_file", {
        path: "a.txt",
        expires_in_minutes: 10,
      }),
    )
    const secret = secretOf(shared.url)
    const expires = new Date(String(shared.expiresAt))

    expect(expires.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000)
    expect(
      await openStoreLink(secret, null, new Date(expires.getTime() + 1)),
    ).toMatchObject({ ok: false, status: 404 })

    // Not a link's secret, or no link's: not a store link at all, and the
    // file link route then answers that it is gone.
    expect(await openStoreLink("nope", null)).toBeNull()
    const wrong = `${secret.slice(0, -2)}${secret.endsWith("AA") ? "BB" : "AA"}`
    expect(await openStoreLink(wrong, null)).toBeNull()
    expect(await downloadByLink(wrong)).toMatchObject({ status: 404 })

    await updateApiToken(ctx, tokenId, {
      name: "Claude",
      allowAllServers: true,
      shareFiles: false,
    })
    expect(await openStoreLink(secret, null)).toMatchObject({ status: 404 })
  })

  it("is refused to a token that does not move files by link, and past bounds", async () => {
    const own = await saveOwn("a.txt", Buffer.from("hello"))
    const { id: plain } = await createApiToken(ctx, {
      name: "Plain",
      allowAllServers: true,
    })

    expect(
      refusal(await call(own, "share_file", { path: "a.txt" }, plain)),
    ).toMatch(/does not share files by link/)
    expect(
      refusal(
        await call(own, "share_file", {
          path: "a.txt",
          expires_in_minutes: 7 * 24 * 60 + 1,
        }),
      ),
    ).toMatch(/expires_in_minutes/)
    expect(
      refusal(await call(own, "share_file", { path: "../a.txt" })),
    ).toMatch(/\.\./)
    expect(await db().fileLink.count()).toBe(0)
  })
})

describe("a link to a file kept elsewhere", () => {
  it("copies a plain store's file when shared, sealed under its own key", async () => {
    const own = await saveOwn("a.txt", Buffer.from("original"))
    for (let step = 0; step < 10; step++) {
      if ((await convertStore(ctx, own, "plain", PUBLIC)).done) break
    }
    expect(
      fs.readFileSync(path.join(localStoreDir(own), "a.txt"), "utf8"),
    ).toBe("original")

    const shared = data(await call(own, "share_file", { path: "a.txt" }))
    const secret = secretOf(shared.url)
    const copies = filesUnder(linkCopiesDir())

    expect(copies).toHaveLength(1)
    expect(fs.readFileSync(copies[0]!).includes("original")).toBe(false)
    expect(
      await db().fileLink.findFirstOrThrow({ where: { kind: "store" } }),
    ).toMatchObject({ storeId: null })

    // Later changes do not reach the copy.
    fs.writeFileSync(path.join(localStoreDir(own), "a.txt"), "changed")
    expect((await served(secret)).bytes.toString()).toBe("original")
    expect((await served(secret, "bytes=-4")).bytes.toString()).toBe("inal")

    // Its link gone, the cleanup removes the copy, not before.
    expect((await pruneLinkCopies()).removed).toBe(0)
    const later = new Date(Date.now() + 8 * 24 * 60 * 60_000)
    await pruneFileLinks(later)
    expect(await pruneLinkCopies(later)).toMatchObject({ removed: 1 })
    expect(filesUnder(linkCopiesDir())).toEqual([])
  })

  describe("on an SSH server", () => {
    let base: string
    let top: string
    let fake: FakeSsh
    let authorized: string | null

    beforeEach(async () => {
      base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pcp-ln-")))
      top = path.join(base, "share")
      fs.mkdirSync(top)
      fs.writeFileSync(path.join(top, "film.bin"), BIG)
      authorized = null
      fake = await startFakeSsh({
        authorizedKey: () => authorized,
        run: () => ({}),
        sftp: true,
      })
    })

    afterEach(async () => {
      await fake.close()
      fs.rmSync(base, { recursive: true, force: true })
    })

    it("copies the file, so the link reads it without PCP's key", async () => {
      const { id: hostId } = await createSshServer(ctx, {
        name: "Files box",
        host: "127.0.0.1",
        port: fake.port,
        username: "deploy",
      })
      authorized = (await getServer(ctx, hostId)).sshPublicKey
      await syncServerTools(ctx, await getServer(ctx, hostId), {
        ...PUBLIC,
        byOwner: true,
      })
      const { id } = await createStorageRoot(ctx, hostId, {
        name: "Scans",
        path: top,
        readOnly: true,
        // A share other apps read, its files as they are.
        mode: "plain",
      })

      // A read-only folder shares too: sharing changes nothing there.
      const shared = data(await call(id, "share_file", { path: "film.bin" }))
      const secret = secretOf(shared.url)
      expect(filesUnder(linkCopiesDir())).toHaveLength(1)

      // The SSH server is gone: the copy still serves.
      await fake.close()
      closeAllSshConnections()
      const range = await served(secret, "bytes=100000-100099")
      expect(range.bytes.equals(BIG.subarray(100_000, 100_100))).toBe(true)
      // For afterEach to close.
      fake = await startFakeSsh({
        authorizedKey: () => null,
        run: () => ({}),
        sftp: true,
      })
    })
  })
})

describe("share_file at /mcp", () => {
  async function connect(shareFiles: boolean, existing?: string) {
    const { token, id } = existing
      ? { token: existing, id: "" }
      : await createApiToken(ctx, {
          name: shareFiles ? "Mover" : "Keeper",
          allowAllServers: true,
          shareFiles,
        })
    const scope = { ...(await resolveApiToken(token))!, ...PUBLIC }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
      serverSide,
    )
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
    return { client, id, token }
  }

  it("is offered only to a token that moves files by link, at the store's levels", async () => {
    const own = await saveOwn("a.txt", Buffer.from("hello"))
    const keeper = await connect(false)
    expect(
      (await listEveryTool(keeper.client)).tools.map((tool) => tool.name),
    ).not.toContain("share_file")
    await keeper.client.close()

    const mover = await connect(true)
    const asked = await mover.client.callTool(
      entryCall("share_file", { path: "a.txt" }),
    )
    expect(JSON.stringify(asked.content)).toMatch(/Not done yet/)
    expect(await db().fileLink.count()).toBe(0)

    await setServerToolAccess(ctx, mover.id, own, "allowed")
    await mover.client.close()
    const allowed = await connect(true, mover.token)
    const shared = await allowed.client.callTool(
      entryCall("share_file", { path: "a.txt", max_downloads: 1 }),
    )
    const link = JSON.parse(
      (shared.content as Array<{ text: string }>)[0]!.text,
    ) as Record<string, unknown>
    expect(link).toMatchObject({ name: "a.txt", downloads: 1 })
    expect((await served(secretOf(link.url))).bytes.toString()).toBe("hello")
    await allowed.client.close()
  })
})
