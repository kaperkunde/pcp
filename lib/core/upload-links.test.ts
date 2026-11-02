import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken, updateApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { receiveFile, uploadByLink } from "./file-links"
import { buildGatewayServer, loadGatewayServers } from "./gateway"
import { readRequestLog } from "./request-log"
import {
  EMPTY_CONFIG,
  forgetResourceLimits,
  saveResourceConfig,
} from "./resources/state"
import { scratchDatabase } from "./test-db"
import { describeResults, openResult, RESULT_TTL_MS } from "./tool-results"
import {
  cleanFileName,
  closeUploadPage,
  createUploadLink,
  DEFAULT_UPLOAD_FILES,
  MAX_OPEN_UPLOAD_LINKS_PER_TOKEN,
  pruneUploadLinks,
  UPLOAD_AFTER_FIRST_MS,
  UPLOAD_LINK_TTL_MS,
  uploadPageView,
  uploadStatus,
  uploadToPage,
} from "./upload-links"
import { setupVault } from "./vault"

// Upload links: a page the owner sends an assistant files from, by the link
// alone. How many files it takes and for how long, what each becomes and
// for whom, what the database holds of it, and the two tools.

const PUBLIC_URL = "https://pcp.example"
const PDF = Buffer.from("%PDF-1.4\n% receipt\n")
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

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
  expect(url).toMatch(/^https:\/\/pcp\.example\/upload\/[\w-]{43}$/)
  return url.split("/").pop()!
}

async function* body(...parts: Buffer[]): AsyncIterable<Uint8Array> {
  yield* parts
}

function sent(name: string | null, contentType: string | null = null) {
  return { contentType, contentLength: null, name }
}

async function newLink(
  input: { maxFiles?: number; minutes?: number; purpose?: string } = {},
  now = new Date(),
) {
  const link = await createUploadLink(
    ctx,
    {
      tokenId,
      publicUrl: PUBLIC_URL,
      purpose: input.purpose ?? "The receipts for March",
      maxFiles: input.maxFiles,
      minutes: input.minutes,
    },
    now,
  )
  return { ...link, secret: secretOf(link.url) }
}

