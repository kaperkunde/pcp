import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { buildGatewayServer, type GatewayScope } from "../gateway"
import { appendRequestLog } from "../request-log"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { undescribedProperties } from "./define"
import { ERROR_META_KEY } from "./outcome"

// PCP's own tools at /mcp, all of them, as a token the owner let do
// everything sees them: each on the common interface (define.ts).

vi.mock("../request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

const PUBLIC_URL = "http://localhost:3000"

/** Every one of PCP's own tools, for a token with every option on. */
const ALL_TOOLS = [
  "search",
  "list_tools",
  "describe",
  "call_tool",
  "call_read_only_tool",
  "check_permission",
  "withdraw_request",
  "check_server",
  "read_result",
  "share_result",
  "receive_file",
  "register_server",
  "propose_tool_access",
  "update_endpoint",
  "get_endpoint",
  "list_secrets",
  "get_wrapper",
  "create_wrapper",
  "update_wrapper",
  "delete_wrapper",
  "read_memory",
  "memory",
  "web_fetch",
  "run_code",
  "check_run",
]

/** Proposals: nothing happens until the owner agrees, and each is new. */
const PROPOSALS = [
  "register_server",
  "propose_tool_access",
  "create_wrapper",
  "update_wrapper",
  "delete_wrapper",
  "update_endpoint",
]

let cleanup: () => Promise<void>
let ctx: VaultContext
let client: Client

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  vi.mocked(appendRequestLog).mockClear()

  const { token } = await createApiToken(ctx, {
    name: "Everything",
    allowAllServers: true,
    manageEndpoints: true,
    keepMemories: true,
    webFetch: true,
    runCode: true,
    manageWrappers: true,
    shareFiles: true,
  })
  const scope: GatewayScope = {
    ...(await resolveApiToken(token))!,
    publicUrl: PUBLIC_URL,
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, [], {
    lookupHost: async () => ["203.0.113.7"],
  }).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
})

afterEach(async () => {
  await client.close()
  await cleanup()
})

