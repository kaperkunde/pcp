import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { receiveFile, uploadByLink } from "./file-links"
import { buildGatewayServer, loadGatewayServers } from "./gateway"
import { getServer } from "./servers"
import { ensureOwnStore } from "./storage/roots"
import { nameTry, savedPlaces } from "./store-uploads"
import { scratchDatabase } from "./test-db"
import { setServerToolAccess, setToolAccess } from "./tool-access"
import { openResult } from "./tool-results"
import { deliverUploads, withStorageFolder } from "./upstream"
import { createUploadLink, uploadPageView, uploadToPage } from "./upload-links"
import { setupVault } from "./vault"

// Uploads into a store: what an upload link made with a destination takes
// is a handle as always, and is saved in that store's folder by the next
// request that holds the vault's key, never over a file already there.

const PUBLIC = { publicUrl: "https://pcp.example" }
const PDF = Buffer.from("%PDF-1.4\n% receipt\n")

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string
let own: string

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
  own = await ensureOwnStore(ctx)
})

afterEach(async () => {
  await cleanup()
})

async function* body(...parts: Buffer[]): AsyncIterable<Uint8Array> {
  yield* parts
}

function secretOf(url: string): string {
  return url.split("/").pop()!
}

async function readOwn(path: string): Promise<string> {
  return withStorageFolder(ctx, own, PUBLIC, async (folder) =>
    (await folder.read(path, 1_000_000)).bytes.toString(),
  )
}

describe("an upload page with a store", () => {
  it("says where the files go, and saves each there besides its handle", async () => {
    const link = await createUploadLink(ctx, {
      tokenId,
      ...PUBLIC,
      purpose: "the receipts",
      destination: {
        storeId: own,
        storeName: "PCP files",
        folder: "inbox/2026",
      },
    })
    const secret = secretOf(link.url)

    expect(await uploadPageView(secret)).toMatchObject({
      state: "open",
      destination: { store: "PCP files", folder: "inbox/2026" },
    })
    // The page's row shows neither where nor what without the link.
    const page = await db().uploadLink.findUniqueOrThrow({
      where: { id: link.id },
    })
    expect(Buffer.from(page.destination!).toString()).not.toContain("inbox")

    const sent = { contentType: "application/pdf", contentLength: null }
    // A second apart: saved in the order they came.
    const first = await uploadToPage(
      secret,
      body(PDF),
      { ...sent, name: "receipt.pdf" },
      new Date(Date.now() - 1000),
    )
    const second = await uploadToPage(secret, body(Buffer.from("%PDF-2")), {
      ...sent,
      name: "receipt.pdf",
    })
    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true })

    // One handle used before it was saved: kept, and still saved after.
    const firstId = (first as { resultId: string }).resultId
    expect(
      (await openResult(ctx, { tokenId, id: firstId }))?.bytes().equals(PDF),
    ).toBe(true)

    const done = await deliverUploads(ctx, { ...PUBLIC, uploadLinkId: link.id })
    expect(
      done.map((each) => ("path" in each ? each.path : each.error)),
    ).toEqual(["inbox/2026/receipt.pdf", "inbox/2026/receipt (2).pdf"])
    expect(await readOwn("inbox/2026/receipt.pdf")).toBe(PDF.toString())
    expect(await readOwn("inbox/2026/receipt (2).pdf")).toBe("%PDF-2")

    // Saved once: a second run finds nothing to do.
    expect(await deliverUploads(ctx, PUBLIC)).toEqual([])

    const places = await savedPlaces(ctx, { uploadLinkId: link.id })
    expect(places.get(firstId)).toEqual({
      storeId: own,
      path: "inbox/2026/receipt.pdf",
    })
    expect(places.size).toBe(2)
    // Kept and saved: the row holds no bytes, and names no path in clear.
    const rows = await db().fileLink.findMany({
      where: { uploadLinkId: link.id },
    })
    const kept = rows.find((row) => row.resultId === firstId)!
    expect(kept.ciphertext).toBeNull()
    expect(Buffer.from(kept.storePath!).toString()).not.toContain("receipt")

    // The other handle still becomes a kept result.
    const secondId = (second as { resultId: string }).resultId
    expect(
      (await openResult(ctx, { tokenId, id: secondId }))?.bytes().toString(),
    ).toBe("%PDF-2")
  })

  it("leaves nothing in a store the owner made read-only since", async () => {
    const link = await receiveFile(ctx, {
      tokenId,
      ...PUBLIC,
      name: "scan.pdf",
      destination: { storeId: own, folder: "" },
    })
    await uploadByLink(secretOf(link.url), body(PDF), {
      contentType: null,
      contentLength: null,
    })
    await db().mcpServer.update({
      where: { id: own },
      data: { readOnly: true },
    })

    const [tried] = await deliverUploads(ctx, PUBLIC)
    expect(tried).toMatchObject({ error: expect.stringMatching(/read-only/) })
    // Not tried again at once by a request's after(), but by check_upload.
    expect(await deliverUploads(ctx, PUBLIC)).toEqual([])

    await db().mcpServer.update({
      where: { id: own },
      data: { readOnly: false },
    })
    expect(await deliverUploads(ctx, { ...PUBLIC, retryNow: true })).toEqual([
      { resultId: link.resultId, storeId: own, path: "scan.pdf" },
    ])
    expect(await readOwn("scan.pdf")).toBe(PDF.toString())
  })

  it("names a taken name's next tries", () => {
    expect(nameTry("a.pdf", 1)).toBe("a.pdf")
    expect(nameTry("a.pdf", 3)).toBe("a (3).pdf")
    expect(nameTry(".env", 2)).toBe(".env (2)")
    expect(nameTry("notes", 2)).toBe("notes (2)")
  })
})