describe("an upload link", () => {
  it("shows its purpose with the link alone, and nothing of it without", async () => {
    const link = await newLink({ purpose: "The receipts​ for\nMarch" })

    expect(link.maxFiles).toBe(DEFAULT_UPLOAD_FILES)
    expect(await uploadPageView(link.secret)).toMatchObject({
      state: "open",
      purpose: "The receipts for March",
      assistant: "Claude",
      maxFiles: DEFAULT_UPLOAD_FILES,
      remaining: DEFAULT_UPLOAD_FILES,
      files: [],
    })
    expect(await uploadPageView("x".repeat(43))).toEqual({ state: "gone" })
    expect(await uploadPageView("short")).toEqual({ state: "gone" })

    // The database holds the secret's hash and the purpose encrypted.
    const row = await db().uploadLink.findFirstOrThrow()
    expect(row.secretHash).not.toContain(link.secret)
    expect(Buffer.from(row.purpose).toString("utf8")).not.toContain("March")
    // One place per file, made with it, none reachable as a file link.
    const slots = await db().fileLink.findMany({
      where: { uploadLinkId: link.id },
    })
    expect(slots).toHaveLength(DEFAULT_UPLOAD_FILES)
    expect(slots.every((slot) => slot.wrappedKey && !slot.ciphertext)).toBe(
      true,
    )
    expect(
      await uploadByLink(link.secret, body(PDF), sent(null)),
    ).toMatchObject({ ok: false, status: 404 })
  })

  it("takes several files with their names, which become the token's results only when it uses them", async () => {
    const link = await newLink({ maxFiles: 3 })

    const first = await uploadToPage(
      link.secret,
      body(PDF.subarray(0, 4), PDF.subarray(4)),
      sent(encodeURIComponent("Kassenbon März.pdf")),
    )
    const second = await uploadToPage(
      link.secret,
      body(JPEG),
      sent("../../photo.jpg", "image/jpeg"),
    )

    expect(first).toMatchObject({
      ok: true,
      name: "Kassenbon März.pdf",
      mediaType: "application/pdf",
      size: PDF.length,
      open: true,
      remaining: 2,
    })
    expect(second).toMatchObject({
      ok: true,
      name: "photo.jpg",
      mediaType: "image/jpeg",
      open: true,
      remaining: 1,
    })
    if (!first?.ok || !second?.ok) throw new Error("not taken")

    // Held under the link's key; nothing kept yet.
    const held = await db().fileLink.findMany({
      where: { uploadLinkId: link.id, receivedAt: { not: null } },
    })
    expect(held).toHaveLength(2)
    expect(held.some((row) => Buffer.from(row.ciphertext!).includes(PDF))).toBe(
      false,
    )
    expect(await db().toolResult.count()).toBe(0)

    const status = await uploadStatus(ctx, tokenId, link.id)
    expect(status).toMatchObject({ open: true, remaining: 1 })
    expect(status!.files.map((file) => file.name)).toEqual([
      "Kassenbon März.pdf",
      "photo.jpg",
    ])
    // Checking claims nothing.
    expect(await db().toolResult.count()).toBe(0)

    // Another token's handle names nothing; its own opens the file.
    const { id: other } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
      shareFiles: true,
    })
    expect(
      await openResult(ctx, { tokenId: other, id: first.resultId }),
    ).toBeNull()
    expect(await uploadStatus(ctx, other, link.id)).toBeNull()
    const opened = await openResult(ctx, { tokenId, id: first.resultId })
    expect(opened!.bytes().equals(PDF)).toBe(true)
    const [info] = await describeResults(ctx, tokenId, [first.resultId])
    expect(info).toMatchObject({
      found: true,
      name: "Kassenbon März.pdf",
      toolName: "create_upload_link",
    })

    // A file used is still listed, now as a kept result.
    const after = await uploadStatus(ctx, tokenId, link.id)
    expect(after!.files.map((file) => file.resultId)).toEqual([
      first.resultId,
      second.resultId,
    ])

    const { entries } = await readRequestLog(ctx.vaultId)
    expect(
      entries.filter((entry) => entry.tool === "upload_link/upload"),
    ).toHaveLength(2)
  })

  it("closes once it has its files, and refuses another", async () => {
    const link = await newLink({ maxFiles: 2 })

    await uploadToPage(link.secret, body(PDF), sent("a.pdf"))
    const last = await uploadToPage(link.secret, body(PDF), sent("b.pdf"))
    expect(last).toMatchObject({ ok: true, open: false, remaining: 0 })

    expect(
      await uploadToPage(link.secret, body(PDF), sent("c.pdf")),
    ).toMatchObject({ ok: false, status: 410 })
    expect(await uploadStatus(ctx, tokenId, link.id)).toMatchObject({
      open: false,
      remaining: 0,
    })
    expect(await uploadPageView(link.secret)).toMatchObject({
      state: "closed",
      files: [{ name: "a.pdf" }, { name: "b.pdf" }],
    })
  })

  it("takes files for its hour, then a quarter of an hour from the first", async () => {
    const start = new Date()
    const late = await newLink({}, start)

    expect(
      await uploadToPage(
        late.secret,
        body(PDF),
        sent("late.pdf"),
        new Date(start.getTime() + UPLOAD_LINK_TTL_MS + 1_000),
      ),
    ).toMatchObject({ ok: false, status: 410 })

    const short = await newLink({ minutes: 10 }, start)
    expect(short.acceptUntil.getTime()).toBe(start.getTime() + 10 * 60_000)

    const link = await newLink({}, start)
    const firstAt = new Date(start.getTime() + 50 * 60_000)
    const first = await uploadToPage(
      link.secret,
      body(PDF),
      sent("first.pdf"),
      firstAt,
    )
    expect(first).toMatchObject({
      ok: true,
      until: new Date(firstAt.getTime() + UPLOAD_AFTER_FIRST_MS),
    })
    // Past its hour, within the quarter: still taken.
    expect(
      await uploadToPage(
        link.secret,
        body(PDF),
        sent("second.pdf"),
        new Date(start.getTime() + 62 * 60_000),
      ),
    ).toMatchObject({ ok: true })
    // Its empty places last as long; the cleanup leaves them till then.
    await pruneUploadLinks(new Date(start.getTime() + 62 * 60_000))
    expect(
      await db().fileLink.count({
        where: { uploadLinkId: link.id, receivedAt: null },
      }),
    ).toBe(DEFAULT_UPLOAD_FILES - 2)
    expect(
      await uploadToPage(
        link.secret,
        body(PDF),
        sent("third.pdf"),
        new Date(firstAt.getTime() + UPLOAD_AFTER_FIRST_MS + 1_000),
      ),
    ).toMatchObject({ ok: false, status: 410 })
  })

  it("closes when the owner says Done, and keeps what arrived", async () => {
    const link = await newLink()

    await uploadToPage(link.secret, body(PDF), sent("only.pdf"))
    expect(await closeUploadPage(link.secret)).toEqual({ ok: true, files: 1 })
    // Saying it again changes nothing.
    expect(await closeUploadPage(link.secret)).toEqual({ ok: true, files: 1 })

    expect(
      await uploadToPage(link.secret, body(PDF), sent("more.pdf")),
    ).toMatchObject({ ok: false, status: 410 })
    // The empty places go; the file that arrived stays.
    expect(
      await db().fileLink.findMany({
        where: { uploadLinkId: link.id },
        select: { name: true },
      }),
    ).toEqual([{ name: "only.pdf" }])
    expect(await uploadStatus(ctx, tokenId, link.id)).toMatchObject({
      open: false,
      files: [{ name: "only.pdf" }],
    })
    expect(await closeUploadPage("x".repeat(43))).toMatchObject({
      ok: false,
      status: 404,
    })

    const { entries } = await readRequestLog(ctx.vaultId)
    expect(
      entries.filter((entry) => entry.tool === "upload_link/done"),
    ).toHaveLength(1)
  })

  it("refuses a form and a file larger than PCP keeps, without using a place", async () => {
    const link = await newLink({ maxFiles: 1 })

    expect(
      await uploadToPage(link.secret, body(PDF), {
        contentType: "multipart/form-data; boundary=x",
        contentLength: null,
        name: "a.pdf",
      }),
    ).toMatchObject({ ok: false, status: 415 })

    await saveResourceConfig({ ...EMPTY_CONFIG, fileMb: 1 })
    const big = Buffer.alloc(1024 * 1024 + 1)
    const refused = await uploadToPage(link.secret, body(big), {
      contentType: null,
      contentLength: big.length,
      name: "big.bin",
    })
    expect(refused).toMatchObject({ ok: false, status: 413 })
    expect(refused && !refused.ok && refused.message).toMatch(/^.*You can/)
    expect(
      await uploadToPage(
        link.secret,
        body(big.subarray(0, 600_000), big.subarray(600_000)),
        sent("big.bin"),
      ),
    ).toMatchObject({ ok: false, status: 413 })

    expect(
      await uploadToPage(link.secret, body(PDF), sent("a.pdf")),
    ).toMatchObject({ ok: true, open: false })
  })

  it("works only while its token is live and may move files", async () => {
    const link = await newLink()

    await updateApiToken(ctx, tokenId, {
      name: "Claude",
      allowAllServers: true,
      shareFiles: false,
    })
    expect(await uploadPageView(link.secret)).toEqual({ state: "gone" })
    expect(
      await uploadToPage(link.secret, body(PDF), sent("a.pdf")),
    ).toMatchObject({ ok: false, status: 404 })
  })

  it("keeps a token to a few open links, and its bounds", async () => {
    for (let n = 0; n < MAX_OPEN_UPLOAD_LINKS_PER_TOKEN; n++) {
      await newLink({ maxFiles: 10 })
    }
    await expect(newLink()).rejects.toThrow(/upload links/)
    // Its places do not count against the token's file links.
    await expect(
      receiveFile(ctx, { tokenId, publicUrl: PUBLIC_URL }),
    ).resolves.toBeTruthy()

    await expect(
      createUploadLink(ctx, {
        tokenId,
        publicUrl: PUBLIC_URL,
        purpose: "x",
        maxFiles: 11,
      }),
    ).rejects.toThrow(/1 to 10 files/)
    await expect(
      createUploadLink(ctx, {
        tokenId,
        publicUrl: PUBLIC_URL,
        purpose: "x",
        minutes: 61,
      }),
    ).rejects.toThrow(/minutes/)
    await expect(
      createUploadLink(ctx, {
        tokenId,
        publicUrl: PUBLIC_URL,
        purpose: " ​ ",
      }),
    ).rejects.toThrow(/what the files are for/)
  })

  it("is removed by the cleanup a day after it stops taking files", async () => {
    const start = new Date()
    const link = await newLink({}, start)
    await uploadToPage(link.secret, body(PDF), sent("a.pdf"), start)

    // An hour on: the empty places are gone, the file and the row stay.
    const { pruneFileLinks } = await import("./file-links")
    const hour = new Date(start.getTime() + UPLOAD_LINK_TTL_MS)
    await pruneFileLinks(hour)
    expect(await pruneUploadLinks(hour)).toBe(0)
    expect(await db().fileLink.count()).toBe(1)

    const day = new Date(
      start.getTime() + UPLOAD_AFTER_FIRST_MS + RESULT_TTL_MS + 1_000,
    )
    await pruneFileLinks(day)
    expect(await pruneUploadLinks(day)).toBe(1)
    expect(await db().fileLink.count()).toBe(0)
    expect(await db().uploadLink.count()).toBe(0)
  })
})

