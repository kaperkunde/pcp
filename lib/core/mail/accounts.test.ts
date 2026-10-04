import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import { updateEndpoint } from "../endpoints"
import { buildInstructions, loadGatewayServers } from "../gateway"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { runCall } from "../permissions"
import { createSecret, deleteSecret, listSecrets } from "../secrets"
import { getServer, listServers, updateServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { readResult, resultKeeper } from "../tool-results"
import { callServerTool, syncServerTools } from "../upstream"
import { setupVault } from "../vault"
import { createMailAccount, updateMailAccount } from "./accounts"
import { createFakeJmap, type FakeJmap } from "./fake-jmap"

// Mail accounts end to end in the core: created by the owner, read and
// called through upstream.ts like any server, against an in-memory JMAP
// server on 127.0.0.1.

const PASSWORD = "app-password-1234"
const BASIC = `Basic ${Buffer.from(`ada@example.com:${PASSWORD}`).toString("base64")}`
const PUBLIC = { publicUrl: "http://localhost:3000" }

let cleanup: () => Promise<void>
let ctx: VaultContext
let api: TestApi
let fake: FakeJmap
let secretId: string

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ id: secretId } = await createSecret(ctx, {
    name: "Mail password",
    value: PASSWORD,
  }))
  fake = createFakeJmap({
    authorize: (header) => header === BASIC || header === "Bearer token-1",
  })
  api = await startTestApi((request, res) => {
    const answer = fake.handle(request)
    res.statusCode = answer?.status ?? 404
    res.setHeader("content-type", answer?.type ?? "text/plain")
    res.end(answer?.body ?? "")
  })
})

afterEach(async () => {
  await api.close()
  await cleanup()
})

async function account(
  overrides: Partial<Parameters<typeof createMailAccount>[1]> = {},
) {
  const { id } = await createMailAccount(ctx, {
    protocol: "jmap",
    name: "Mail",
    url: `${api.origin}/jmap/session`,
    readOnly: false,
    authType: "basic",
    authUsername: "ada@example.com",
    authSecretId: secretId,
    ...overrides,
  })
  return id
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.map((part) => part.text ?? "").join("")
}

