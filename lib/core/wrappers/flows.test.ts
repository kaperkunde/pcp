import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import { chromiumExecutable } from "../browser/executable"
import { closeAllBrowsers } from "../browser/runtime"
import { createBrowserServer } from "../browser/server"
import type { VaultContext } from "../context"
import { db } from "../db"
import {
  buildGatewayServer,
  loadGatewayServers,
  type GatewayScope,
} from "../gateway"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { setPacingSite } from "../pacing/config"
import { resetPacing, setPacingClock } from "../pacing/pace"
import { decidePermission } from "../permissions"
import { scratchDatabase } from "../test-db"
import { withCallHandle } from "../test-handles"
import { writeToolAccess } from "../tool-access"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchSite } from "../web-fetch"

// A browser flow end to end, against a real headless Chromium (skipped where
// there is none, as the browser's own tests are) and a chat thread served on
// a throwaway port: an assistant proposes the flow, the owner agrees, and it
// is called with call_tool and from run_code. It opens its own tab, checks
// the thread first, types and clicks by role and name, and confirms the
// message is there; called again, it finds the message and does nothing.

const executable = await chromiumExecutable()
const PUBLIC_URL = "http://pcp.test"

let cleanup: () => Promise<void>
let ctx: VaultContext
let api: TestApi
let scope: GatewayScope
let client: Client | null = null
let messages: string[]
let waits: number[]

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
}

beforeEach(async () => {
  resetPacing()
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  messages = []
  api = await startTestApi((request, res) => {
    const url = new URL(request.url ?? "/", "http://chat.test")

    if (url.pathname === "/send") {
      messages.push(url.searchParams.get("text") ?? "")
      res.statusCode = 302
      res.setHeader("location", "/thread")
      res.end()
      return
    }

    res.setHeader("content-type", "text/html; charset=utf-8")

    if (url.pathname === "/moved") {
      res.end("<title>Moved</title><h1>This thread has moved</h1>")
      return
    }

    res.end(
      `<title>Thread</title><h1>Thread</h1><ul>${messages.map((text) => `<li>${escape(text)}</li>`).join("")}</ul>` +
        `<form action="/send" method="get"><label>Message <input name="text"></label><button>Send</button></form>`,
    )
  })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
    manageWrappers: true,
    runCode: true,
  })
  scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  await createBrowserServer(ctx)
  await setFetchSite(ctx, scope.tokenId, new URL(api.origin).host, "allowed")
  await setFetchPrivate(ctx, scope.tokenId, "allowed")
})

afterEach(async () => {
  await client?.close()
  client = null
  await closeAllBrowsers()
  await api.close()
  await cleanup()
  setPacingClock(null)
  resetPacing()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await closeAllBrowsers()
})

async function call(name: string, args: Record<string, unknown>) {
  await client?.close()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
    serverSide,
  )
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  const result = await client.callTool({
    name,
    arguments: name === "call_tool" ? await withCallHandle(client, args) : args,
  })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return { isError: result.isError === true, text }
}

/** The flow, as an assistant writes it after posting once with the owner. */
const POST_MESSAGE = {
  name: "post_message",
  description:
    "Posts a message in the chat thread, unless it is there already. Answers {ok, url}, with already: true when it was.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The thread's address." },
      text: { type: "string", description: "The message." },
    },
    required: ["url", "text"],
  },
  outputSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      already: { type: "boolean" },
      url: { type: "string" },
    },
    required: ["ok", "url"],
  },
  program: `
    const opened = await pcp.step("open the thread", () =>
      pcp.call("browser", "tabs", { action: "open", url: args.url }))
    const tab = opened.match(/^Tab (\\S+):/m)[1]
    try {
      const before = await pcp.step("check the thread", () =>
        pcp.call("browser", "find", { tab, text: args.text }))
      if (before.total > 0) return { ok: true, already: true, url: args.url }

      await pcp.step("write it", () =>
        pcp.call("browser", "type", { tab, target: { role: "textbox", name: "Message" }, text: args.text }))
      await pcp.step("send it", () =>
        pcp.call("browser", "click", { tab, target: { role: "button", name: "Send" } }))
      await pcp.step("confirm it is in the thread", async () => {
        const after = await pcp.call("browser", "find", { tab, text: args.text })
        if (after.total === 0) throw new Error("the message is not in the thread")
      })
      return { ok: true, url: args.url }
    } finally {
      await pcp.call("browser", "tabs", { action: "close", tab })
    }
  `,
  calls: ["browser/tabs", "browser/find", "browser/type", "browser/click"],
}

