import { readdir } from "node:fs/promises"
import path from "node:path"

import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/server"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { McpServer } from "@/lib/generated/prisma/client"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { downloadByLink, uploadByLink } from "../file-links"
import { buildGatewayServer, loadGatewayServers } from "../gateway"
import { startTestApi, type TestApi } from "../openapi/test-api"
import {
  EMPTY_CONFIG,
  forgetResourceLimits,
  saveResourceConfig,
} from "../resources/state"
import { scratchDatabase } from "../test-db"
import { describedHandle } from "../test-handles"
import { writeToolAccess } from "../tool-access"
import {
  keepBytes,
  openResult,
  resultKeepers,
  resultOpener,
} from "../tool-results"
import { callServerTool } from "../upstream"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchSite } from "../web-fetch"
import { callBrowserTool } from "./call"
import { chromiumExecutable } from "./executable"
import { closeAllBrowsers, runningBrowser } from "./runtime"
import { createBrowserServer } from "./server"
import { browserTools } from "./tools"

// Files in and out of the browser, against a real headless Chromium and
// pages served on this machine: a download kept as the token's result (and
// gone from the machine), one a page offers on its own refused and said,
// and kept results put into a page's file field. Skipped where no Chromium
// is installed, as call.test.ts is. A click that starts nothing is given a
// second and a half rather than ten, and an action three seconds.

vi.mock("./limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./limits")>()),
  DOWNLOAD_START_MS: 1_500,
  ACTION_TIMEOUT_MS: 3_000,
}))

const executable = await chromiumExecutable()
const PUBLIC_URL = "http://pcp.test"
const PDF = Buffer.from("%PDF-1.4\n% an invoice\n")

let cleanup: () => Promise<void>
let api: TestApi
let elsewhere: TestApi
let ctx: VaultContext
let tokenId: string
let server: McpServer

const FILES = `<!doctype html><title>Files</title>
<a href="/invoice">Invoice</a>
<a id="csv">Export</a>
<a href="/big">Big</a>
<button>Nothing</button>
<script>
const link = document.getElementById("csv")
link.href = URL.createObjectURL(new Blob(["name,amount\\nAda,12\\n"], { type: "text/csv" }))
link.download = "export.csv"
</script>`

const FORM = `<!doctype html><title>Upload</title>
<h1>Upload</h1>
<form method="post" action="/sent" enctype="multipart/form-data">
<label>Statement <input type="file" name="statement"></label>
<input type="file" name="hidden" id="hidden" multiple style="display:none">
<button type="button" onclick="document.getElementById('hidden').click()">Attach</button>
<button>Send</button>
</form>`

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  forgetResourceLimits()
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  tokenId = (await resolveApiToken(token))!.tokenId
  server = await db().mcpServer.findUniqueOrThrow({
    where: { id: (await createBrowserServer(ctx)).id },
  })
  elsewhere = await startTestApi((_, res) => {
    res.setHeader("content-type", "application/pdf")
    res.setHeader("content-disposition", 'attachment; filename="other.pdf"')
    res.end(PDF)
  })
  api = await startTestApi((request, res) => {
    if (request.url.startsWith("/invoice")) {
      res.setHeader("content-type", "application/pdf")
      res.setHeader(
        "content-disposition",
        'attachment; filename="invoice-42.pdf"',
      )
      return res.end(PDF)
    }

    if (request.url.startsWith("/big")) {
      res.setHeader("content-type", "application/octet-stream")
      res.setHeader("content-disposition", 'attachment; filename="big.bin"')
      return res.end(Buffer.alloc(2 * 1024 * 1024, 7))
    }

    res.setHeader("content-type", "text/html; charset=utf-8")

    if (request.url.startsWith("/files")) {
      return res.end(FILES)
    }

    if (request.url.startsWith("/form")) {
      return res.end(FORM)
    }

    if (request.url.startsWith("/sent")) {
      return res.end("<title>Sent</title><h1>Thank you</h1>")
    }

    res.end("<title>Page</title><h1>A page</h1>")
  })
  await setFetchSite(ctx, tokenId, new URL(api.origin).host, "allowed")
  await setFetchPrivate(ctx, tokenId, "allowed")
})

afterEach(async () => {
  await closeAllBrowsers()
  await api.close()
  await elsewhere.close()
  await cleanup()
  forgetResourceLimits()
})

afterAll(async () => {
  await closeAllBrowsers()
})

function call(name: string, args: Record<string, unknown> = {}) {
  return callBrowserTool(ctx, server, name, args, {
    tokenId,
    publicUrl: PUBLIC_URL,
    open: resultOpener(ctx, tokenId),
    keepBytes: resultKeepers(ctx, tokenId).bytes,
  })
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

function refOf(result: CallToolResult, pattern: RegExp): string {
  const line = textOf(result)
    .split("\n")
    .find((candidate) => pattern.test(candidate))
  const ref = line?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1]

  if (!ref) {
    throw new Error(`no ref for ${pattern} in:\n${textOf(result)}`)
  }

  return ref
}