describe("adding an account", () => {
  it("reads the session, keeps what it said, and lists the tools", async () => {
    const id = await account()
    const sync = await syncServerTools(ctx, await getServer(ctx, id), PUBLIC)

    expect(sync).toEqual({ status: "ok", message: "", toolCount: 10 })
    const row = await getServer(ctx, id)
    expect(row).toMatchObject({
      kind: "jmap",
      status: "ok",
      mailApiUrl: `${api.origin}/jmap/api`,
      mailAccountId: "acct-1",
      mailSubmission: true,
    })
    expect(fake.requests[0]!.authorization).toBe(BASIC)

    const [summary] = await listServers(ctx)
    expect(summary).toMatchObject({ kind: "jmap", toolCount: 10 })
    expect((await listSecrets(ctx))[0]!.usedBy).toEqual([{ id, name: "Mail" }])
    await expect(deleteSecret(ctx, secretId)).rejects.toThrow()
  })

  it("offers a read-only account the reading tools only", async () => {
    const id = await account({ readOnly: true })
    const sync = await syncServerTools(ctx, await getServer(ctx, id), PUBLIC)

    expect(sync.toolCount).toBe(6)
    expect(
      (await getServer(ctx, id)).tools.map((tool) => tool.name),
    ).not.toContain("send_email")
  })

  it("says when the credentials are refused or the server is gone", async () => {
    const { id: wrong } = await createSecret(ctx, {
      name: "Wrong",
      value: "nope-nope",
    })
    const id = await account({ authSecretId: wrong })

    expect(
      await syncServerTools(ctx, await getServer(ctx, id), PUBLIC),
    ).toMatchObject({
      status: "auth_required",
      toolCount: 0,
    })
    expect((await getServer(ctx, id)).statusMessage).toMatch(
      /refused the credentials/,
    )

    const gone = await account({ url: "http://127.0.0.1:9/jmap/session" })
    expect(
      await syncServerTools(ctx, await getServer(ctx, gone), PUBLIC),
    ).toMatchObject({
      status: "error",
    })
  })

  it("checks what the owner typed", async () => {
    await expect(account({ url: "ftp://mail.example.com" })).rejects.toThrow(
      /https/,
    )
    await expect(
      account({
        protocol: "imap",
        url: "imaps://mail.example.com",
        authType: "header",
      }),
    ).rejects.toThrow(/user name and password/)
    await expect(
      account({
        protocol: "imap",
        url: "imaps://mail.example.com",
        smtpUrl: "smtps://mail.example.com",
        authUsername: "ada",
      }),
    ).rejects.toThrow(/From address/)

    const imap = await account({
      protocol: "imap",
      url: "mail.example.com",
      smtpUrl: "smtp://mail.example.com",
    })
    expect(await getServer(ctx, imap)).toMatchObject({
      kind: "imap",
      url: "imaps://mail.example.com:993",
      smtpUrl: "smtp://mail.example.com:587",
    })
  })

  it("is changed in its own settings only", async () => {
    const id = await account()

    await expect(
      updateServer(ctx, id, {
        name: "x",
        url: "https://x.example.com",
        authType: "none",
      }),
    ).rejects.toThrow(/a mail account/)
    await expect(
      updateEndpoint(ctx, id, {
        name: "x",
        specSource: "url",
        specUrl: "https://x.example.com/openapi.json",
        readOnly: false,
        authType: "none",
      }),
    ).rejects.toThrow(/a mail account, not an API endpoint/)
  })

  it("forgets the session when the address changes, and the tokens when OAuth goes", async () => {
    const id = await account({
      authType: "oauth",
      authUsername: null,
      authSecretId: null,
    })
    const tokens = await db().secret.create({
      data: {
        id: "managed",
        vaultId: ctx.vaultId,
        name: `oauth/${id}`,
        kind: "oauth",
        ciphertext: Buffer.from("x"),
      },
    })
    await db().mcpServer.update({
      where: { id },
      data: {
        oauthTokensId: tokens.id,
        oauthConnectedAt: new Date(),
        mailApiUrl: "x",
        mailAccountId: "y",
      },
    })

    expect(
      await updateMailAccount(ctx, id, {
        name: "Mail",
        url: `${api.origin}/jmap/session`,
        readOnly: false,
        authType: "basic",
        authUsername: "ada@example.com",
        authSecretId: secretId,
      }),
    ).toEqual({ reconnect: true })
    const row = await getServer(ctx, id)
    expect(row).toMatchObject({
      oauthTokensId: null,
      oauthConnectedAt: null,
      mailApiUrl: null,
    })
    expect(
      await db().secret.findUnique({ where: { id: "managed" } }),
    ).toBeNull()
  })
})

