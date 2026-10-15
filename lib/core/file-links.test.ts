import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createApiToken,
  resolveApiToken,
  revokeApiToken,
  updateApiToken,
} from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import {
  downloadByLink,
  FILE_LINK_TTL_MS,
  MAX_LINK_DOWNLOADS,
  MAX_LIVE_LINKS_PER_TOKEN,
  receiveFile,
  shareResult,
  uploadByLink,
} from "./file-links"
import { buildGatewayServer, loadGatewayServers } from "./gateway"
import { readRequestLog } from "./request-log"
import {
  EMPTY_CONFIG,
  forgetResourceLimits,
  saveResourceConfig,
} from "./resources/state"
import { scratchDatabase } from "./test-db"
import {
  describeResults,
  keepBytes,
  keepResult,
  openResult,
} from "./tool-results"
import { setupVault } from "./vault"

// Links that move a file between PCP and an assistant's own computer: what
// a download serves and how often, what an upload becomes and for whom, and
// what the database holds of either.

const PUBLIC_URL = "https://pcp.example"
const PDF = Buffer.from("%PDF-1.4\n% statement\n")

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  forgetResourceLimits()
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
  await cleanup()
  forgetResourceLimits()
})

function secretOf(url: string): string {
  expect(url).toMatch(/^https:\/\/pcp\.example\/api\/files\/[\w-]{43}$/)
  return url.split("/").pop()!
}

async function keptPdf(token = tokenId) {
  return keepBytes(ctx, {
    tokenId: token,
    serverId: null,
    toolName: "get_attachment",
    bytes: PDF,
    mediaType: "application/pdf",
    name: "statement.pdf",
  })
}

async function* body(...parts: Buffer[]): AsyncIterable<Uint8Array> {
  yield* parts
}

const NO_HEADERS = { contentType: null, contentLength: null }

describe("a download link", () => {
  it("serves the kept file a few times, under a key of its own, and logs each", async () => {
    const kept = await keptPdf()
    const link = await shareResult(ctx, {
      tokenId,
      id: kept.id,
      publicUrl: PUBLIC_URL,
    })
    expect(link).toMatchObject({
      name: "statement.pdf",
      mediaType: "application/pdf",
      size: PDF.length,
      maxUses: MAX_LINK_DOWNLOADS,
    })
    const secret = secretOf(link.url)

    // The row holds the secret's hash and the file encrypted, never either.
    const row = await db().fileLink.findFirstOrThrow()
    expect(row.secretHash).not.toContain(secret)
    expect(Buffer.from(row.ciphertext!).includes(PDF)).toBe(false)

    for (let use = 0; use < MAX_LINK_DOWNLOADS; use++) {
      const file = await downloadByLink(secret)
      expect(file).toMatchObject({
        ok: true,
        name: "statement.pdf",
        mediaType: "application/pdf",
      })
      expect(file.ok && file.bytes.equals(PDF)).toBe(true)
    }

    expect(await downloadByLink(secret)).toMatchObject({
      ok: false,
      status: 410,
    })

    const { entries } = await readRequestLog(ctx.vaultId)
    expect(
      entries.filter((entry) => entry.tool === "file_link/download"),
    ).toHaveLength(MAX_LINK_DOWNLOADS + 1)
  })

  it("shares a kept text as UTF-8, and ends with its hour or its result", async () => {
    const now = new Date()
    const text = await keepResult(ctx, {
      tokenId,
      serverId: null,
      toolName: "read",
      text: "Grüße",
      mediaType: "text/markdown",
    })
    const link = await shareResult(
      ctx,
      { tokenId, id: text.id, publicUrl: PUBLIC_URL },
      now,
    )
    expect(link.mediaType).toBe("text/markdown; charset=utf-8")
    expect(link.expiresAt.getTime()).toBe(now.getTime() + FILE_LINK_TTL_MS)

    const file = await downloadByLink(secretOf(link.url), now)
    expect(file.ok && file.bytes.toString("utf8")).toBe("Grüße")
    expect(
      await downloadByLink(
        secretOf(link.url),
        new Date(now.getTime() + FILE_LINK_TTL_MS),
      ),
    ).toMatchObject({ ok: false, status: 404 })

    // A result with less than an hour left: the link ends with it.
    const late = new Date(text.expiresAt.getTime() - 60_000)
    const short = await shareResult(
      ctx,
      { tokenId, id: text.id, publicUrl: PUBLIC_URL },
      late,
    )
    expect(short.expiresAt).toEqual(text.expiresAt)
  })

  it("is refused for another token's result, a wrong secret, and once its token cannot use links", async () => {
    const { id: other } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
      shareFiles: true,
    })
    const theirs = await keptPdf(other)
    await expect(
      shareResult(ctx, { tokenId, id: theirs.id, publicUrl: PUBLIC_URL }),
    ).rejects.toMatchObject({ code: "not_found" })

    expect(await downloadByLink("not-a-secret")).toMatchObject({
      status: 404,
    })
    expect(await downloadByLink("A".repeat(43))).toMatchObject({
      status: 404,
    })

    const link = await shareResult(ctx, {
      tokenId,
      id: (await keptPdf()).id,
      publicUrl: PUBLIC_URL,
    })
    const secret = secretOf(link.url)

    await updateApiToken(ctx, tokenId, {
      name: "Claude",
      allowAllServers: true,
      shareFiles: false,
    })
    expect(await downloadByLink(secret)).toMatchObject({ status: 404 })

    await updateApiToken(ctx, tokenId, {
      name: "Claude",
      allowAllServers: true,
      shareFiles: true,
    })
    expect(await downloadByLink(secret)).toMatchObject({ ok: true })

    await revokeApiToken(ctx, tokenId)
    expect(await downloadByLink(secret)).toMatchObject({ status: 404 })
  })

  it("keeps a token to a number of live links", async () => {
    const kept = await keptPdf()

    for (let made = 0; made < MAX_LIVE_LINKS_PER_TOKEN; made++) {
      await shareResult(ctx, { tokenId, id: kept.id, publicUrl: PUBLIC_URL })
    }

    await expect(
      receiveFile(ctx, { tokenId, publicUrl: PUBLIC_URL }),
    ).rejects.toThrow(/as many as it keeps/)

    // An hour later they have all ended.
    const later = new Date(Date.now() + FILE_LINK_TTL_MS + 1_000)
    await expect(
      receiveFile(ctx, { tokenId, publicUrl: PUBLIC_URL }, later),
    ).resolves.toBeTruthy()
  })
})