describe("the upload tools with a store", () => {
  async function connect(existing?: string) {
    const token =
      existing ??
      (
        await createApiToken(ctx, {
          name: "Mover",
          allowAllServers: true,
          shareFiles: true,
        })
      ).token
    const scope = { ...(await resolveApiToken(token))!, ...PUBLIC }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
      serverSide,
    )
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
    return { client, scope, token }
  }

  function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
    return (result.content as Array<{ type: string; text?: string }>)
      .map((part) => part.text ?? "")
      .join("\n")
  }

  it("take a folder in PCP's own store, and check_upload says where each went", async () => {
    const { client, scope } = await connect()
    const made = await client.callTool({
      name: "create_upload_link",
      arguments: { purpose: "scans", folder: "scans", max_files: 1 },
    })
    const { url, upload } = made.structuredContent as {
      url: string
      upload: { id: string }
    }
    expect(textOf(made)).toMatch(/saves each in PCP files, in scans too/)

    await uploadToPage(secretOf(url), body(PDF), {
      contentType: null,
      contentLength: null,
      name: "page.pdf",
    })

    const checked = await client.callTool({
      name: "check_upload",
      arguments: { id: upload.id },
    })
    expect(checked.structuredContent).toMatchObject({
      files: [
        {
          name: "page.pdf",
          saved: { store: "pcp-files", path: "scans/page.pdf" },
        },
      ],
    })
    expect(textOf(checked)).toMatch(/saved in pcp-files as scans\/page\.pdf/)
    expect(await readOwn("scans/page.pdf")).toBe(PDF.toString())
    expect(scope.tokenId).toBeTruthy()
    await client.close()
  })

  it("refuse a store whose save_file is blocked for the token, an unknown one, and ..", async () => {
    const { client, scope, token } = await connect()

    const unknown = await client.callTool({
      name: "receive_file",
      arguments: { store: "nowhere" },
    })
    expect(textOf(unknown)).toMatch(/no store called nowhere/)

    const up = await client.callTool({
      name: "receive_file",
      arguments: { folder: "../etc" },
    })
    expect(up.isError).toBe(true)
    await client.close()

    await setServerToolAccess(ctx, scope.tokenId, own, "allowed")
    await setToolAccess(ctx, scope.tokenId, own, "save_file", "blocked")
    const again = await connect(token)
    const blocked = await again.client.callTool({
      name: "create_upload_link",
      arguments: { purpose: "scans", store: "pcp-files" },
    })
    expect(textOf(blocked)).toMatch(/blocked pcp-files\/save_file/)
    expect(await db().uploadLink.count()).toBe(0)
    expect(await db().fileLink.count()).toBe(0)
    await again.client.close()
    expect((await getServer(ctx, own)).readOnly).toBe(false)
  })
})
