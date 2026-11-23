import { randomUUID } from "node:crypto"

import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { createEndpoint } from "./endpoints"
import { PcpError } from "./errors"
import {
  buildGatewayServer,
  loadGatewayServers,
  type GatewayScope,
} from "./gateway"
import {
  forgetKeptMasks,
  keptMasker,
  MIN_KEPT_MASK_CHARS,
  passOnlyTracker,
} from "./kept-masks"
import { json, startTestApi, type TestApi } from "./openapi/test-api"
import { runCall, runCodeCall, type PermissionExecutor } from "./permissions"
import { resolveHandles } from "./result-handles"
import { createServer, getServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { describedHandle } from "./test-handles"
import { writeToolAccess } from "./tool-access"
import { keepResult, resultOpener } from "./tool-results"
import { setupVault } from "./vault"

// A pass-only kept result (#149) is not read out through a tool that hands
// its value back (#158): not in the call that was handed it, and not in any
// later answer to the token while the result lives.

const PUBLIC = { publicUrl: "http://localhost:3000" }
const TOKEN_VALUE = "tok_8f3KdPq2ZxW91mLr"

let cleanup: () => Promise<void>
let ctx: VaultContext
let tokenId: string

async function passOnly(text = TOKEN_VALUE, forToken = tokenId) {
  return (
    await keepResult(ctx, {
      tokenId: forToken,
      serverId: null,
      toolName: "make_token",
      text,
      mediaType: "text/plain",
      passOnly: true,
    })
  ).id
}

function textOf(result: { content?: unknown }): string {
  return ((result.content ?? []) as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("\n")
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  forgetKeptMasks()
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
  await cleanup()
})

describe("the call that was handed a pass-only value", () => {
  it("takes it out of the answer, as it is and as JSON writes it", async () => {
    const value = 'line one "quoted"\nline two'
    const id = await passOnly(value)
    const tracked = passOnlyTracker(resultOpener(ctx, tokenId))
    const sent = await resolveHandles({ text: { $result: id } }, tracked.open!)
    expect(sent.text).toBe(value)

    const answer = tracked.scrub({
      content: [
        { type: "text", text: `You said: ${value}` },
        { type: "text", text: JSON.stringify({ echo: value }) },
      ],
      structuredContent: { echo: value },
    })

    expect(textOf(answer)).not.toContain("line two")
    expect(textOf(answer)).toContain(`[kept: ${id}]`)
    expect(answer.structuredContent).toEqual({ echo: `[kept: ${id}]` })
  })

  it("takes it out of an error's message, and leaves an ordinary result alone", async () => {
    const id = await passOnly()
    const plain = (
      await keepResult(ctx, {
        tokenId,
        serverId: null,
        toolName: "get_email",
        text: "an ordinary long text",
        mediaType: "text/plain",
      })
    ).id
    const tracked = passOnlyTracker(resultOpener(ctx, tokenId))
    await resolveHandles(
      { a: { $result: id }, b: { $result: plain } },
      tracked.open!,
    )

    const error = tracked.scrubError(
      new PcpError(
        "upstream",
        `Invalid key ${TOKEN_VALUE} (an ordinary long text)`,
      ),
    ) as PcpError

    expect(error).toBeInstanceOf(PcpError)
    expect(error.code).toBe("upstream")
    expect(error.message).toBe(
      `Invalid key [kept: ${id}] (an ordinary long text)`,
    )
  })
})

describe("an endpoint that echoes what it was sent", () => {
  let api: TestApi

  beforeEach(async () => {
    api = await startTestApi((request, res) => {
      if (request.body.includes("fail")) {
        res.statusCode = 400
        res.setHeader("content-type", "text/plain")
        res.end(`Refused: ${request.body}`)
        return
      }

      json(res, 200, { received: JSON.parse(request.body || "{}") })
    })
  })

  afterEach(async () => {
    await api.close()
  })

  async function echo() {
    const { id } = await createEndpoint(ctx, {
      name: "Echo",
      specSource: "upload",
      specText: JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Echo" },
        servers: [{ url: `${api.origin}/api` }],
        paths: {
          "/echo": {
            post: {
              operationId: "echo",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        token: { type: "string" },
                        mode: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      readOnly: false,
      authType: "none",
    })

    return getServer(ctx, id)
  }

  it("is sent the value, and its answer shows [kept: id] instead", async () => {
    const id = await passOnly()
    const answer = await runCall(
      ctx,
      await echo(),
      "echo",
      { body: { token: { $result: id }, mode: "ok" } },
      { ...PUBLIC, tokenId },
    )

    expect(api.requests[0]!.body).toContain(TOKEN_VALUE)
    expect(answer.isError).not.toBe(true)
    expect(JSON.stringify(answer)).not.toContain(TOKEN_VALUE)
    expect(textOf(answer)).toContain(`[kept: ${id}]`)
  })

  it("shows [kept: id] in an error that is not JSON", async () => {
    const id = await passOnly()
    const answer = await runCall(
      ctx,
      await echo(),
      "echo",
      { body: { token: { $result: id }, mode: "fail" } },
      { ...PUBLIC, tokenId },
    )

    expect(answer.isError).toBe(true)
    expect(textOf(answer)).toContain("Refused")
    expect(JSON.stringify(answer)).not.toContain(TOKEN_VALUE)
    expect(textOf(answer)).toContain(`[kept: ${id}]`)
  })
})

describe("every later answer to the token, while the result lives", () => {
  let scope: GatewayScope
  let serverId: string
  let says: string

  const executor: PermissionExecutor = {
    // Another tool, handed no handle, that answers the value back.
    callTool: async (): Promise<CallToolResult> => ({
      content: [{ type: "text", text: says }],
    }),
    syncTools: async () => ({ status: "ok", message: "", toolCount: 0 }),
  }

  beforeEach(async () => {
    ;({ id: serverId } = await createServer(ctx, {
      name: "Notes",
      url: "https://notes.example.com/mcp",
      authType: "none",
    }))
    await db().mcpTool.create({
      data: {
        id: randomUUID(),
        serverId,
        plainName: "show_note",
        plainDescription: "show_note shows a note.",
        plainInputSchema: JSON.stringify({ type: "object" }),
        annotations: JSON.stringify({ readOnlyHint: true }),
      },
    })
    const { token, id } = await createApiToken(ctx, {
      name: "Echoing",
      allowAllServers: true,
    })
    tokenId = id
    await writeToolAccess(ctx, tokenId, serverId, "show_note", "allowed")
    scope = { ...(await resolveApiToken(token))!, ...PUBLIC }
  })

  async function connect(): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, await loadGatewayServers(scope), {
      executor,
    }).connect(serverSide)
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
    return client
  }

  async function showNote(): Promise<string> {
    const client = await connect()
    const handle = await describedHandle(client, "notes", "show_note")
    const result = await client.callTool({
      name: "execute_read",
      arguments: { call_handle: handle, arguments: {} },
    })

    return textOf(result)
  }

  it("shows the value as [kept: id], also written another way", async () => {
    const id = await passOnly()

    says = `Your note: ${TOKEN_VALUE}.`
    expect(await showNote()).toBe(`Your note: [kept: ${id}].`)

    // Spaced out and upper-cased, as a page or an API may write it.
    says = `Your note: ${TOKEN_VALUE.toUpperCase()
      .match(/.{1,4}/g)!
      .join(" ")} end`
    expect(await showNote()).toBe(`Your note: [kept: ${id}] end`)
  })

  it(`leaves a value shorter than ${MIN_KEPT_MASK_CHARS} characters alone`, async () => {
    await passOnly("abc1234")
    says = "Your note: abc1234"

    expect(await showNote()).toBe("Your note: abc1234")
  })

  it("stops once the result has expired", async () => {
    const id = await passOnly()
    says = `Your note: ${TOKEN_VALUE}`
    expect(await showNote()).toBe(`Your note: [kept: ${id}]`)

    await db().toolResult.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    })

    expect(await showNote()).toBe(`Your note: ${TOKEN_VALUE}`)
  })

  it("is masked for that token only", async () => {
    const { id: other } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
    })
    await passOnly(TOKEN_VALUE, other)
    says = `Your note: ${TOKEN_VALUE}`

    expect(await showNote()).toBe(`Your note: ${TOKEN_VALUE}`)
    expect(await keptMasker(ctx, tokenId)).toBeNull()
  })

  it("reaches a program's pcp.call too, its value and its errors", async () => {
    const id = await passOnly()
    const server = await getServer(ctx, serverId)
    says = JSON.stringify({ note: TOKEN_VALUE })

    const outcome = await runCodeCall(
      ctx,
      server,
      "show_note",
      {},
      {
        ...PUBLIC,
        tokenId,
        max: 10_000,
        executor,
      },
    )

    expect(outcome).toEqual({ ok: true, value: { note: `[kept: ${id}]` } })

    const failing: PermissionExecutor = {
      ...executor,
      callTool: async () => {
        throw new PcpError("upstream", `Bad note ${TOKEN_VALUE}`)
      },
    }
    const failed = await runCodeCall(
      ctx,
      server,
      "show_note",
      {},
      {
        ...PUBLIC,
        tokenId,
        max: 10_000,
        executor: failing,
      },
    )

    expect(failed).toMatchObject({ ok: false, error: `Bad note [kept: ${id}]` })
  })
})