describe("PCP's own tools", () => {
  it("are these, and no longer the old search_tools and describe_tool", async () => {
    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual([...ALL_TOOLS].sort())
  })

  it("describe every argument, and take no key they do not list", async () => {
    const { tools } = await client.listTools()

    for (const tool of tools) {
      const schema = tool.inputSchema as Record<string, unknown>

      expect(undescribedProperties(schema), tool.name).toEqual([])
      expect(schema.type, tool.name).toBe("object")
      expect(schema.additionalProperties, tool.name).toBe(false)
      expect(schema.$schema, tool.name).toBeUndefined()
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/)
      expect(tool.title, tool.name).toBeTruthy()
    }
  })

  it("set every annotation, proposals as neither destructive nor idempotent", async () => {
    const { tools } = await client.listTools()

    for (const tool of tools) {
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name} ${hint}`).toBe(
          "boolean",
        )
      }
    }

    for (const name of PROPOSALS) {
      const tool = tools.find((each) => each.name === name)!

      expect(tool.annotations, name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      })
    }

    expect(
      tools.find((tool) => tool.name === "withdraw_request")!.annotations,
    ).toMatchObject({ destructiveHint: false, idempotentHint: true })
  })

  it("declare an output schema where every answer is one shape, and the owner's wait in it", async () => {
    const { tools } = await client.listTools()
    const structured = tools
      .filter((tool) => tool.outputSchema)
      .map((tool) => tool.name)
      .sort()

    expect(structured).toEqual(
      [
        "check_permission",
        "check_server",
        "create_wrapper",
        "delete_wrapper",
        "get_endpoint",
        "get_wrapper",
        "list_secrets",
        "propose_tool_access",
        "receive_file",
        "register_server",
        "share_result",
        "update_endpoint",
        "update_wrapper",
      ].sort(),
    )

    for (const tool of tools.filter((each) => each.outputSchema)) {
      expect(tool.outputSchema!.type, tool.name).toBe("object")
    }

    for (const name of PROPOSALS) {
      expect(
        JSON.stringify(tools.find((tool) => tool.name === name)!.outputSchema),
        name,
      ).toContain("needs_owner")
    }
  })

  it("keep run_code's and register_server's own descriptions short", async () => {
    const { tools } = await client.listTools()
    const length = (name: string) =>
      tools.find((tool) => tool.name === name)!.description!.length

    expect(length("run_code")).toBeLessThan(3_000)
    expect(length("register_server")).toBeLessThan(2_500)
  })

  it("take the new argument names, and the old ones for one release", async () => {
    const { tools } = await client.listTools()
    const keys = (name: string) =>
      Object.keys(
        tools.find((tool) => tool.name === name)!.inputSchema.properties ?? {},
      )

    expect(keys("update_endpoint")).toEqual(
      expect.arrayContaining([
        "add_patches",
        "refresh_spec",
        "base_url",
        "read_only",
        "tool_descriptions",
      ]),
    )
    expect(keys("get_endpoint")).toEqual(
      expect.arrayContaining([
        "include_spec",
        "include_patches",
        "spec_pointer",
        "include_problems",
      ]),
    )
    expect(keys("update_wrapper")).toEqual(
      expect.arrayContaining(["call_levels", "remove_tools"]),
    )

    const old = await client.callTool({
      name: "get_endpoint",
      arguments: { endpoint: "nowhere", includeSpec: true },
    })
    const content = old.content as Array<{ text: string }>

    expect(content[0]!.text).toBe(
      "includeSpec was renamed to include_spec; use include_spec.",
    )
    expect(old.isError).toBe(true)
    expect(content.at(-1)!.text).toMatch(/No API endpoint called nowhere/)
  })

  it("refuse arguments that do not fit as a tool error, logged by name only", async () => {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "mail", limit: 500, colour: "blue" },
    })
    const text = (result.content as Array<{ text: string }>)[0]!.text

    expect(result.isError).toBe(true)
    expect(result._meta?.[ERROR_META_KEY]).toEqual({
      code: "invalid_arguments",
    })
    expect(text).toContain(
      '"limit" is 500, but the inputSchema says at most 50.',
    )
    expect(text).toContain(
      '"colour" is not an argument of this tool (it takes: query, server, kind, limit).',
    )
    expect(appendRequestLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "search",
        ok: false,
        error: "The arguments did not fit the tool's input schema.",
      }),
    )
    expect(
      JSON.stringify(vi.mocked(appendRequestLog).mock.calls),
    ).not.toContain("colour")
  })

  it("answer check_permission and check_server in the shapes they declare", async () => {
    const asked = await client.callTool({
      name: "register_server",
      arguments: { name: "Linear", url: "https://mcp.linear.example/mcp" },
    })
    const owner = asked.structuredContent as { request: string; url: string }

    expect(asked.structuredContent).toMatchObject({
      kind: "needs_owner",
      reason: "permission",
      url: expect.stringContaining(`${PUBLIC_URL}/permissions/`),
    })
    const texts = (asked.content as Array<{ text: string }>).map((p) => p.text)
    expect(texts.at(-1)!.trimEnd().split("\n").at(-1)).toBe(
      `[Add the server Linear?](${owner.url})`,
    )
    expect(asked.structuredContent).toMatchObject({
      label: "Add the server Linear?",
    })

    const open = await client.callTool({
      name: "check_permission",
      arguments: {},
    })
    expect(open.structuredContent).toMatchObject({
      kind: "requests",
      requests: [{ id: owner.request, kind: "register", url: owner.url }],
    })

    await client.callTool({
      name: "withdraw_request",
      arguments: { id: owner.request },
    })
    const settled = await client.callTool({
      name: "check_permission",
      arguments: { id: owner.request },
    })
    expect(settled.structuredContent).toEqual({
      kind: "done",
      request: owner.request,
      status: "withdrawn",
    })

    const unknown = await client.callTool({
      name: "check_server",
      arguments: { server: "nowhere" },
    })
    expect(unknown.isError).toBe(true)
    expect(unknown._meta?.[ERROR_META_KEY]).toEqual({ code: "not_found" })
  })
})
