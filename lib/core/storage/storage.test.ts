import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { getServer } from "../servers"
import { closeAllSshConnections } from "../ssh/client"
import { startFakeSsh, type FakeSsh } from "../ssh/fake-server"
import { createSshServer } from "../ssh/hosts"
import { scratchDatabase } from "../test-db"
import {
  keepBytes,
  openResult,
  resultKeepers,
  resultOpener,
} from "../tool-results"
import {
  callServerTool,
  openStorageDownload,
  syncServerTools,
  withStorageFolder,
} from "../upstream"
import { setupVault } from "../vault"
import { createStorageRoot, updateStorageRoot } from "./roots"

// Storage roots end to end in the core: an SSH server the owner added and
// checked, a folder on it (a temporary directory, served by the test
// server's SFTP), and its tools called through upstream.ts like any
// server's, with kept results going in and out.

const PUBLIC = { publicUrl: "http://localhost:3000" }
const OWNER = { ...PUBLIC, byOwner: true }

let cleanup: () => Promise<void>
let ctx: VaultContext
let fake: FakeSsh
let authorized: string | null
let base: string
let top: string
let outside: string
let tokenId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pcp-store-")))
  top = path.join(base, "share")
  outside = path.join(base, "private")
  fs.mkdirSync(top)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, "secret.txt"), "not yours")
  authorized = null
  fake = await startFakeSsh({
    authorizedKey: () => authorized,
    run: () => ({}),
    sftp: true,
  })
  ;({ id: tokenId } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
  }))
})

afterEach(async () => {
  closeAllSshConnections()
  await fake.close()
  await cleanup()
  fs.rmSync(base, { recursive: true, force: true })
})

/** An SSH server the owner added, put PCP's key on and checked. */
async function pinnedHost({ check = true } = {}) {
  const { id } = await createSshServer(ctx, {
    name: "Files box",
    host: "127.0.0.1",
    port: fake.port,
    username: "deploy",
  })
  authorized = (await getServer(ctx, id)).sshPublicKey
  if (check) await syncServerTools(ctx, await getServer(ctx, id), OWNER)
  return id
}

async function addRoot({
  readOnly = false,
  umask = "002",
  check = true,
}: { readOnly?: boolean; umask?: string; check?: boolean } = {}) {
  const hostId = await pinnedHost({ check })
  const { id } = await createStorageRoot(ctx, hostId, {
    name: "Scans",
    path: top,
    writeAs: "badpirate",
    umask,
    readOnly,
  })
  return id
}