describe("calling its tools", () => {
  async function ready(overrides?: Parameters<typeof account>[0]) {
    const id = await account(overrides)
    await syncServerTools(ctx, await getServer(ctx, id), PUBLIC)
    return getServer(ctx, id)
  }

  it("answers with JSON and structured content, with the password nowhere in it", async () => {
    const server = await ready()
    const result = await callServerTool(
      ctx,
      server,
      "search_emails",
      { limit: 2 },
      PUBLIC,
    )

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ total: 3, offset: 0 })
    expect(
      (result.structuredContent as { emails: unknown[] }).emails,
    ).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
    expect(fake.requests.at(-1)!.authorization).toBe(BASIC)
  })

  it("keeps a long body whole for read_result", async () => {
    const server = await ready()
    const { id: tokenId } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
      serverIds: [],
    })
    const keep = resultKeeper(ctx, tokenId)

    const result = await callServerTool(
      ctx,
      server,
      "get_email",
      { id: "e3" },
      { ...PUBLIC, keep },
    )
    const body = (
      result.structuredContent as {
        body: {
          text: string
          truncated: boolean
          result: { id: string; length: number }
        }
      }
    ).body

    expect(body.truncated).toBe(true)
    expect(body.text).toHaveLength(20_000)
    const whole = await readResult(ctx, {
      tokenId,
      id: body.result.id,
      offset: body.result.length - 14,
    })
    expect(whole.text).toBe("Yours, Charles")
  })

  it("reads a text attachment, and says what it will not read", async () => {
    const server = await ready()

    const csv = await callServerTool(
      ctx,
      server,
      "get_attachment",
      { id: "e1", attachment: "blob-csv" },
      PUBLIC,
    )
    expect(csv.structuredContent).toMatchObject({
      name: "parts.csv",
      text: "part,count\ncog,42\n",
    })

    const png = await callServerTool(
      ctx,
      server,
      "get_attachment",
      { id: "e1", attachment: "blob-png" },
      PUBLIC,
    )
    expect(png.isError).toBe(true)
    expect(textOf(png)).toMatch(/text attachments only/)
  })

  it("sends, and files the email in Sent", async () => {
    const server = await ready()
    const result = await callServerTool(
      ctx,
      server,
      "send_email",
      {
        to: ["Charles Babbage <charles@example.com>"],
        subject: "Hello",
        text: "Thursday?",
      },
      PUBLIC,
    )

    expect(result.structuredContent).toMatchObject({
      sent: { savedTo: "Sent", subject: "Hello" },
    })
    expect(fake.sent).toHaveLength(1)
  })

  it("refuses bad arguments before anything is sent", async () => {
    const server = await ready()
    const before = fake.requests.length

    await expect(
      callServerTool(ctx, server, "get_email", { id: "e1", extra: 1 }, PUBLIC),
    ).rejects.toMatchObject({ code: "validation" })
    await expect(
      callServerTool(
        ctx,
        server,
        "send_email",
        { to: ["a@b.c\r\nBcc: x@y.z"], subject: "", text: "" },
        PUBLIC,
      ),
    ).rejects.toMatchObject({ code: "validation" })
    expect(fake.requests.length).toBe(before)
  })

  it("refuses writing tools on a read-only account, whatever the catalogue says", async () => {
    const server = await ready({ readOnly: true })

    await expect(
      callServerTool(ctx, server, "delete_email", { id: "e1" }, PUBLIC),
    ).rejects.toMatchObject({ code: "forbidden" })
  })

  it("answers a request the server refuses as an error, and leaves the account's status alone", async () => {
    const server = await ready()
    const result = await callServerTool(
      ctx,
      server,
      "move_email",
      { id: "e1", mailbox: "Nowhere" },
      PUBLIC,
    )

    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/No mailbox called Nowhere/)
    expect((await getServer(ctx, server.id)).status).toBe("ok")
  })

  it("marks the account when its credentials stop working, or it cannot be reached", async () => {
    const server = await ready()
    fake = createFakeJmap({ authorize: () => false })

    await expect(
      callServerTool(ctx, server, "list_mailboxes", {}, PUBLIC),
    ).rejects.toMatchObject({ code: "unauthorized" })
    expect((await getServer(ctx, server.id)).status).toBe("auth_required")

    await api.close()
    await expect(
      callServerTool(ctx, server, "list_mailboxes", {}, PUBLIC),
    ).rejects.toMatchObject({ code: "upstream" })
    expect((await getServer(ctx, server.id)).status).toBe("error")
    api = await startTestApi()
  })

  it("is named in the gateway's instructions like any server", async () => {
    await ready()
    const { token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
      serverIds: [],
    })
    const scope = {
      ...(await resolveApiToken(token))!,
      publicUrl: PUBLIC.publicUrl,
    }
    const instructions = buildInstructions(await loadGatewayServers(scope))

    expect(instructions).toContain("MCP servers, APIs and mail accounts")
    expect(instructions).toContain("- mail: Mail (10 tools)")
  })
})

describe("OAuth", () => {
  it("needs connecting before anything reaches the server", async () => {
    const id = await account({
      authType: "oauth",
      authUsername: null,
      authSecretId: null,
    })
    const sync = await syncServerTools(ctx, await getServer(ctx, id), PUBLIC)

    expect(sync).toMatchObject({ status: "auth_required", toolCount: 0 })
    expect(sync.message).toMatch(/needs to be connected/)
    expect(fake.requests).toHaveLength(0)

    // The gateway answers with the connect panel instead.
    const { id: tokenId } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
      serverIds: [],
    })
    const result = await runCall(
      ctx,
      await getServer(ctx, id),
      "list_mailboxes",
      {},
      { ...PUBLIC, tokenId },
    )
    expect((result.structuredContent as { kind?: string }).kind).toBe("connect")
  })
})