describe("a file's name", () => {
  it("loses its path and what does not show", () => {
    expect(cleanFileName(encodeURIComponent("a/b/c.pdf"))).toBe("c.pdf")
    expect(cleanFileName("..\\..\\x.txt")).toBe("x.txt")
    expect(cleanFileName("bad%E0%A4%A")).toBe("bad%E0%A4%A")
    expect(cleanFileName(encodeURIComponent("a‮b\u0000.txt"))).toBe("a b .txt")
    expect(cleanFileName("..")).toBeNull()
    expect(cleanFileName("")).toBeNull()
    expect(cleanFileName(null)).toBeNull()
    expect([...cleanFileName("x".repeat(400))!]).toHaveLength(255)
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

  type Answer = {
    content: Array<{ type: string; text?: string }>
    structuredContent?: Record<string, unknown>
    isError?: boolean
  }

  it("offers the tools only to a token the owner let move files", async () => {
    const plain = await connect(false)
    const plainTools = (await plain.client.listTools()).tools.map(
      (tool) => tool.name,
    )
    expect(plainTools).not.toContain("create_upload_link")
    expect(plainTools).not.toContain("check_upload")
    expect(plain.client.getInstructions()).not.toContain("create_upload_link")

    const mover = await connect(true)
    const tools = (await mover.client.listTools()).tools
    const create = tools.find((tool) => tool.name === "create_upload_link")
    expect(create?.description).toMatch(/^Get a link to upload files/)
    expect(create?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    })
    expect(tools.map((tool) => tool.name)).toContain("check_upload")
    expect(mover.client.getInstructions()).toContain("create_upload_link")

    await plain.client.close()
    await mover.client.close()
  })

  it("hands the owner a link, and check_upload the handles that arrived", async () => {
    const { client, scope } = await connect(true)

    const made = (await client.callTool({
      name: "create_upload_link",
      arguments: { purpose: "The scan of your passport", max_files: 2 },
    })) as Answer
    const owner = made.structuredContent as {
      kind: string
      reason: string
      url: string
      label: string
      upload: { id: string; maxFiles: number }
      message: string
    }
    expect(owner).toMatchObject({
      kind: "needs_owner",
      reason: "upload",
      label: "Upload files",
      upload: { maxFiles: 2 },
    })
    const text = made.content[0]!.text!
    // The link is the text's last line, as a markdown link.
    expect(text.trimEnd().split("\n").at(-1)).toBe(
      `[Upload files](${owner.url})`,
    )
    expect(owner.message).toBe(text)
    expect(text).toContain(`check_upload with id "${owner.upload.id}"`)

    // The ask is in the request log (written as the call ends).
    await vi.waitFor(async () => {
      const asked = (await readRequestLog(scope.ctx.vaultId)).entries.find(
        (entry) => entry.tool === "create_upload_link",
      )
      expect(asked).toMatchObject({ ok: true, asked: true })
    })

    const secret = secretOf(owner.url)
    await uploadToPage(secret, body(PDF), sent("passport.pdf"))
    await uploadToPage(secret, body(JPEG), sent("back.jpg", "image/jpeg"))

    const checked = (await client.callTool({
      name: "check_upload",
      arguments: { id: owner.upload.id },
    })) as Answer
    const status = checked.structuredContent as {
      open: boolean
      files: Array<{ handle: { $result: string }; name: string }>
      message: string
    }
    expect(status.open).toBe(false)
    expect(status.files.map((file) => file.name)).toEqual([
      "passport.pdf",
      "back.jpg",
    ])
    expect(status.message).toBe(checked.content[0]!.text)
    expect(status.message).toContain(status.files[0]!.handle.$result)

    // Its handle is the token's file wherever a tool takes one.
    const kept = await openResult(scope.ctx, {
      tokenId: scope.tokenId,
      id: status.files[0]!.handle.$result,
    })
    expect(kept!.bytes().equals(PDF)).toBe(true)

    await client.close()
  })

  it("check_upload waits while the link is open, until the owner says Done", async () => {
    const { client } = await connect(true)
    const made = (await client.callTool({
      name: "create_upload_link",
      arguments: { purpose: "A photo of the meter" },
    })) as Answer
    const owner = made.structuredContent as {
      url: string
      upload: { id: string }
    }
    const secret = secretOf(owner.url)

    const checking = client.callTool({
      name: "check_upload",
      arguments: { id: owner.upload.id },
    }) as Promise<Answer>
    await new Promise((resolve) => setTimeout(resolve, 200))
    await uploadToPage(secret, body(JPEG), sent("meter.jpg", "image/jpeg"))
    await closeUploadPage(secret)

    const status = (await checking).structuredContent as {
      open: boolean
      files: Array<{ name: string; type: string; size: number }>
    }
    expect(status).toMatchObject({
      open: false,
      files: [{ name: "meter.jpg", type: "image/jpeg", size: JPEG.length }],
    })

    const missing = (await client.callTool({
      name: "check_upload",
      arguments: { id: "nope" },
    })) as Answer
    expect(missing.isError).toBe(true)

    const tooMany = (await client.callTool({
      name: "create_upload_link",
      arguments: { purpose: "x", max_files: 50 },
    })) as Answer
    expect(tooMany.isError).toBe(true)

    await client.close()
  })
})