async function call(
  id: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return callServerTool(ctx, await getServer(ctx, id), tool, args, {
    ...PUBLIC,
    tokenId,
    ...{
      keep: resultKeepers(ctx, tokenId).text,
      keepBytes: resultKeepers(ctx, tokenId).bytes,
    },
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

async function toolNames(id: string) {
  return (
    await db().mcpTool.findMany({
      where: { serverId: id },
      orderBy: { name: "asc" },
    })
  ).map((tool) => tool.name)
}

describe("adding a storage folder", () => {
  it("offers the file tools, and a read-only folder only the reading ones", async () => {
    const id = await addRoot()
    expect(await toolNames(id)).toEqual([
      "delete",
      "find_files",
      "get_file",
      "list_folder",
      "make_folder",
      "move",
      "save_file",
      "share_file",
    ])

    const sync = await syncServerTools(ctx, await getServer(ctx, id), OWNER)
    expect(sync).toEqual({ status: "ok", message: "", toolCount: 8 })
    // The check wrote and removed a part file, and left nothing.
    expect(fs.readdirSync(top)).toEqual([])

    await updateStorageRoot(ctx, id, {
      name: "Scans",
      path: top,
      umask: "002",
      readOnly: true,
    })
    expect(await toolNames(id)).toEqual([
      "find_files",
      "get_file",
      "list_folder",
      "share_file",
    ])
    expect(
      refusal(await call(id, "save_file", { path: "a.txt", text: "x" })),
    ).toMatch(/read-only in PCP/)
    expect(fs.readdirSync(top)).toEqual([])
  })

  it("refuses a folder on anything but an SSH server, and a relative path", async () => {
    const hostId = await pinnedHost()
    await expect(
      createStorageRoot(ctx, hostId, {
        name: "x",
        path: "srv/files",
        readOnly: false,
      }),
    ).rejects.toThrow(/starting with \//)
    await expect(
      createStorageRoot(ctx, hostId, {
        name: "x",
        path: "/srv",
        umask: "9",
        readOnly: false,
      }),
    ).rejects.toThrow(/umask/)
  })

  it("does not connect to an SSH server whose host key the owner has not pinned", async () => {
    const id = await addRoot({ check: false })
    const answer = refusal(await call(id, "list_folder", {}))
    expect(answer).toMatch(/not pinned/)
    expect(fake.sftpRequests).toEqual([])
  })
})

describe("staying inside the folder", () => {
  it("refuses .. before anything connects", async () => {
    const id = await addRoot()
    const answer = refusal(
      await call(id, "get_file", { path: "../private/secret.txt" }),
    )
    expect(answer).toMatch(/leave out \.\./)
    expect(fake.sftpRequests).toEqual([])
  })

  it("does not follow a link that leads out, to list, read or write", async () => {
    const id = await addRoot()
    fs.symlinkSync(outside, path.join(top, "escape"))
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(top, "secret.txt"),
    )

    const listed = data(await call(id, "list_folder", {}))
    expect(listed.entries).toEqual([
      expect.objectContaining({
        name: "escape",
        type: "link",
        points: "outside",
      }),
      expect.objectContaining({
        name: "secret.txt",
        type: "link",
        points: "outside",
      }),
    ])

    expect(refusal(await call(id, "list_folder", { path: "escape" }))).toMatch(
      /leads out of the folder/,
    )
    expect(refusal(await call(id, "get_file", { path: "secret.txt" }))).toMatch(
      /leads out of the folder/,
    )
    expect(
      refusal(await call(id, "get_file", { path: "escape/secret.txt" })),
    ).toMatch(/leads out of the folder/)
    expect(
      refusal(
        await call(id, "save_file", { path: "escape/new.txt", text: "x" }),
      ),
    ).toMatch(/leads out of the folder/)
    expect(fs.readdirSync(outside)).toEqual(["secret.txt"])

    // Deleting the link deletes the link, never what it points to.
    data(await call(id, "delete", { path: "escape" }))
    expect(fs.existsSync(path.join(top, "escape"))).toBe(false)
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe(
      "not yours",
    )
  })

  it("follows a link that stays inside", async () => {
    const id = await addRoot()
    fs.mkdirSync(path.join(top, "real"))
    fs.writeFileSync(path.join(top, "real", "a.txt"), "inside")
    fs.symlinkSync(path.join(top, "real"), path.join(top, "alias"))

    const got = data(await call(id, "get_file", { path: "alias/a.txt" }))
    expect(got).toMatchObject({ name: "a.txt", text: "inside" })
  })
})

describe("saving files", () => {
  it("writes whole or not at all, with the folder's umask, and never over a file unless asked", async () => {
    const id = await addRoot({ umask: "027" })
    const saved = data(
      await call(id, "save_file", { path: "notes.txt", text: "first" }),
    )
    expect(saved).toMatchObject({
      path: "notes.txt",
      saved: "created",
      size: 5,
    })
    expect(fs.readFileSync(path.join(top, "notes.txt"), "utf8")).toBe("first")
    expect(fs.statSync(path.join(top, "notes.txt")).mode & 0o777).toBe(0o640)
    // Written under a part name, then renamed into place.
    expect(
      fake.sftpRequests.some((line) =>
        /^OPEN .*notes\.txt\.[0-9a-f]{8}\.pcp-part$/.test(line),
      ),
    ).toBe(true)

    expect(
      refusal(
        await call(id, "save_file", { path: "notes.txt", text: "second" }),
      ),
    ).toMatch(/there already.*overwrite: true/)
    expect(fs.readFileSync(path.join(top, "notes.txt"), "utf8")).toBe("first")

    const replaced = data(
      await call(id, "save_file", {
        path: "notes.txt",
        text: "second",
        overwrite: true,
      }),
    )
    expect(replaced).toMatchObject({ saved: "replaced" })
    expect(fs.readFileSync(path.join(top, "notes.txt"), "utf8")).toBe("second")
    expect(fs.readdirSync(top)).toEqual(["notes.txt"])
  })

  it("refuses a part name and a folder that is not there", async () => {
    const id = await addRoot()
    expect(
      refusal(await call(id, "save_file", { path: "x.pcp-part", text: "x" })),
    ).toMatch(/PCP's own/)
    expect(
      refusal(
        await call(id, "save_file", { path: "no/such/x.txt", text: "x" }),
      ),
    ).toMatch(/nothing there/)
  })

  it("moves a file between tools as a handle, never through the answer", async () => {
    const id = await addRoot()
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from([0, 1, 2, 255, 254]),
    ])
    fs.mkdirSync(path.join(top, "in"))
    fs.writeFileSync(path.join(top, "in", "scan.pdf"), pdf)

    const got = data(await call(id, "get_file", { path: "in/scan.pdf" }))
    expect(got).toMatchObject({
      name: "scan.pdf",
      size: pdf.length,
      type: "application/pdf",
    })
    expect(JSON.stringify(got)).not.toContain("%PDF")
    const handle = got.result as { $result: string }
    const opened = await openResult(ctx, { tokenId, id: handle.$result })
    expect(opened?.bytes().equals(pdf)).toBe(true)

    data(await call(id, "make_folder", { path: "out/2026", parents: true }))
    data(
      await call(id, "save_file", {
        path: "out/2026/scan.pdf",
        file: { $result: handle.$result },
      }),
    )
    expect(
      fs.readFileSync(path.join(top, "out", "2026", "scan.pdf")).equals(pdf),
    ).toBe(true)
  })

  it("refuses a handle the token does not have before anything connects", async () => {
    const id = await addRoot()
    const { id: otherToken } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
      serverIds: [],
    })
    const theirs = await keepBytes(ctx, {
      tokenId: otherToken,
      serverId: null,
      toolName: "get_file",
      bytes: Buffer.from("theirs"),
      mediaType: "text/plain",
      name: "theirs.txt",
    })
    const before = fake.sftpRequests.length

    const answer = refusal(
      await call(id, "save_file", {
        path: "theirs.txt",
        file: { $result: theirs.id },
      }),
    )
    expect(answer).toMatch(/not there for this token/)
    expect(fake.sftpRequests.length).toBe(before)
    expect(fs.existsSync(path.join(top, "theirs.txt"))).toBe(false)
  })
})