describe("an upload link", () => {
  it("takes one file, which becomes the token's result under the handle it gave", async () => {
    const link = await receiveFile(ctx, {
      tokenId,
      publicUrl: PUBLIC_URL,
      name: "scan.pdf",
    })
    const secret = secretOf(link.url)

    // Nothing to use before it arrived.
    expect(await openResult(ctx, { tokenId, id: link.resultId })).toBeNull()

    const received = await uploadByLink(
      secret,
      body(PDF.subarray(0, 5), PDF.subarray(5)),
      { contentType: "application/octet-stream", contentLength: PDF.length },
    )
    expect(received).toMatchObject({
      ok: true,
      resultId: link.resultId,
      name: "scan.pdf",
      mediaType: "application/pdf",
      size: PDF.length,
    })
    // Held under the link's key until the token uses it.
    const row = await db().fileLink.findFirstOrThrow()
    expect(Buffer.from(row.ciphertext!).includes(PDF)).toBe(false)
    expect(await db().toolResult.count()).toBe(0)

    expect(await uploadByLink(secret, body(PDF), NO_HEADERS)).toMatchObject({
      ok: false,
      status: 409,
    })

    // Another token's handle names nothing.
    const { id: other } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
      shareFiles: true,
    })
    expect(
      await openResult(ctx, { tokenId: other, id: link.resultId }),
    ).toBeNull()

    const [info] = await describeResults(ctx, tokenId, [link.resultId])
    expect(info).toMatchObject({
      found: true,
      kind: "bytes",
      name: "scan.pdf",
      mediaType: "application/pdf",
      toolName: "receive_file",
    })
    const opened = await openResult(ctx, { tokenId, id: link.resultId })
    expect(opened!.bytes().equals(PDF)).toBe(true)
    // The link is gone once its file is a result.
    expect(await db().fileLink.count()).toBe(0)
  })

  it("names the file by what the request says, or by its name and bytes", async () => {
    const typed = await receiveFile(ctx, { tokenId, publicUrl: PUBLIC_URL })
    await uploadByLink(secretOf(typed.url), body(Buffer.from("a,b\n")), {
      contentType: "text/csv; charset=utf-8",
      contentLength: null,
    })
    const guessed = await receiveFile(ctx, {
      tokenId,
      publicUrl: PUBLIC_URL,
      name: "notes.txt",
    })
    await uploadByLink(
      secretOf(guessed.url),
      body(Buffer.from("hello")),
      // What curl --data-binary sends.
      { contentType: "application/x-www-form-urlencoded", contentLength: 5 },
    )
    const asked = await receiveFile(ctx, {
      tokenId,
      publicUrl: PUBLIC_URL,
      type: "application/x-custom",
    })
    await uploadByLink(secretOf(asked.url), body(PDF), NO_HEADERS)

    const infos = await describeResults(ctx, tokenId, [
      typed.resultId,
      guessed.resultId,
      asked.resultId,
    ])
    expect(infos.map((info) => info.found && info.mediaType)).toEqual([
      "text/csv; charset=utf-8",
      "text/plain; charset=utf-8",
      "application/x-custom",
    ])
  })

  it("refuses a form, a file larger than PCP keeps, and an expired link", async () => {
    const link = await receiveFile(ctx, { tokenId, publicUrl: PUBLIC_URL })
    const secret = secretOf(link.url)

    expect(
      await uploadByLink(secret, body(PDF), {
        contentType: "multipart/form-data; boundary=x",
        contentLength: null,
      }),
    ).toMatchObject({ ok: false, status: 415 })

    await saveResourceConfig({ ...EMPTY_CONFIG, fileMb: 1 })
    const big = Buffer.alloc(1024 * 1024 + 1)
    expect(
      await uploadByLink(secret, body(big), {
        contentType: null,
        contentLength: big.length,
      }),
    ).toMatchObject({ ok: false, status: 413 })
    // A length it did not say is counted as it comes.
    expect(
      await uploadByLink(
        secret,
        body(big.subarray(0, 600_000), big.subarray(600_000)),
        NO_HEADERS,
      ),
    ).toMatchObject({ ok: false, status: 413 })

    expect(
      await uploadByLink(
        secret,
        body(PDF),
        NO_HEADERS,
        new Date(Date.now() + FILE_LINK_TTL_MS + 1_000),
      ),
    ).toMatchObject({ ok: false, status: 404 })

    // Still open for the file it was made for.
    expect(await uploadByLink(secret, body(PDF), NO_HEADERS)).toMatchObject({
      ok: true,
    })
  })
})

