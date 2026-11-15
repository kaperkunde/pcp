import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buffer } from "node:stream/consumers"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { deleteServer, getServer } from "../servers"
import { closeAllSshConnections } from "../ssh/client"
import { startFakeSsh, type FakeSsh } from "../ssh/fake-server"
import { createSshServer } from "../ssh/hosts"
import { scratchDatabase } from "../test-db"
import { resultKeepers, resultOpener } from "../tool-results"
import {
  callServerTool,
  convertStore,
  openStorageDownload,
  syncServerTools,
} from "../upstream"
import { setupVault } from "../vault"
import { CHUNK_BYTES } from "./crypt"
import { openEncryptedFolder, openSealedObject } from "./encrypted"
import { OBJECTS_FOLDER } from "./limits"
import { localFs, localStoreDir } from "./local"
import { storeRoom, storeUsage } from "./quota"
import {
  createStorageRoot,
  ensureOwnStore,
  findOwnStore,
  listStores,
  loadStorageRoot,
  storeKeyOf,
  updateStorageRoot,
} from "./roots"

// Stores: PCP's own, encrypted in its data folder, and a folder on an SSH
// server encrypted and made plain again by the owner, with the tools
// called through upstream.ts as any server's.

const PUBLIC = { publicUrl: "http://localhost:3000" }

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
    serverIds: [],
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
): Promise<CallToolResult> {
  const keepers = resultKeepers(ctx, tokenId)
  return callServerTool(ctx, await getServer(ctx, id), tool, args, {
    ...PUBLIC,
    tokenId,
    keep: keepers.text,
    keepBytes: keepers.bytes,
    open: resultOpener(ctx, tokenId),
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

/** Every file under a folder, relative, with its bytes. */
function filesUnder(top: string): Map<string, Buffer> {
  const found = new Map<string, Buffer>()
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(at)
      else if (entry.isFile())
        found.set(path.relative(top, at), fs.readFileSync(at))
    }
  }
  walk(top)
  return found
}

describe("PCP's own store", () => {
  it("is made once, encrypted in the data folder, with the file tools", async () => {
    expect(await findOwnStore(ctx)).toBeNull()
    const [a, b] = await Promise.all([ensureOwnStore(ctx), ensureOwnStore(ctx)])
    expect(a).toBe(b)
    expect(await ensureOwnStore(ctx)).toBe(a)

    const loaded = await loadStorageRoot(ctx, a)
    expect(loaded.server).toMatchObject({ kind: "storage", slug: "pcp-files" })
    expect(loaded.root).toMatchObject({ backend: "local", mode: "encrypted" })
    expect(loaded.host).toBeNull()
    expect(
      (await db().mcpTool.findMany({ where: { serverId: a } })).length,
    ).toBe(8)
    expect(await listStores(ctx)).toEqual([
      expect.objectContaining({ id: a, backend: "local", mode: "encrypted" }),
    ])

    const sync = await syncServerTools(ctx, await getServer(ctx, a), {
      ...PUBLIC,
      byOwner: true,
    })
    expect(sync.status).toBe("ok")
  })

  it("stays: the owner cannot remove it or point it elsewhere", async () => {
    const id = await ensureOwnStore(ctx)
    await expect(deleteServer(ctx, id)).rejects.toThrow(/own store stays/)
    await expect(
      updateStorageRoot(ctx, id, {
        name: "x",
        path: "/srv",
        readOnly: false,
      }),
    ).rejects.toThrow(/data folder/)
  })

  it("keeps names and content out of the data folder, and reads them back", async () => {
    const id = await ensureOwnStore(ctx)
    const dir = localStoreDir(id)

    data(await call(id, "make_folder", { path: "taxes/2026", parents: true }))
    const saved = data(
      await call(id, "save_file", {
        path: "taxes/2026/invoice-secret.txt",
        text: "the confidential invoice",
      }),
    )
    expect(saved).toMatchObject({ saved: "created", size: 24 })

    const listed = data(await call(id, "list_folder", { path: "taxes/2026" }))
    expect(listed.entries).toEqual([
      expect.objectContaining({
        name: "invoice-secret.txt",
        path: "taxes/2026/invoice-secret.txt",
        type: "file",
        size: 24,
      }),
    ])

    // On disk: one object of opaque bytes, named by a random id.
    const files = filesUnder(dir)
    expect(files.size).toBe(1)
    const [name, bytes] = [...files][0]!
    expect(name).toMatch(
      new RegExp(`^\\${OBJECTS_FOLDER}/[0-9a-f]{2}/[0-9a-f]{32}$`),
    )
    expect(bytes.toString("latin1")).not.toContain("confidential")
    expect(name).not.toContain("invoice")
    expect(fs.readdirSync(dir)).toEqual([OBJECTS_FOLDER])

    const got = data(
      await call(id, "get_file", { path: "taxes/2026/invoice-secret.txt" }),
    )
    expect(got).toMatchObject({
      name: "invoice-secret.txt",
      size: 24,
      text: "the confidential invoice",
    })

    const found = data(await call(id, "find_files", { name: "*.TXT" }))
    expect(found.matches).toEqual([
      expect.objectContaining({ path: "taxes/2026/invoice-secret.txt" }),
    ])
  })

  it("replaces only with overwrite, moves, and deletes what it held", async () => {
    const id = await ensureOwnStore(ctx)
    const dir = localStoreDir(id)

    data(await call(id, "save_file", { path: "a.txt", text: "one" }))
    expect(
      refusal(await call(id, "save_file", { path: "a.txt", text: "two" })),
    ).toMatch(/there already/)
    data(
      await call(id, "save_file", {
        path: "a.txt",
        text: "two!",
        overwrite: true,
      }),
    )
    // The first object went with its entry.
    expect(filesUnder(dir).size).toBe(1)
    expect(await db().storagePending.count()).toBe(0)

    data(await call(id, "make_folder", { path: "box" }))
    data(await call(id, "move", { from: "a.txt", to: "box/b.txt" }))
    expect(
      refusal(await call(id, "move", { from: "box", to: "box/inner" })),
    ).toMatch(/into itself/)
    expect(
      data(await call(id, "get_file", { path: "box/b.txt" })),
    ).toMatchObject({ text: "two!" })
    expect(refusal(await call(id, "get_file", { path: "a.txt" }))).toMatch(
      /not there/,
    )

    expect(refusal(await call(id, "delete", { path: "box" }))).toMatch(
      /not empty/,
    )
    expect(
      data(await call(id, "delete", { path: "box", recursive: true })),
    ).toMatchObject({ type: "folder", removed: 2 })
    expect(filesUnder(dir).size).toBe(0)
    expect(await db().storageEntry.count()).toBe(0)
  })

  it("refuses a stored file that was changed on disk", async () => {
    const id = await ensureOwnStore(ctx)
    data(await call(id, "save_file", { path: "a.txt", text: "hello there" }))
    const [name] = [...filesUnder(localStoreDir(id)).keys()]
    const at = path.join(localStoreDir(id), name!)
    const bytes = fs.readFileSync(at)
    bytes[bytes.length - 3]! ^= 1
    fs.writeFileSync(at, bytes)

    expect(refusal(await call(id, "get_file", { path: "a.txt" }))).toMatch(
      /did not decrypt.*changed outside PCP/,
    )
    // The store stays as it was: only the file is refused.
    expect((await getServer(ctx, id)).status).toBe("ok")
  })

  it("streams a range for a download, decrypting only its chunks", async () => {
    const id = await ensureOwnStore(ctx)
    const content = Buffer.alloc(3 * CHUNK_BYTES + 11)
    for (let i = 0; i < content.length; i++) content[i] = i % 251
    const loaded = await loadStorageRoot(ctx, id)
    const folder = await openEncryptedFolder(
      ctx,
      {
        serverId: id,
        storeKey: storeKeyOf(ctx, loaded),
        rootReal: localStoreDir(id),
        umask: 0o077,
      },
      localFs(),
    )
    fs.mkdirSync(localStoreDir(id), { recursive: true })
    await folder.saveFrom("big.bin", [content], { overwrite: false })

    // With the file's own key alone, as a public link would read it.
    const sealed = await folder.sealed!("big.bin")
    expect(sealed).toMatchObject({ name: "big.bin", size: content.length })
    const head = openSealedObject(
      localFs(),
      sealed.rootReal,
      sealed.objectId,
      sealed.fileKey,
      sealed.size,
      { offset: 10, length: 20 },
    )
    expect((await buffer(head)).equals(content.subarray(10, 30))).toBe(true)

    const whole = await openStorageDownload(ctx, id, "big.bin", PUBLIC)
    expect(whole.size).toBe(content.length)
    expect((await buffer(whole.stream)).equals(content)).toBe(true)

    const part = await openStorageDownload(ctx, id, "big.bin", PUBLIC, {
      offset: CHUNK_BYTES + 5,
      length: 100,
    })
    expect(part).toMatchObject({ offset: CHUNK_BYTES + 5, length: 100 })
    expect(
      (await buffer(part.stream)).equals(
        content.subarray(CHUNK_BYTES + 5, CHUNK_BYTES + 105),
      ),
    ).toBe(true)
  })

  it("counts what it holds against its quota, and refuses past its room", async () => {
    const id = await ensureOwnStore(ctx)
    const loaded = await loadStorageRoot(ctx, id)
    const before = await storeRoom(loaded)
    data(await call(id, "save_file", { path: "a.txt", text: "x".repeat(1000) }))
    expect(await storeUsage(loaded)).toBe(1000 + 8 + 16)
    expect(await storeRoom(loaded)).toBe(before! - 1024)

    fs.mkdirSync(localStoreDir(id), { recursive: true })
    const tight = await openEncryptedFolder(
      ctx,
      {
        serverId: id,
        storeKey: storeKeyOf(ctx, loaded),
        rootReal: localStoreDir(id),
        umask: 0o077,
        room: async () => 100,
      },
      localFs(),
    )
    await expect(
      tight.save("b.txt", Buffer.alloc(500), { overwrite: false }),
    ).rejects.toThrow(/no room/)
    // Nothing of it stayed: one object, the first file's.
    expect(filesUnder(localStoreDir(id)).size).toBe(1)
    expect(await db().storagePending.count()).toBe(0)
  })

  it("sweeps an object a write left behind, once it is old", async () => {
    const id = await ensureOwnStore(ctx)
    const object = "ab".repeat(16)
    const at = path.join(localStoreDir(id), OBJECTS_FOLDER, "ab")
    fs.mkdirSync(at, { recursive: true })
    fs.writeFileSync(path.join(at, object), "orphan")
    fs.writeFileSync(path.join(at, `${object}.1234.pcp-part`), "half")
    await db().storagePending.create({
      data: { objectId: object, serverId: id, createdAt: new Date(0) },
    })

    data(await call(id, "list_folder", {}))
    expect(fs.readdirSync(at)).toEqual([])
    expect(await db().storagePending.count()).toBe(0)
  })
})

describe("converting a folder on an SSH server", () => {
  let fake: FakeSsh
  let authorized: string | null
  let base: string
  let top: string

  beforeEach(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pcp-conv-")))
    top = path.join(base, "share")
    fs.mkdirSync(path.join(top, "scans", "2026"), { recursive: true })
    fs.mkdirSync(path.join(top, "empty"))
    fs.writeFileSync(path.join(top, "readme.txt"), "hello")
    fs.writeFileSync(path.join(top, "scans", "a.pdf"), Buffer.alloc(70_000, 7))
    fs.writeFileSync(path.join(top, "scans", "2026", "b.txt"), "bee")
    fs.symlinkSync("/etc/hostname", path.join(top, "link"))
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

  async function addFolder() {
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
      readOnly: false,
      // A folder from before, with its files as they are.
      mode: "plain",
    })
    return id
  }

  it("encrypts in batches, refusing tools meanwhile, and makes it plain again", async () => {
    const id = await addFolder()
    const original = filesUnder(top)

    // A first batch of one file: the store is half done and waits.
    const first = await convertStore(ctx, id, "encrypted", PUBLIC, {
      maxFiles: 1,
    })
    expect(first.done).toBe(false)
    expect(first.files).toBe(1)
    expect(refusal(await call(id, "list_folder", {}))).toMatch(
      /being encrypted/,
    )

    let step = first
    for (let round = 0; round < 10 && !step.done; round++) {
      step = await convertStore(ctx, id, "encrypted", PUBLIC, { maxFiles: 1 })
    }
    expect(step.done).toBe(true)
    expect(step.message).toMatch(/link/)
    expect((await loadStorageRoot(ctx, id)).root).toMatchObject({
      mode: "encrypted",
      converting: "",
    })

    // Only the objects and the link are left on the server.
    expect(fs.readdirSync(top).sort()).toEqual([OBJECTS_FOLDER, "link"])
    for (const bytes of filesUnder(top).values()) {
      expect(bytes.toString("latin1")).not.toContain("hello")
    }

    // The same tree through the tools.
    const listed = data(await call(id, "list_folder", {}))
    expect(
      (listed.entries as Array<{ name: string }>).map((entry) => entry.name),
    ).toEqual(["empty", "scans", "readme.txt"])
    expect(
      data(await call(id, "get_file", { path: "scans/2026/b.txt" })),
    ).toMatchObject({ text: "bee" })

    // And back: the same files, the objects gone.
    let back = await convertStore(ctx, id, "plain", PUBLIC, { maxFiles: 2 })
    for (let round = 0; round < 10 && !back.done; round++) {
      back = await convertStore(ctx, id, "plain", PUBLIC, { maxFiles: 2 })
    }
    expect(back.done).toBe(true)
    expect((await loadStorageRoot(ctx, id)).root).toMatchObject({
      mode: "plain",
      converting: "",
      storeKey: null,
    })
    expect(fs.existsSync(path.join(top, OBJECTS_FOLDER))).toBe(false)
    expect(fs.existsSync(path.join(top, "empty"))).toBe(true)
    const after = filesUnder(top)
    expect([...after.keys()].sort()).toEqual([...original.keys()].sort())
    for (const [name, bytes] of original) {
      expect(after.get(name)!.equals(bytes), name).toBe(true)
    }
    expect(await db().storageEntry.count()).toBe(0)
  })

  it("keeps an encrypted store with files from being removed, and lets a plain one go", async () => {
    const id = await addFolder()
    expect((await convertStore(ctx, id, "encrypted", PUBLIC)).done).toBe(true)
    await expect(deleteServer(ctx, id)).rejects.toThrow(/make it plain first/)

    expect((await convertStore(ctx, id, "plain", PUBLIC)).done).toBe(true)
    await deleteServer(ctx, id)
    expect(fs.readFileSync(path.join(top, "readme.txt"), "utf8")).toBe("hello")
  })

  it("picks up a file a batch put in the index but did not remove", async () => {
    const id = await addFolder()
    let step = await convertStore(ctx, id, "encrypted", PUBLIC)
    expect(step.done).toBe(true)

    // As if the last batch stopped before the plain file went.
    await db().storageRoot.update({
      where: { serverId: id },
      data: { mode: "plain", converting: "encrypted" },
    })
    fs.writeFileSync(path.join(top, "readme.txt"), "hello")
    step = await convertStore(ctx, id, "encrypted", PUBLIC)
    expect(step.done).toBe(true)
    expect(fs.existsSync(path.join(top, "readme.txt"))).toBe(false)
    expect(
      data(await call(id, "get_file", { path: "readme.txt" })),
    ).toMatchObject({ text: "hello" })
  })
})