/** The tab an answer is about ("Tab abc: title"). */
function tabOf(result: CallToolResult | string): string {
  const text = typeof result === "string" ? result : textOf(result)
  const id = text.match(/^Tab (\S+):/m)?.[1]

  if (!id) {
    throw new Error(`no tab in:\n${text}`)
  }

  return id
}

type Downloaded = {
  tab: string
  file: { $result: string; type: string; size: number; name: string }
  from?: string
  note: string
}

function downloaded(result: CallToolResult): Downloaded {
  expect(result.isError, textOf(result)).toBeUndefined()
  return JSON.parse(textOf(result)) as Downloaded
}

/** What Chromium left in the browser's downloads folder. */
async function leftOnDisk(): Promise<string[]> {
  const vault = runningBrowser(ctx.vaultId)!
  return readdir(path.join(vault.scratchDir, "downloads"))
}

describe.skipIf(!executable)(
  "files in the browser",
  { timeout: 90_000 },
  () => {
    it("keeps a download as the token's result and leaves nothing on disk", async () => {
      const page = await call("tabs", {
        action: "open",
        url: `${api.origin}/files`,
      })
      const tab = tabOf(page)

      const byLink = downloaded(
        await call("download", { tab, ref: refOf(page, /link "Invoice"/) }),
      )
      expect(byLink.file).toMatchObject({
        type: "application/pdf",
        size: PDF.length,
        name: "invoice-42.pdf",
      })
      expect(byLink.from).toBe(`${api.origin}/invoice`)
      expect(byLink.note).toContain(byLink.file.$result)
      const kept = await openResult(ctx, { tokenId, id: byLink.file.$result })
      expect(kept!.bytes().equals(PDF)).toBe(true)

      // A file the page makes itself (a blob), kept as the text it is.
      const blob = downloaded(
        await call("download", { tab, ref: refOf(page, /link "Export"/) }),
      )
      expect(blob.file).toMatchObject({
        type: "text/csv; charset=utf-8",
        name: "export.csv",
      })
      expect(blob.from).toBeUndefined()
      const csv = await openResult(ctx, { tokenId, id: blob.file.$result })
      expect(csv!.text()).toBe("name,amount\nAda,12\n")

      // By its address, at a site the tab may open; the tab stays put.
      const byUrl = downloaded(
        await call("download", { tab, url: `${api.origin}/invoice?again` }),
      )
      expect(byUrl.file.name).toBe("invoice-42.pdf")
      expect(textOf(await call("snapshot", { tab }))).toContain(
        `Address: ${api.origin}/files`,
      )

      expect(await leftOnDisk()).toEqual([])

      // Another token cannot use what this one downloaded.
      const { token } = await createApiToken(ctx, {
        name: "Other",
        allowAllServers: true,
      })
      const other = (await resolveApiToken(token))!.tokenId
      expect(
        await openResult(ctx, { tokenId: other, id: byLink.file.$result }),
      ).toBeNull()
    })

    it("refuses a download nobody asked for, and says the page offered one", async () => {
      const page = await call("tabs", {
        action: "open",
        url: `${api.origin}/files`,
      })
      const tab = tabOf(page)
      const clicked = await call("click", {
        tab,
        ref: refOf(page, /link "Invoice"/),
      })
      // In this answer or the next: Chromium says so once the site answers.
      const waited = await call("wait_for", { tab, ms: 1_000 })

      expect(`${textOf(clicked)}\n${textOf(waited)}`).toContain(
        "The page offered a file to download (invoice-42.pdf)",
      )
      // Chromium removes the part of a download it cancelled itself, a
      // moment after it says so: on a busy machine, after the answer.
      await expect.poll(leftOnDisk).toEqual([])
      expect(await db().toolResult.count()).toBe(0)
      // Said once.
      expect(textOf(await call("snapshot", { tab }))).not.toContain(
        "offered a file",
      )

      const opened = await call("navigate", {
        tab,
        url: `${api.origin}/invoice`,
      })
      expect(opened.isError).toBe(true)
      expect(textOf(opened)).toContain("Call download with that address")
    })

    it("downloads nothing from a site the tab may not open, nothing too large, and says when nothing started", async () => {
      const page = await call("tabs", {
        action: "open",
        url: `${api.origin}/files`,
      })
      const tab = tabOf(page)

      const refused = await call("download", {
        tab,
        url: `${elsewhere.origin}/x`,
      })
      expect(refused.isError).toBe(true)
      expect(textOf(refused)).toContain("Call navigate with the address")
      expect(elsewhere.requests).toHaveLength(0)

      const pcp = await call("download", {
        tab,
        url: `${PUBLIC_URL}/api/export`,
      })
      expect(pcp.isError).toBe(true)
      expect(textOf(pcp)).toContain("PCP's own address")

      const nothing = await call("download", {
        tab,
        ref: refOf(page, /button "Nothing"/),
      })
      expect(nothing.isError).toBe(true)
      expect(textOf(nothing)).toContain("Nothing started a download")

      await saveResourceConfig({ ...EMPTY_CONFIG, fileMb: 1 })
      const big = await call("download", {
        tab,
        ref: refOf(page, /link "Big"/),
      })
      expect(big.isError).toBe(true)
      expect(textOf(big)).toContain("big.bin is larger than PCP keeps")
      // Cancelled past the largest file: Chromium removes its part.
      await expect.poll(leftOnDisk).toEqual([])
      expect(await db().toolResult.count()).toBe(0)

      const page2 = await call("navigate", { tab, url: `${api.origin}/page` })
      const opened = await call("download", {
        tab,
        url: `${api.origin}/page`,
      })
      expect(opened.isError).toBe(true)
      expect(textOf(opened)).toContain("opened a page, not a file")
      expect(page2.isError).toBeUndefined()
    })

    it("puts kept files into a file field and its picker, read from handles through the gateway's path", async () => {
      // A file kept for the token, as a mail attachment read would be.
      const pdf = await keepBytes(ctx, {
        tokenId,
        serverId: null,
        toolName: "get_attachment",
        bytes: PDF,
        mediaType: "application/pdf",
        name: "statement.pdf",
      })
      const note = await keepBytes(ctx, {
        tokenId,
        serverId: null,
        toolName: "keep",
        bytes: Buffer.from("hello"),
        mediaType: "text/plain",
        name: null,
      })
      const viaGateway = (name: string, args: Record<string, unknown>) =>
        callServerTool(ctx, server, name, args, {
          publicUrl: PUBLIC_URL,
          tokenId,
          keep: resultKeepers(ctx, tokenId).text,
          keepBytes: resultKeepers(ctx, tokenId).bytes,
          open: resultOpener(ctx, tokenId),
        })

      const form = await viaGateway("tabs", {
        action: "open",
        url: `${api.origin}/form`,
      })
      const tab = tabOf(form)

      const unknown = viaGateway("upload_file", {
        tab,
        ref: refOf(form, /button "Statement"/),
        files: [{ $result: "nope" }],
      })
      await expect(unknown).rejects.toThrow(/not there for this token/)

      const intoField = await viaGateway("upload_file", {
        tab,
        ref: refOf(form, /button "Statement"/),
        files: [{ $result: pdf.id }],
      })
      expect(intoField.isError, textOf(intoField)).toBeUndefined()
      expect(textOf(intoField)).toContain("Chose statement.pdf in")

      const throughPicker = await viaGateway("upload_file", {
        tab,
        ref: refOf(intoField, /button "Attach"/),
        files: [
          { $result: note.id, name: "note.txt" },
          { $result: pdf.id, name: "copy.pdf", type: "application/x-pdf" },
        ],
      })
      expect(throughPicker.isError, textOf(throughPicker)).toBeUndefined()

      const notAField = await viaGateway("upload_file", {
        tab,
        ref: refOf(throughPicker, /heading "Upload"/),
        files: [{ $result: pdf.id }],
      })
      expect(notAField.isError).toBe(true)
      expect(textOf(notAField)).toContain("opened no file picker")

      // The page sends them only with its form.
      expect(api.requests.some((request) => request.method === "POST")).toBe(
        false,
      )
      const sent = await viaGateway("click", {
        tab,
        ref: refOf(throughPicker, /button "Send"/),
      })
      expect(textOf(sent)).toContain("Thank you")

      const post = api.requests.find((request) => request.method === "POST")!
      expect(post.body).toContain(
        'name="statement"; filename="statement.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4',
      )
      expect(post.body).toContain(
        'name="hidden"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nhello',
      )
      expect(post.body).toContain(
        'name="hidden"; filename="copy.pdf"\r\nContent-Type: application/x-pdf',
      )
    })

    it("lets a run_code program download a file and upload its handle, the bytes never in the program", async () => {
      const { token } = await createApiToken(ctx, {
        name: "Coder",
        allowAllServers: true,
        runCode: true,
      })
      const scope = {
        ...(await resolveApiToken(token))!,
        publicUrl: PUBLIC_URL,
      }
      await setFetchSite(
        ctx,
        scope.tokenId,
        new URL(api.origin).host,
        "allowed",
      )
      await setFetchPrivate(ctx, scope.tokenId, "allowed")

      for (const tool of browserTools()) {
        await writeToolAccess(scope.tokenId, server.id, tool.name, "allowed")
      }

      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
        serverSide,
      )
      const client = new Client({ name: "test", version: "1.0.0" })
      await client.connect(clientSide)

      try {
        const result = await client.callTool({
          name: "run_code",
          arguments: {
            code: `
const form = await pcp.call("browser", "tabs", { action: "open", url: "${api.origin}/form" })
const tab = form.match(/^Tab (\\S+):/m)[1]
const got = await pcp.call("browser", "download", { tab, url: "${api.origin}/invoice" })
await pcp.call("browser", "upload_file", { tab, target: { role: "button", name: "Statement" }, files: [got.file] })
const sent = await pcp.call("browser", "click", { tab, target: { role: "button", name: "Send" } })
return { file: got.file, sent: sent.includes("Thank you") }
`,
          },
        })
        const text = (result.content as Array<{ text?: string }>)
          .map((part) => part.text ?? "")
          .join("")
        expect(result.isError, text).toBeFalsy()

        const value = JSON.parse(text.split("It returned:\n")[1]!) as {
          file: { $result: string; name: string; type: string }
          sent: boolean
        }
        expect(value.sent).toBe(true)
        expect(value.file).toMatchObject({
          name: "invoice-42.pdf",
          type: "application/pdf",
        })
        expect(text).not.toContain("JVBERi0") // the PDF as base64

        const post = api.requests.find((request) => request.method === "POST")!
        expect(post.body).toContain(
          'name="statement"; filename="invoice-42.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4',
        )
      } finally {
        await client.close()
      }
    })

    it("moves a file between the browser and the assistant's own computer by link", async () => {
      const { token } = await createApiToken(ctx, {
        name: "Mover",
        allowAllServers: true,
        shareFiles: true,
      })
      const scope = {
        ...(await resolveApiToken(token))!,
        publicUrl: PUBLIC_URL,
      }
      await setFetchSite(
        ctx,
        scope.tokenId,
        new URL(api.origin).host,
        "allowed",
      )
      await setFetchPrivate(ctx, scope.tokenId, "allowed")

      for (const tool of browserTools()) {
        await writeToolAccess(scope.tokenId, server.id, tool.name, "allowed")
      }

      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
        serverSide,
      )
      const client = new Client({ name: "test", version: "1.0.0" })
      await client.connect(clientSide)
      const answer = (result: unknown) => {
        const parts = (result as { content: Array<{ text?: string }> }).content
        return parts.map((part) => part.text ?? "").join("\n")
      }
      const browser = async (tool: string, args: Record<string, unknown>) =>
        client.callTool({
          name: "call_tool",
          arguments: {
            call_handle: await describedHandle(client, "browser", tool),
            arguments: args,
          },
        })
      /** The secret at the end of a link, as the route takes it. */
      const secretOf = (url: string) => url.split("/").pop()!

      try {
        // In: a file from the assistant's computer, into the page's form.
        const receive = JSON.parse(
          answer(
            await client.callTool({
              name: "receive_file",
              arguments: { name: "scan.pdf" },
            }),
          ),
        ) as { url: string; result: { $result: string } }
        const sentByCurl = await uploadByLink(
          secretOf(receive.url),
          (async function* () {
            yield PDF
          })(),
          { contentType: null, contentLength: PDF.length },
        )
        expect(sentByCurl).toMatchObject({ ok: true, size: PDF.length })

        const form = answer(
          await browser("tabs", { action: "open", url: `${api.origin}/form` }),
        )
        const tab = tabOf(form)
        const ref = (name: string) =>
          form
            .split("\n")
            .find((line) => line.includes(`"${name}"`))!
            .match(/ref=(e\d+)/)![1]!
        const chose = await browser("upload_file", {
          tab,
          ref: ref("Statement"),
          files: [receive.result],
        })
        expect(chose.isError, answer(chose)).toBeFalsy()
        await browser("click", { tab, ref: ref("Send") })
        const post = api.requests.find((request) => request.method === "POST")!
        expect(post.body).toContain(
          'name="statement"; filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4',
        )

        // Out: a file the browser downloaded, onto the assistant's computer.
        const got = JSON.parse(
          answer(
            await browser("download", { tab, url: `${api.origin}/invoice` }),
          ),
        ) as { file: { $result: string }; note: string }
        expect(got.note).toContain("share_result")
        const shared = JSON.parse(
          answer(
            await client.callTool({
              name: "share_result",
              arguments: { id: got.file.$result },
            }),
          ),
        ) as { url: string; name: string; curl: string }
        expect(shared.name).toBe("invoice-42.pdf")
        const fetched = await downloadByLink(secretOf(shared.url))
        expect(fetched.ok && fetched.bytes.equals(PDF)).toBe(true)
      } finally {
        await client.close()
      }
    })
  },
)
