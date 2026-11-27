import http from "node:http"
import type { AddressInfo } from "node:net"

import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken, updateApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { resetGate } from "../gate/places"
import { loadGatewayServers } from "../gateway-servers"
import { buildGatewayServer, type GatewayScope } from "../gateway"
import { appendRequestLog } from "../request-log"
import { db } from "../db"
import { writeToolAccess } from "../tool-access"
import { createSecret } from "../secrets"
import { describedHandle, entryCall } from "../test-handles"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { getWrapper, saveWrapperByOwner } from "../wrappers/admin"
import { writeWebSearchConfig } from "./config"
import { forgetSearches } from "./search"

vi.mock("../request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

// web_search as an assistant meets it: the token's box, the owner's
// provider (a search server of their own, here a throwaway one), what is
// kept, what is refused, and the same tool called from a program and from a
// wrapper (#164).

const PUBLIC_URL = "http://localhost:3000"
const KEY = "searx-key-0123456789"

let cleanup: () => Promise<void>
let ctx: VaultContext
let client: Client | null = null
let search: http.Server
let origin: string
let hits: Array<{ url: string; authorization: string | undefined }>
let status = 200

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  forgetSearches()
  resetGate()
  hits = []
  status = 200
  vi.mocked(appendRequestLog).mockClear()
  search = http.createServer((request, response) => {
    hits.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
    })
    response.writeHead(status, { "content-type": "application/json" })
    response.end(
      status === 200
        ? JSON.stringify({
            results: [
              {
                title: "PCP",
                url: "https://pcp.example/",
                content: "A gateway",
                publishedDate: "2026-11-01",
              },
              { title: "Bad", url: "javascript:alert(1)", content: "x" },
            ],
          })
        : "{}",
    )
  })
  await new Promise<void>((resolve) => search.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(search.address() as AddressInfo).port}`
})

afterEach(async () => {
  await client?.close()
  client = null
  await new Promise((resolve) => search.close(resolve))
  await cleanup()
})

async function provider(withKey = false) {
  const secret = withKey
    ? await createSecret(ctx, { name: "Search key", value: KEY })
    : null

  await writeWebSearchConfig(ctx, {
    provider: "searxng",
    secretId: secret?.id ?? null,
    url: origin,
  })
}

/** The owner lets the token run the wrapper's one tool without asking. */
async function allowFind(tokenId: string) {
  await writeToolAccess(
    ctx,
    tokenId,
    (await db().mcpServer.findFirstOrThrow({ where: { kind: "wrapper" } })).id,
    "find",
    "allowed",
  )
}

async function connect(
  options: Parameters<typeof createApiToken>[1],
  setUp?: (tokenId: string) => Promise<void>,
): Promise<{ scope: GatewayScope; tokenId: string }> {
  const { id, token } = await createApiToken(ctx, options)
  const scope: GatewayScope = {
    ...(await resolveApiToken(token))!,
    publicUrl: PUBLIC_URL,
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()

  await setUp?.(id)
  await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
    serverSide,
  )
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return { scope, tokenId: id }
}

type Answer = {
  isError?: boolean
  content: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
}

async function call(name: string, args: Record<string, unknown>) {
  return (await client!.callTool(entryCall(name, args))) as Answer
}

const textOf = (answer: Answer) =>
  answer.content.map((part) => part.text ?? "").join("\n")

describe("web_search", () => {
  it("is for a token the owner ticked Search the web for, and only that", async () => {
    await connect({ name: "Plain", allowAllServers: true })

    const refused = await call("web_search", { query: "pcp" })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toMatch(/no tool of its own called web_search/)
  })

  it("answers with the owner's link to set a provider up when none is chosen", async () => {
    await connect({
      name: "Searcher",
      allowAllServers: true,
      builtinTools: ["web_search"],
    })

    const answer = await call("web_search", { query: "pcp" })

    expect(answer.structuredContent).toMatchObject({
      kind: "needs_owner",
      reason: "setup",
      url: `${PUBLIC_URL}/settings#web-search`,
    })
    expect(textOf(answer)).toContain(
      `[Set up web search in PCP](${PUBLIC_URL}/settings#web-search)`,
    )
    expect(hits).toEqual([])
  })

  it("searches through the owner's provider, sends the key as a header, and keeps the query out of the request log", async () => {
    await provider(true)
    await connect({
      name: "Searcher",
      allowAllServers: true,
      builtinTools: ["web_search"],
    })

    const answer = await call("web_search", {
      query: "a very private question",
      limit: 3,
      language: "EN",
      freshness: "week",
    })

    expect(answer.isError).toBeFalsy()
    expect(answer.structuredContent).toMatchObject({
      kind: "search_results",
      cached: false,
      results: [
        {
          title: "PCP",
          url: "https://pcp.example/",
          snippet: "A gateway",
          published: "2026-11-01",
        },
      ],
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.authorization).toBe(`Bearer ${KEY}`)
    expect(hits[0]!.url).toContain("language=en")
    expect(hits[0]!.url).toContain("time_range=week")
    // The key and the query stay out of the answer and the log.
    expect(JSON.stringify(answer)).not.toContain(KEY)
    const logged = JSON.stringify(vi.mocked(appendRequestLog).mock.calls)
    expect(logged).not.toContain("private question")
    expect(logged).toContain("web_search")
  })

  it("answers the same search again from memory, within the minute, and a changed one afresh", async () => {
    await provider()
    await connect({
      name: "Searcher",
      allowAllServers: true,
      builtinTools: ["web_search"],
    })

    await call("web_search", { query: "pcp" })
    const again = await call("web_search", { query: "pcp" })

    expect(again.structuredContent).toMatchObject({ cached: true })
    expect(hits).toHaveLength(1)

    await call("web_search", { query: "pcp", limit: 2 })
    expect(hits).toHaveLength(2)

    // A changed provider never answers from the old one's memory.
    await writeWebSearchConfig(ctx, {
      provider: "searxng",
      secretId: null,
      url: `${origin}/other`,
    })
    await call("web_search", { query: "pcp" })
    expect(hits).toHaveLength(3)
  })

  it("refuses a query past its bound or a region that is not two letters, before anything is sent", async () => {
    await provider()
    await connect({
      name: "Searcher",
      allowAllServers: true,
      builtinTools: ["web_search"],
    })

    for (const args of [
      { query: "x".repeat(401) },
      { query: "" },
      { query: "pcp", region: "netherlands" },
      { query: "pcp", limit: 21 },
      { query: "pcp", extra: true },
    ]) {
      const answer = await call("web_search", args)
      expect(answer.isError, JSON.stringify(args)).toBe(true)
    }

    expect(hits).toEqual([])
  })

  it("says so when the provider fails, and lets the place cool down when it asks PCP to slow down", async () => {
    await provider()
    await connect({
      name: "Searcher",
      allowAllServers: true,
      builtinTools: ["web_search"],
    })
    status = 429

    const first = await call("web_search", { query: "pcp" })
    expect(first.isError).toBe(true)
    expect(textOf(first)).toMatch(/too many searches/)

    // The place is cooling down: refused at once, nothing sent.
    const second = await call("web_search", { query: "other" })
    expect(second.isError).toBe(true)
    expect(JSON.stringify(second)).toContain("paced")
    expect(hits).toHaveLength(1)
  })
})