async function approvedFlow() {
  const asked = await call("create_wrapper", {
    name: "Chat",
    description: "The chat thread, one call at a time.",
    tools: [POST_MESSAGE],
  })
  expect(asked.text).toContain("Not done yet")
  const row = await db().permissionRequest.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  })
  const decided = await decidePermission(ctx, row.id, "allow_once", {
    publicUrl: PUBLIC_URL,
  })
  expect(decided.isError).not.toBe(true)
  const wrapper = await db().mcpServer.findFirstOrThrow({
    where: { kind: "wrapper" },
  })
  await writeToolAccess(scope.tokenId, wrapper.id, "post_message", "allowed")
}

describe.skipIf(!executable)("a browser flow", { timeout: 90_000 }, () => {
  it("posts once by role and name, confirms it, and does nothing when it is there already", async () => {
    await approvedFlow()
    const args = {
      server: "chat",
      tool: "post_message",
      arguments: { url: `${api.origin}/thread`, text: "hello there" },
    }

    const first = await call("call_tool", args)
    expect(first.isError, first.text).toBe(false)
    expect(JSON.parse(first.text)).toEqual({
      ok: true,
      url: `${api.origin}/thread`,
    })
    expect(messages).toEqual(["hello there"])

    const again = await call("call_tool", args)
    expect(again.isError, again.text).toBe(false)
    expect(JSON.parse(again.text)).toEqual({
      ok: true,
      already: true,
      url: `${api.origin}/thread`,
    })
    expect(messages).toEqual(["hello there"])
  })

  it("is called from run_code, its actions paced by the site", async () => {
    vi.stubEnv("PCP_PACING", "on")
    waits = []
    let now = 1_000_000
    setPacingClock({
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms)
        now += ms
      },
      random: () => 0,
    })
    await setPacingSite(ctx, {
      site: new URL(api.origin).host,
      subdomains: false,
      pace: { minIntervalMs: 3_000, jitterMs: 0, burst: null },
    })
    await approvedFlow()

    const result = await call("run_code", {
      code: `
        const url = ${JSON.stringify(`${api.origin}/thread`)}
        const first = await pcp.call("chat", "post_message", { url, text: "from a program" })
        const second = await pcp.call("chat", "post_message", { url, text: "from a program" })
        return [first, second]
      `,
    })

    expect(result.isError, result.text).toBe(false)
    expect(JSON.parse(result.text.split("It returned:\n")[1]!)).toEqual([
      { ok: true, url: `${api.origin}/thread` },
      { ok: true, already: true, url: `${api.origin}/thread` },
    ])
    expect(messages).toEqual(["from a program"])
    // Each action on the site after the first waited its turn: the typing
    // after the page opened, the click, and the second call's opening (it
    // only reads after that).
    expect(waits).toEqual([3_000, 3_000, 3_000])
  })

  it("names the step that failed, on a page it did not expect", async () => {
    await approvedFlow()

    const result = await call("call_tool", {
      server: "chat",
      tool: "post_message",
      arguments: { url: `${api.origin}/moved`, text: "lost" },
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain("chat/post_message failed:")
    expect(result.text).toContain("failed at step 'write it'")
    expect(messages).toEqual([])
  })
})