describe("folders, moving and deleting", () => {
  it("finds, moves and deletes inside the folder", async () => {
    const id = await addRoot()
    fs.mkdirSync(path.join(top, "a", "b"), { recursive: true })
    fs.writeFileSync(path.join(top, "a", "one.pdf"), "1")
    fs.writeFileSync(path.join(top, "a", "b", "two.PDF"), "2")
    fs.writeFileSync(path.join(top, "a", "b", "three.txt"), "3")

    const found = data(await call(id, "find_files", { name: "*.pdf" }))
    expect(
      (found.matches as Array<{ path: string }>).map((match) => match.path),
    ).toEqual(["a/b/two.PDF", "a/one.pdf"])

    expect(refusal(await call(id, "move", { from: "a", to: "a/b/a" }))).toMatch(
      /into itself/,
    )
    expect(
      refusal(
        await call(id, "move", { from: "a/one.pdf", to: "a/b/three.txt" }),
      ),
    ).toMatch(/overwrite: true/)
    data(await call(id, "move", { from: "a/one.pdf", to: "a/b/one.pdf" }))
    expect(fs.existsSync(path.join(top, "a", "b", "one.pdf"))).toBe(true)

    expect(refusal(await call(id, "delete", { path: "a" }))).toMatch(
      /not empty.*recursive: true/,
    )
    expect(refusal(await call(id, "delete", { path: "" }))).toMatch(
      /folder itself/,
    )
    const removed = data(
      await call(id, "delete", { path: "a", recursive: true }),
    )
    expect(removed).toMatchObject({ path: "a", type: "folder", removed: 5 })
    expect(fs.readdirSync(top)).toEqual([])
  })
})

describe("the owner's file browser", () => {
  it("lists the folder and streams a file down", async () => {
    const id = await addRoot()
    fs.writeFileSync(path.join(top, "hello.txt"), "hello there")

    const listing = await withStorageFolder(ctx, id, PUBLIC, (folder) =>
      folder.list(""),
    )
    expect(listing.entries.map((entry) => entry.name)).toEqual(["hello.txt"])

    const download = await openStorageDownload(ctx, id, "hello.txt", PUBLIC)
    const chunks: Buffer[] = []
    for await (const chunk of download.stream) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toBe("hello there")
    expect(download).toMatchObject({ name: "hello.txt", size: 11 })

    await expect(
      openStorageDownload(ctx, id, "../private/secret.txt", PUBLIC),
    ).rejects.toThrow(/leave out \.\./)
  })
})