describe("through the gateway", () => {
  async function connect(shareFiles: boolean) {
    const { token } = await createApiToken(ctx, {
      name: shareFiles ? "Mover" : "Plain",
      allowAllServers: true,
      shareFiles,
    })
    const scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
      serverSide,
    )
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
    return { client, scope }
  }

  function json(result: unknown): Record<string, unknown> {
    const content = (result as { content: Array<{ text?: string }> }).content
    return JSON.parse(content[0]!.text!) as Record<string, unknown>
  }

  it("offers the tools only to a token the owner let move files, and says how", async () => {
    const plain = await connect(false)
    const plainTools = (await plain.client.listTools()).tools.map(
      (tool) => tool.name,
    )
    expect(plainTools).not.toContain("share_result")
    expect(plainTools).not.toContain("receive_file")
    expect(plain.client.getInstructions()).not.toContain("receive_file")

    const mover = await connect(true)
    const tools = (await mover.client.listTools()).tools.map(
      (tool) => tool.name,
    )
    expect(tools).toEqual(
      expect.arrayContaining(["share_result", "receive_file"]),
    )
    expect(mover.client.getInstructions()).toContain("receive_file")

    await plain.client.close()
    await mover.client.close()
  })

  it("hands back a link and a curl command, and the handle an upload becomes", async () => {
    const { client, scope } = await connect(true)

    const received = json(
      await client.callTool({
        name: "receive_file",
        arguments: { name: "my scan.pdf" },
      }),
    )
    const handle = received.result as { $result: string }
    expect(received.curl).toBe(`curl -fsS -T 'my scan.pdf' ${received.url}`)

    await uploadByLink(secretOf(received.url as string), body(PDF), NO_HEADERS)

    const shared = json(
      await client.callTool({
        name: "share_result",
        arguments: { id: handle.$result },
      }),
    )
    expect(shared).toMatchObject({
      name: "my scan.pdf",
      type: "application/pdf",
      size: PDF.length,
      downloads: MAX_LINK_DOWNLOADS,
    })
    expect(shared.curl).toBe(`curl -fsSL -o 'my scan.pdf' ${shared.url}`)

    const file = await downloadByLink(secretOf(shared.url as string))
    expect(file.ok && file.bytes.equals(PDF)).toBe(true)
    // The upload became this token's result on the way.
    expect(
      await openResult(scope.ctx, {
        tokenId: scope.tokenId,
        id: handle.$result,
      }),
    ).not.toBeNull()

    const missing = await client.callTool({
      name: "share_result",
      arguments: { id: "nope" },
    })
    expect(missing.isError).toBe(true)

    await client.close()
  })
})