describe("a token's built-in tools", () => {
  it("are none unless ticked, and a token may reach no server when it has one", async () => {
    const plain = await createApiToken(ctx, {
      name: "Plain",
      allowAllServers: true,
    })
    expect((await resolveApiToken(plain.token))!.builtinTools).toEqual([])

    await expect(
      createApiToken(ctx, {
        name: "Nothing",
        allowAllServers: false,
        serverIds: [],
      }),
    ).rejects.toThrow(/at least one server or built-in tool/)

    const searchOnly = await createApiToken(ctx, {
      name: "Search only",
      allowAllServers: false,
      serverIds: [],
      builtinTools: ["web_search", "register_server"],
    })
    expect((await resolveApiToken(searchOnly.token))!.builtinTools).toEqual([
      "web_search",
    ])

    // Changing it later: kept when left out, and a token with no server
    // cannot lose its last one.
    await updateApiToken(ctx, searchOnly.id, {
      name: "Search only",
      allowAllServers: false,
      serverIds: [],
    })
    expect((await resolveApiToken(searchOnly.token))!.builtinTools).toEqual([
      "web_search",
    ])
    await expect(
      updateApiToken(ctx, searchOnly.id, {
        name: "Search only",
        allowAllServers: false,
        serverIds: [],
        builtinTools: [],
      }),
    ).rejects.toThrow(/at least one server or built-in tool/)
    await updateApiToken(ctx, searchOnly.id, {
      name: "Search only",
      allowAllServers: true,
      builtinTools: [],
    })
    expect((await resolveApiToken(searchOnly.token))!.builtinTools).toEqual([])
  })

  it("let a token that reaches no server search, and nothing else", async () => {
    await provider()
    await connect({
      name: "Search only",
      allowAllServers: false,
      serverIds: [],
      builtinTools: ["web_search"],
    })

    expect((await call("web_search", { query: "pcp" })).isError).toBeFalsy()
    const other = await call("read_image", { file: { $result: "x" } })
    // read_image is not one of its programs' tools, and is a tool of its
    // own for every token: it answers its own way, not with results.
    expect(other.structuredContent?.kind).not.toBe("search_results")
  })
})

