import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createCalendarAccount } from "../caldav/accounts"
import { createFakeCalDav, type FakeCalDav } from "../caldav/fake-caldav"
import type { VaultContext } from "../context"
import { createEndpoint } from "../endpoints"
import { callMailTool, createMailAccount } from "../mail/accounts"
import { dropMailSession } from "../mail/imap-pool"
import type { ImapClientLike, ImapDeps } from "../mail/imap"
import { createFakeJmap, type FakeJmap } from "../mail/fake-jmap"
import { json, startTestApi, type TestApi } from "../openapi/test-api"
import { createSecret } from "../secrets"
import { getServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { errorCodeOf } from "../tools/outcome"
import { callServerTool, syncServerTools } from "../upstream"
import { setupVault } from "../vault"
import { gateServerCall } from "./index"
import { resetGate } from "./state"
import { writeServerLimits } from "./store"

// A server's own time limit reaches each kind's own requests (#143): an API
// endpoint's, a calendar account's and a mail account's (JMAP requests, an
// IMAP connection and the wait for a pooled one). Each kind's constant is
// lowered here to half a second, so a limit raised past it is seen to be
// the one the request used; a limit below how long the server takes is
// answered as `timeout`, naming the server.

vi.mock("../openapi/limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../openapi/limits")>()),
  CALL_TIMEOUT_MS: 500,
}))
vi.mock("../caldav/limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../caldav/limits")>()),
  DAV_CALL_TIMEOUT_MS: 500,
}))
vi.mock("../mail/limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mail/limits")>()),
  MAIL_CALL_TIMEOUT_MS: 500,
}))

const PUBLIC = { publicUrl: "http://localhost:3000" }
const PASSWORD = "abcd-efgh-ijkl-mnop"
const BASIC = `Basic ${Buffer.from(`ada@example.com:${PASSWORD}`).toString("base64")}`

let cleanup: () => Promise<void>
let ctx: VaultContext
let api: TestApi
let secretId: string
/** How long every answer waits, once the account is set up. */
let delayMs: number
let jmap: FakeJmap
let dav: FakeCalDav

beforeEach(async () => {
  resetGate()
  delayMs = 0
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ id: secretId } = await createSecret(ctx, {
    name: "Password",
    value: PASSWORD,
  }))
  jmap = createFakeJmap({ authorize: (header) => header === BASIC })
  dav = createFakeCalDav({ base: "/dav", authorize: (h) => h === BASIC })
  dav.addCalendar({ id: "home", name: "Home", components: ["VEVENT"] })
  api = await startTestApi((request, res) => {
    const answer = () => {
      if (request.url.startsWith("/api/")) {
        return json(res, 200, { ok: true })
      }

      const found = request.url.startsWith("/dav")
        ? dav.handle({
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
          })
        : jmap.handle(request)
      res.statusCode = found?.status ?? 404
      for (const [name, value] of Object.entries(
        (found as { headers?: Record<string, string> } | null)?.headers ?? {},
      )) {
        res.setHeader(name, value)
      }
      res.setHeader("content-type", found?.type ?? "text/plain")
      res.end(found?.body ?? "")
    }

    setTimeout(answer, delayMs)
  })
})

afterEach(async () => {
  await api.close()
  await cleanup()
  resetGate()
})

function failure(result: CallToolResult): string {
  return result.content
    .map((part) => ("text" in part ? part.text : ""))
    .join("")
}