describe("a program calling PCP's own tools", () => {
  it("calls web_search through run_read with the owner's box, as the token's own call", async () => {
    await provider()
    await connect({
      name: "Programs",
      allowAllServers: true,
      runCode: true,
      builtinTools: ["web_search"],
    })

    const answer = await call("run_read", {
      code: 'const r = await pcp.call("pcp", "web_search", { query: "pcp" }); return r.results.map((x) => x.title)',
    })

    expect(answer.isError).toBeFalsy()
    expect(textOf(answer)).toContain("PCP")
    expect(hits).toHaveLength(1)
    // The same line in the request log as execute's: tool by name, no query.
    const logged = vi
      .mocked(appendRequestLog)
      .mock.calls.map(([line]) => line.tool)
    expect(logged).toContain("web_search")
  })

  it("is refused, naming the token's setting, without the box", async () => {
    await provider()
    await connect({ name: "Programs", allowAllServers: true, runCode: true })

    const answer = await call("run_read", {
      code: 'try { await pcp.call("pcp", "web_search", { query: "pcp" }) } catch (e) { return e.message }',
    })

    expect(textOf(answer)).toMatch(
      /may not call pcp\/web_search.*Search the web.*Built-in tools/,
    )
    expect(hits).toEqual([])
  })

  it("is refused for a tool that is not one a program may call, however it is ticked", async () => {
    await connect({
      name: "Programs",
      allowAllServers: true,
      runCode: true,
      builtinTools: ["web_search"],
    })

    const answer = await call("run_read", {
      code: 'try { await pcp.call("pcp", "register_server", {}) } catch (e) { return e.message }',
    })

    expect(textOf(answer)).toMatch(
      /not one of PCP's own tools a program may call/,
    )
  })

  it("keeps a tool above the program's tier out, naming the entry that runs it", async () => {
    await connect({
      name: "Programs",
      allowAllServers: true,
      runCode: true,
      webFetch: true,
      builtinTools: ["web_fetch"],
    })

    const answer = await call("run_read", {
      code: 'try { await pcp.call("pcp", "web_fetch", { url: "https://example.com/" }) } catch (e) { return e.message }',
    })

    expect(textOf(answer)).toMatch(/above this program's tier.*run_destructive/)
  })

  it("is listed by pcp.tools only for the tools the owner ticked", async () => {
    await connect({
      name: "Programs",
      allowAllServers: true,
      runCode: true,
      builtinTools: ["web_search"],
    })

    const answer = await call("run_read", {
      code: 'const own = await pcp.tools("pcp"); return own.map((t) => t.name)',
    })

    expect(textOf(answer)).toContain("web_search")
    expect(textOf(answer)).not.toContain("web_fetch")
  })

  it("is what a wrapper's program calls as pcp/web_search, listed in its calls", async () => {
    await provider()
    const saveFinder = () =>
      saveWrapperByOwner(ctx, null, {
        name: "Finder",
        description: "Searches",
        tools: [
          {
            name: "find",
            description: "Find pages",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
              additionalProperties: false,
            },
            program:
              'const r = await pcp.call("pcp", "web_search", { query: args.q }); return r.results[0].url',
            calls: ["pcp/web_search"],
          },
        ],
      })
    await connect(
      { name: "Wrappers", allowAllServers: true, builtinTools: ["web_search"] },
      async (tokenId) => {
        await saveFinder()
        await allowFind(tokenId)
      },
    )

    const view = await getWrapper(ctx, { slug: "finder" })
    expect(view.tools[0]!.calls).toEqual(["pcp/web_search"])

    const handle = await describedHandle(client!, "finder", "find")
    const answer = (await client!.callTool({
      name: "execute_read",
      arguments: { call_handle: handle, arguments: { q: "pcp" } },
    })) as Answer

    expect(answer.isError).toBeFalsy()
    expect(textOf(answer)).toContain("https://pcp.example/")
    expect(hits).toHaveLength(1)
  })

  it("is refused for a token without the box, naming its setting, and a wrapper cannot name a tool a program may not call", async () => {
    await provider()
    await connect(
      { name: "No box", allowAllServers: true },
      async (tokenId) => {
        await saveWrapperByOwner(ctx, null, {
          name: "Finder",
          tools: [
            {
              name: "find",
              description: "Find pages",
              inputSchema: { type: "object", additionalProperties: false },
              program:
                'return await pcp.call("pcp", "web_search", { query: "x" })',
              calls: ["pcp/web_search"],
            },
          ],
        })
        await expect(
          saveWrapperByOwner(ctx, null, {
            name: "Admin",
            tools: [
              {
                name: "go",
                description: "No",
                inputSchema: { type: "object", additionalProperties: false },
                program: "return 1",
                calls: ["pcp/register_server"],
              },
            ],
          }),
        ).rejects.toThrow(/not one of PCP's own tools a program may call/)
        await expect(
          saveWrapperByOwner(ctx, null, {
            name: "Secret",
            tools: [
              {
                name: "go",
                description: "No",
                inputSchema: { type: "object", additionalProperties: false },
                program: "return 1",
                calls: ["pcp/web_search"],
              },
            ],
            secrets: [
              {
                secret: "Key",
                tool: "pcp/web_search",
                argument: "/query",
                template: "{secret}",
              },
            ],
          }),
        ).rejects.toThrow()
        await allowFind(tokenId)
      },
    )

    const handle = await describedHandle(client!, "finder", "find")
    const answer = (await client!.callTool({
      name: "execute_read",
      arguments: { call_handle: handle, arguments: {} },
    })) as Answer

    expect(answer.isError).toBe(true)
    expect(textOf(answer)).toMatch(
      /may not call pcp\/web_search.*Search the web.*Built-in tools/s,
    )
    expect(hits).toEqual([])
  })
})