/** A call that goes through, or the error it gives. */
async function attempt(
  run: () => Promise<CallToolResult>,
): Promise<{ ok: true } | { error: string; code?: string }> {
  try {
    const result = await run()
    return result.isError
      ? { error: failure(result), code: errorCodeOf(result) }
      : { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function endpoint() {
  const { id } = await createEndpoint(ctx, {
    name: "Things",
    specSource: "upload",
    specText: JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Things", version: "1" },
      servers: [{ url: `${api.origin}/api` }],
      paths: {
        "/slow": {
          get: {
            operationId: "slow",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    }),
    readOnly: false,
    authType: "none",
  })
  return id
}

async function calendar() {
  const { id } = await createCalendarAccount(ctx, {
    name: "Calendar",
    url: `${api.origin}/dav/`,
    readOnly: false,
    authType: "basic",
    authUsername: "ada@example.com",
    authSecretId: secretId,
  })
  await syncServerTools(ctx, await getServer(ctx, id), PUBLIC)
  return id
}

async function jmapAccount() {
  const { id } = await createMailAccount(ctx, {
    protocol: "jmap",
    name: "Mail",
    url: `${api.origin}/jmap/session`,
    readOnly: false,
    authType: "basic",
    authUsername: "ada@example.com",
    authSecretId: secretId,
  })
  await syncServerTools(ctx, await getServer(ctx, id), PUBLIC)
  return id
}

describe.each([
  { kind: "an API endpoint", make: endpoint, tool: "slow" },
  { kind: "a calendar account", make: calendar, tool: "list_calendars" },
  { kind: "a JMAP mail account", make: jmapAccount, tool: "list_mailboxes" },
])("$kind's own time limit", ({ make, tool }) => {
  it("lets a request take as long as a raised limit, past the kind's own default", async () => {
    const id = await make()
    delayMs = 1_000
    const call = async () =>
      callServerTool(ctx, await getServer(ctx, id), tool, {}, PUBLIC)

    // The kind's own default (half a second here) stops it…
    const first = await attempt(call)
    expect(first).toMatchObject({ error: expect.any(String) })

    // …and a limit raised past it lets it finish.
    resetGate()
    await writeServerLimits(ctx, id, { timeoutMs: 5_000 })
    expect(await attempt(call)).toEqual({ ok: true })
  })

  it("answers timeout, naming the server, under a lowered one", async () => {
    const id = await make()
    await writeServerLimits(ctx, id, { timeoutMs: 1_000 })
    delayMs = 2_500
    const server = await getServer(ctx, id)

    expect(
      await attempt(() => callServerTool(ctx, server, tool, {}, PUBLIC)),
    ).toMatchObject({
      code: "timeout",
      error: expect.stringContaining(
        `${server.name} did not answer within 1 s`,
      ),
    })
  })
})

describe("an IMAP mail account's own time limit", () => {
  async function imapAccount() {
    const { id } = await createMailAccount(ctx, {
      protocol: "imap",
      name: "Mail",
      url: "imaps://mail.example.com",
      smtpUrl: null,
      readOnly: false,
      authType: "basic",
      authUsername: "ada@example.com",
      authSecretId: secretId,
    })
    return id
  }

  function imapDeps(listMs: number, opened: number[]): ImapDeps {
    const client = {
      secureConnection: true,
      usable: true,
      capabilities: new Map([["IMAP4rev1", true]]),
      async logout() {},
      close() {},
      async noop() {},
      async list() {
        await new Promise((resolve) => setTimeout(resolve, listMs))
        return [
          {
            path: "INBOX",
            name: "INBOX",
            delimiter: "/",
            parentPath: "",
            flags: new Set<string>(),
            specialUse: "\\Inbox",
          },
        ]
      },
      async status() {
        return { messages: 0, unseen: 0 }
      },
      async getMailboxLock(path: string) {
        return { path, release() {} }
      },
    }

    return {
      connect: async (_address, _login, options) => {
        opened.push(options?.socketTimeoutMs ?? 0)
        return client as unknown as ImapClientLike
      },
      smtp: async () => {
        throw new Error("no sending here")
      },
      compose: async () => Buffer.from(""),
      sleep: async () => {},
    }
  }

  const credential = (timeoutMs?: number) => ({
    headers: {},
    login: { username: "ada@example.com", password: PASSWORD },
    redact: [PASSWORD],
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })

  it("opens its connection to wait at least as long as a raised limit", async () => {
    const id = await imapAccount()
    const opened: number[] = []

    const result = await callMailTool(
      ctx,
      await getServer(ctx, id),
      "list_mailboxes",
      {},
      { credential: credential(120_000), imap: imapDeps(0, opened) },
    )

    expect(result.isError).not.toBe(true)
    expect(opened).toEqual([120_000])
    dropMailSession(id)
  })

  it("answers timeout through the gate under a lowered one", async () => {
    const id = await imapAccount()
    await writeServerLimits(ctx, id, { timeoutMs: 1_000 })
    const server = await getServer(ctx, id)
    const opened: number[] = []

    const result = await gateServerCall(
      ctx,
      server,
      "list_mailboxes",
      {},
      (timeoutMs) =>
        callMailTool(
          ctx,
          server,
          "list_mailboxes",
          {},
          {
            credential: credential(timeoutMs),
            imap: imapDeps(2_500, opened),
          },
        ),
    )

    expect(errorCodeOf(result)).toBe("timeout")
    expect(failure(result)).toContain("Mail did not answer within 1 s")
    // Its connection waits as long as the limit (and never less than the
    // kind's own); the gate answers at the limit.
    expect(opened).toEqual([1_000])
    dropMailSession(id)
  })
})
