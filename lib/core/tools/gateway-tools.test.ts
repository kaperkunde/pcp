import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { requestClient } from "../client-hello"
import { detectClient } from "../clients/detect"
import type { ClientProfileId } from "../clients/profiles"
import {
  buildGatewayServer,
  MEMORY_REMINDER,
  MIRRORED_LEAD,
  ownNameNote,
  ownToolsOf,
  retiredNote,
  STANDING_LEAD,
  type GatewayScope,
} from "../gateway"
import { db } from "../db"
import { decidePermission } from "../permissions"
import { appendRequestLog } from "../request-log"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { undescribedProperties, type Tool } from "./define"
import { ERROR_META_KEY } from "./outcome"
import { entryCall } from "../test-handles"

// PCP's own tools at /mcp, all of them, as a token the owner let do
// everything sees them: each on the common interface (define.ts).

vi.mock("../request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

const PUBLIC_URL = "http://localhost:3000"

/** What a client lists (#113): the entries, for a token with every option on. */
const LISTED = [
  "search",
  "execute_read",
  "execute_write",
  "execute_destructive",
  "run_read",
  "run_write",
  "run_destructive",
]

/**
 * Every one of PCP's own tools behind them, which execute_<tier> runs by
 * name, for a token with every option on.
 */
const OWN_TOOLS = [
  "list_tools",
  "check_permission",
  "withdraw_request",
  "check_server",
  "read_result",
  "share_result",
  "receive_file",
  "create_upload_link",
  "check_upload",
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
  "check_run",
  "read_image",
  "view_image",
  "convert_document",
  "edit_pdf",
  // PCP's own store, and the others by store (#90).
  "list_folder",
  "find_files",
  "get_file",
  "share_file",
  "save_file",
  "make_folder",
  "move",
  "delete",
]

/** A tool as a client lists it, or as PCP keeps one of its own. */
type Described = {
  name: string
  title?: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

/** One of PCP's own tools, as listTools would publish it. */
function described(tool: Tool): Described {
  const output = tool.output ? tool.outputSchema() : undefined

  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema() as Record<string, unknown>,
    ...(output ? { outputSchema: output as Record<string, unknown> } : {}),
    annotations: tool.annotations as Record<string, unknown>,
  }
}

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
/** The entries a client lists and PCP's own tools behind them. */
let everyTool: Described[]

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
  const gateway = buildGatewayServer(scope, [], {
    lookupHost: async () => ["203.0.113.7"],
  })
  await gateway.connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  everyTool = [
    ...((await client.listTools()).tools as Described[]),
    ...ownToolsOf(gateway).map(described),
  ]
})

afterEach(async () => {
  await client.close()
  await cleanup()
})

describe("PCP's own tools", () => {
  it("are listed as the seven entries alone, search first, the rest behind them (#113)", async () => {
    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(LISTED)
    expect(everyTool.map((tool) => tool.name).sort()).toEqual(
      [...LISTED, ...OWN_TOOLS].sort(),
    )
    // Each entry says what it runs, honestly: Read only reads.
    expect(
      tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint]),
    ).toEqual([
      ["search", true],
      ["execute_read", true],
      ["execute_write", false],
      ["execute_destructive", false],
      ["run_read", true],
      ["run_write", false],
      ["run_destructive", false],
    ])
    expect(
      tools
        .filter((tool) => tool.annotations?.destructiveHint)
        .map((tool) => tool.name),
    ).toEqual(["execute_destructive", "run_destructive"])
  })

  it("describe every argument, and take no key they do not list", async () => {
    const tools = everyTool

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
    const tools = everyTool

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
    const tools = everyTool
    const structured = tools
      .filter((tool) => tool.outputSchema)
      .map((tool) => tool.name)
      .sort()

    expect(structured).toEqual(
      [
        "check_permission",
        "check_server",
        "check_upload",
        "convert_document",
        "create_upload_link",
        "create_wrapper",
        "delete_wrapper",
        "edit_pdf",
        "get_endpoint",
        "get_wrapper",
        "list_secrets",
        "propose_tool_access",
        "read_image",
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

  it("say to check on the owner's next message, never to wait until they say they answered (#59)", async () => {
    const tools = everyTool

    for (const tool of tools) {
      expect(tool.description, tool.name).not.toMatch(
        /says? they (have|are)|once they have answered/,
      )
    }

    for (const name of [
      "execute_read",
      "check_permission",
      "check_server",
      "create_upload_link",
      "check_upload",
      "propose_tool_access",
      "update_endpoint",
      "create_wrapper",
      "update_wrapper",
      "delete_wrapper",
    ]) {
      expect(
        tools.find((tool) => tool.name === name)!.description,
        name,
      ).toMatch(/next message[^.]*whatever it says/)
    }
  })

  it("open each description with a verb and what it acts on, in the words a deferred list shows", async () => {
    // Claude's apps show some 25 characters of a deferred tool's
    // description after the connector's name (observed 2026-11-02).
    const tools = everyTool
    const opening = (name: string) =>
      tools.find((tool) => tool.name === name)!.description!.slice(0, 25)

    for (const tool of tools) {
      const first = tool.description!.slice(0, 25)

      expect(first, tool.name).toMatch(
        /^(Check first: |(Search|List|Get|Execute|Run|Check|Withdraw|Read|Share|Receive|Propose|Change|Fetch|Save|Edit|Convert|Find|Make|Move|Delete|View) )/,
      )
      // A verb and an object, not a verb alone.
      expect(first.trim().split(/\s+/).length, tool.name).toBeGreaterThan(2)
    }

    // The words a search for the tool would use, where it can see them.
    const keywords: Record<string, RegExp> = {
      search: /^Check first: before any /,
      read_memory: /^Read the owner's memorie/,
      memory: /^Save memories/,
      execute_read: /^Execute a Read tool/,
      execute_write: /^Execute a Write tool/,
      execute_destructive: /^Execute a Destructive/,
      run_read: /code/,
      run_write: /code/,
      run_destructive: /code/,
      check_permission: /permission/,
      withdraw_request: /request/,
      check_server: /server/,
      check_run: /run/,
      read_result: /result/,
      share_result: /file/,
      receive_file: /file/,
      create_upload_link: /files/,
      check_upload: /upload/,
      register_server: /server/,
      list_secrets: /secret/,
      get_endpoint: /endpoint/,
      get_wrapper: /wrapper/,
      create_wrapper: /wrapper/,
      update_wrapper: /wrapper/,
      delete_wrapper: /wrapper/,
      update_endpoint: /endpoint/,
      propose_tool_access: /tool/,
      list_tools: /tool/,
      web_fetch: /web/,
      read_image: /image/,
      view_image: /^View an image/,
      convert_document: /document/,
      edit_pdf: /PDF/,
      list_folder: /^List files in a folder/,
      find_files: /^Find files by name/,
      get_file: /^Get a file as a handle/,
      share_file: /^Share a stored file/,
      save_file: /^Save a file to a store/,
      make_folder: /^Make a folder/,
      move: /^Move or rename/,
      delete: /^Delete a file or folder/,
    }

    expect(Object.keys(keywords).sort()).toEqual(
      [...LISTED, ...OWN_TOOLS].sort(),
    )

    for (const [name, pattern] of Object.entries(keywords)) {
      expect(opening(name), name).toMatch(pattern)
    }
  })

  it("keep the run entries' and register_server's own descriptions short", async () => {
    const tools = everyTool
    const length = (name: string) =>
      tools.find((tool) => tool.name === name)!.description!.length

    for (const tier of ["read", "write", "destructive"]) {
      expect(length(`run_${tier}`)).toBeLessThan(3_000)
    }
    expect(length("register_server")).toBeLessThan(2_500)
  })

  it("take the new argument names, and the old ones for one release", async () => {
    const tools = everyTool
    const keys = (name: string) =>
      Object.keys(
        (tools.find((tool) => tool.name === name)!.inputSchema.properties ??
          {}) as Record<string, unknown>,
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
      name: "execute_read",
      arguments: {
        tool: "get_endpoint",
        arguments: { endpoint: "nowhere", includeSpec: true },
      },
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
      '"colour" is not an argument of this tool (it takes: query, ref, server, kind, limit).',
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
      name: "execute_write",
      arguments: {
        tool: "register_server",
        arguments: { name: "Linear", url: "https://mcp.linear.example/mcp" },
      },
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
      // What the owner is asked, for a client that shows only this.
      message: texts.join("\n\n"),
    })

    const open = await client.callTool(entryCall("check_permission", {}))
    expect(open.structuredContent).toMatchObject({
      kind: "requests",
      requests: [{ id: owner.request, kind: "register", url: owner.url }],
    })

    await client.callTool(entryCall("withdraw_request", { id: owner.request }))
    const settled = await client.callTool(
      entryCall("check_permission", { id: owner.request }),
    )
    expect(settled.structuredContent).toEqual({
      kind: "done",
      request: owner.request,
      status: "withdrawn",
      // What the text says, so a client that shows only this loses nothing.
      result: (settled.content as Array<{ text: string }>)
        .map((part) => part.text)
        .join(""),
    })

    // Several at once: the one withdrawn is answered, an unknown id listed.
    const several = await client.callTool(
      entryCall("check_permission", {
        ids: [owner.request, "nowhere"],
        mode: "all",
      }),
    )
    expect(several.structuredContent).toMatchObject({
      kind: "statuses",
      statuses: [
        { id: owner.request, status: "withdrawn" },
        { id: "nowhere", status: "unknown" },
      ],
    })

    // One id or several, never both.
    const both = await client.callTool(
      entryCall("check_permission", {
        id: owner.request,
        ids: [owner.request],
      }),
    )
    expect(both.isError).toBe(true)
    expect(both._meta?.[ERROR_META_KEY]).toMatchObject({
      code: "invalid_arguments",
    })

    // A mode is for several ids.
    const bare = await client.callTool(
      entryCall("check_permission", { mode: "all" }),
    )
    expect(bare.isError).toBe(true)

    const unknown = await client.callTool(
      entryCall("check_server", { server: "nowhere" }),
    )
    expect(unknown.isError).toBe(true)
    expect(unknown._meta?.[ERROR_META_KEY]).toEqual({ code: "not_found" })
  })
})

describe("PCP's own tools in search (#41)", () => {
  const said = async (
    on: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await on.callTool({ name, arguments: args })
    return {
      isError: result.isError === true,
      text: (result.content as Array<{ text: string }>)
        .map((part) => part.text)
        .join("\n"),
    }
  }

  it("finds them by name, first, and describes them to be run through execute by name", async () => {
    const found = await said(client, "search", {
      query: "check_permission PCP",
    })
    expect(found.text.split("\n")[0]).toMatch(
      /^pcp check_permission \(.+\) \[read: execute_read\] — .+ PCP's own tool: run it with execute_read, \{"tool": "check_permission", "arguments": \{…\}\}\.$/,
    )
    expect(
      (await said(client, "search", { query: "withdraw" })).text.split("\n")[0],
    ).toMatch(/^pcp withdraw_request /)

    const onlyPcp = await said(client, "search", { query: "run", kind: "pcp" })
    expect(
      onlyPcp.text
        .split("\n")
        .filter((line) => line && !line.startsWith("search takes"))
        .every((line) => line.startsWith("pcp ")),
    ).toBe(true)

    const described = await said(client, "search", {
      ref: "check_permission",
    })
    expect(described.isError).toBe(false)
    const tool = JSON.parse(described.text)
    expect(tool).toMatchObject({
      tool: "check_permission",
      kind: "pcp",
      run_with: "execute_read",
      title: expect.any(String),
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: expect.any(Object),
    })
    expect(tool.call_handle).toBeUndefined()

    const handle = await said(client, "execute_destructive", {
      call_handle: "check_permission",
      arguments: {},
    })
    expect(handle.isError).toBe(true)
    expect(handle.text).toContain(
      'check_permission is PCP\'s own tool: pass it as tool, not call_handle ({"tool": "check_permission", "arguments": {…}} to execute_read)',
    )
  })

  it("reads a name with an app's prefix as the bare name, and says so", async () => {
    const found = await said(client, "search", {
      query: "mcp__PCP_Bazzite__check_run",
    })
    const lines = found.text.split("\n")
    expect(lines[0]).toBe(
      "\"mcp__PCP_Bazzite__\" is your app's prefix for PCP's tools, not part of the name: the tool is check_run.",
    )
    expect(lines[2]).toMatch(/^pcp check_run /)

    const described = JSON.parse(
      (
        await said(client, "search", {
          ref: "mcp__PCP_Bazzite__check_run",
        })
      ).text,
    )
    expect(described.tool).toBe("check_run")
    expect(described.note).toContain('"mcp__PCP_Bazzite__"')

    // execute takes it too, and says what it made of it.
    const ran = await said(client, "execute_read", {
      tool: "mcp__PCP_Bazzite__check_permission",
      arguments: {},
    })
    expect(ran.isError).toBe(false)
    expect(ran.text.split("\n")[0]).toContain('"mcp__PCP_Bazzite__"')
  })

  it("leaves out the tools a token does not have", async () => {
    const { token } = await createApiToken(ctx, {
      name: "Plain",
      allowAllServers: true,
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(
      { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL },
      [],
    ).connect(serverSide)
    const plain = new Client({ name: "test", version: "1.0.0" })
    await plain.connect(clientSide)

    expect((await plain.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search",
      "execute_read",
      "execute_write",
      "execute_destructive",
    ])
    const found = await said(plain, "search", { query: "check_run" })
    expect(found.text).not.toContain("pcp check_run")
    const described = await said(plain, "search", { ref: "check_run" })
    expect(described.isError).toBe(true)
    const ran = await said(plain, "execute_read", {
      tool: "check_run",
      arguments: { id: "run_x" },
    })
    expect(ran.isError).toBe(true)
    expect(ran.text).toContain("PCP has no tool of its own called check_run")
    expect(
      (await said(plain, "search", { query: "check_permission" })).text,
    ).toMatch(/^pcp check_permission /)
    await plain.close()
  })
})

describe("execute_<tier> by name, and the names kept for one release (#113)", () => {
  const said = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    return {
      isError: result.isError === true,
      code: (result._meta?.[ERROR_META_KEY] as { code?: string } | undefined)
        ?.code,
      texts: (result.content as Array<{ text: string }>).map(
        (part) => part.text,
      ),
      structured: result.structuredContent,
    }
  }

  it("runs one of PCP's own tools by name within its tier, its line in the log under its own name", async () => {
    const ran = await said("execute_read", {
      tool: "check_permission",
      arguments: {},
    })
    expect(ran.isError).toBe(false)
    expect(ran.structured).toMatchObject({ kind: "requests" })
    expect(ran.texts).toHaveLength(1)
    // pcp/<name> is the same tool.
    expect(
      (await said("execute_read", { tool: "pcp/check_permission" })).isError,
    ).toBe(false)
    expect(appendRequestLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "check_permission", ok: true }),
    )

    // Its own arguments are checked by its own schema.
    const unfit = await said("execute_read", {
      tool: "check_permission",
      arguments: { mode: "all" },
    })
    expect(unfit.isError).toBe(true)
    expect(unfit.code).toBe("invalid_arguments")
  })

  it("refuses a tool above its tier, naming the entry that runs it, before its arguments are checked", async () => {
    const above = await said("execute_read", {
      tool: "memory",
      arguments: { nonsense: true },
    })
    expect(above.isError).toBe(true)
    expect(above.code).toBe("forbidden")
    expect(above.texts.join("\n")).toBe(
      "memory is a Destructive tool, so nothing was run or asked: run it with execute_destructive, with the same tool and arguments.",
    )
    expect(
      (
        await said("execute_write", {
          tool: "memory",
          arguments: { command: "view", path: "/memories" },
        })
      ).code,
    ).toBe("forbidden")
    expect(
      (
        await said("execute_destructive", {
          tool: "memory",
          arguments: { command: "view", path: "/memories" },
        })
      ).isError,
    ).toBe(false)
  })

  it("refuses what is not one of PCP's own tools, an entry, both a handle and a tool, or neither", async () => {
    const unknown = await said("execute_destructive", { tool: "send_email" })
    expect(unknown.code).toBe("not_found")
    expect(unknown.texts.join("")).toContain(
      "PCP has no tool of its own called send_email",
    )

    for (const tool of ["search", "run_read", "describe", "call_tool_read"]) {
      const entry = await said("execute_destructive", { tool })
      expect(entry.code, tool).toBe("invalid_arguments")
      expect(entry.texts.join(""), tool).toContain(
        "is one of PCP's entry tools: call it directly",
      )
    }

    const both = await said("execute_read", {
      tool: "check_permission",
      call_handle: "ch_x",
    })
    expect(both.code).toBe("invalid_arguments")
    expect((await said("execute_read", {})).code).toBe("invalid_arguments")

    // The owner's tools' options are not one of PCP's own tools'.
    const shaped = await said("execute_read", {
      tool: "check_permission",
      fields: ["kind"],
    })
    expect(shaped.code).toBe("invalid_arguments")
    expect(shaped.texts.join("")).toContain("With tool, execute takes only")
  })

  it("answers PCP's own tools and the old entries by their old names, unlisted, with a line naming the new entry", async () => {
    const own = await said("check_permission", {})
    expect(own.isError).toBe(false)
    expect(own.texts[0]).toBe(ownNameNote("check_permission", "execute_read"))
    expect(own.structured).toMatchObject({ kind: "requests" })

    const described = await said("describe", { ref: "check_permission" })
    expect(described.texts[0]).toBe(retiredNote("describe", "search"))
    expect(JSON.parse(described.texts[1]!)).toMatchObject({
      tool: "check_permission",
    })

    const old = await said("call_tool_read", {
      call_handle: "check_permission",
    })
    expect(old.texts[0]).toBe(retiredNote("call_tool_read", "execute_read"))
    expect(old.texts.join("\n")).toContain("pass it as tool, not call_handle")

    const program = await said("run_code_read", { code: "return 1 + 1" })
    expect(program.texts[0]).toBe(retiredNote("run_code_read", "run_read"))
    expect(program.texts.join("\n")).toContain("2")

    const { tools } = await client.listTools()
    for (const name of [
      "check_permission",
      "describe",
      "call_tool_read",
      "run_code_read",
    ]) {
      expect(tools.map((tool) => tool.name)).not.toContain(name)
    }
  })

  it("does not make the same Write call of PCP's own twice, unless asked to again with a reason", async () => {
    const register = {
      tool: "register_server",
      arguments: { name: "Linear", url: "https://mcp.linear.example/mcp" },
    }
    const first = await said("execute_write", register)
    expect(first.isError).toBe(false)
    expect(first.structured).toMatchObject({ kind: "needs_owner" })

    const again = await said("execute_write", register)
    expect(again.isError).toBe(true)
    expect(again.code).toBe("duplicate_call")
    expect(again.texts.join("\n")).toContain(
      "Not run again: pcp/register_server",
    )
    expect(await db().permissionRequest.count()).toBe(1)

    // rerun goes with a reason; with one, the call is made again.
    expect(
      (await said("execute_write", { ...register, rerun: true })).code,
    ).toBe("invalid_arguments")
    const meant = await said("execute_write", {
      ...register,
      rerun: true,
      reason: "The owner asked for it again.",
    })
    // It ran: register_server hands back the request still open for it.
    expect(meant.isError).toBe(false)
    expect(meant.structured).toMatchObject({ kind: "needs_owner" })

    // A tool that says a repeat does nothing more (idempotentHint) answers
    // a repeat itself.
    const id = (meant.structured as { request: string }).request
    await said("execute_write", { tool: "withdraw_request", arguments: { id } })
    const withdrawn = await said("execute_write", {
      tool: "withdraw_request",
      arguments: { id },
    })
    expect(withdrawn.code).not.toBe("duplicate_call")
    expect(withdrawn.texts.join("\n")).toContain("already withdrew")

    // Another call of the same tool with other arguments is no repeat, and
    // PCP's own answer says what it did: no note about the earlier one.
    for (const path of ["/memories/a.md", "/memories/b.md"]) {
      const saved = await said("execute_destructive", {
        tool: "memory",
        arguments: { command: "create", path, file_text: "Tea." },
      })
      expect(saved.texts).toEqual([`Saved ${path}.`])
    }

    // What only reads is never held back, whatever the tool's tier.
    const view = {
      tool: "memory",
      arguments: { command: "view", path: "/memories" },
    }
    expect((await said("execute_destructive", view)).isError).toBe(false)
    expect((await said("execute_destructive", view)).isError).toBe(false)
  })

  it("lists every one of PCP's own tools for kind pcp with no query", async () => {
    const all = await said("search", { kind: "pcp" })
    const lines = all.texts[0]!.split("\n").filter((line) =>
      line.startsWith("pcp "),
    )
    expect(lines).toHaveLength(OWN_TOOLS.length)

    // A limit alone says nothing to search by.
    const bare = await said("search", { limit: 5 })
    expect(bare.code).toBe("invalid_arguments")
    expect(bare.texts.join("")).toContain("limit goes with query")
  })

  it("answers PCP's own tools through execute without repeating the text as structuredContent", async () => {
    // list_secrets' text is its value's JSON: once is enough.
    const secrets = await said("execute_read", { tool: "list_secrets" })
    expect(secrets.isError).toBe(false)
    expect(secrets.structured).toBeUndefined()
    expect(JSON.parse(secrets.texts.at(-1)!)).toHaveProperty("secrets")

    // check_permission says it in words, and its value holds the ids and
    // links the words do not: it stays.
    const listed = await said("execute_read", { tool: "check_permission" })
    expect(listed.structured).toMatchObject({ kind: "requests" })
  })

  it("gives the owner's standing rules for search with no arguments", async () => {
    const rules = await said("search", {})
    expect(rules.isError).toBe(false)
    expect(rules.texts).toHaveLength(1)
    const text = rules.texts[0]!
    expect(text).toContain(
      "The owner has no memories to follow in every conversation.",
    )
    expect(text).toContain(STANDING_LEAD)
    expect(text).toContain("execute_read for a Read tool")
    expect(text).toContain('{"tool": "<name>", "arguments": {…}}')

    // A query and a ref do not go together.
    expect(
      (await said("search", { query: "mail", ref: "check_permission" })).code,
    ).toBe("invalid_arguments")
  })
})

describe("once a session, for the app on the other end (#53)", () => {
  /** The token connectAs made or reused last. */
  let made: { id: string; token: string }

  /** A gateway for a new token, answered as the profile given. */
  async function connectAs(
    profile: ClientProfileId,
    {
      keepMemories = true,
      instructions = false,
      reuse,
    }: {
      keepMemories?: boolean
      instructions?: boolean
      /** A token made before, for a second session of it. */
      reuse?: { id: string; token: string }
    } = {},
  ): Promise<Client> {
    const { id, token } =
      reuse ??
      (await createApiToken(ctx, {
        name: profile,
        allowAllServers: true,
        keepMemories,
      }))
    made = { id, token }
    const resolved = (await resolveApiToken(token))!
    const scope: GatewayScope = {
      ...resolved,
      instructions: instructions ? "Answer in Dutch." : null,
      publicUrl: PUBLIC_URL,
      client: detectClient(
        { ...resolved, tokenId: id, clientProfile: profile },
        requestClient(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: { clientInfo: { name: `app-${profile}` } },
          }),
          new Headers(),
        ),
      ),
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, []).connect(serverSide)
    const connected = new Client({ name: "test", version: "1.0.0" })
    await connected.connect(clientSide)
    return connected
  }

  async function texts(
    on: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string[]> {
    const result = await on.callTool(entryCall(name, args))
    return (result.content as Array<{ text: string }>).map((part) => part.text)
  }

  it("reminds search once to read the owner's rules, until search with no arguments runs", async () => {
    const generic = await connectAs("generic")
    const first = await texts(generic, "search", { query: "memory" })

    expect(first.slice(1)).toEqual([MEMORY_REMINDER])
    expect(await texts(generic, "search", { query: "memory" })).toHaveLength(1)
    expect(
      await texts(generic, "search", { ref: "check_permission" }),
    ).toHaveLength(1)
    await generic.close()

    const reader = await connectAs("generic")
    await texts(reader, "search", {})
    expect(
      await texts(reader, "search", { ref: "check_permission" }),
    ).toHaveLength(1)
    await reader.close()

    // A token that keeps no memories has nothing to be reminded of.
    const forgetful = await connectAs("generic", { keepMemories: false })
    expect(await texts(forgetful, "search", { query: "memory" })).toHaveLength(
      1,
    )
    await forgetful.close()
  })

  it("repeats the instructions' key rules for Claude's apps, once, and not for Claude Code", async () => {
    const app = await connectAs("claude-ai")
    const every = await texts(app, "search", {})

    expect(every).toHaveLength(1)
    expect(every[0]).toContain(STANDING_LEAD)
    expect(every[0]).toContain("call_handle")
    expect(every[0]).toContain("end your reply with every one of them")
    // The standing rules had them: search does not repeat them.
    expect(await texts(app, "search", { query: "memory" })).toHaveLength(1)
    await app.close()

    // Without the standing rules, the first search carries them (and the
    // reminder), and the next nothing.
    const other = await connectAs("claude-ai")
    const searched = await texts(other, "search", { query: "memory" })
    expect(searched).toHaveLength(3)
    expect(searched[1]).toBe(MEMORY_REMINDER)
    expect(searched[2]).toContain(MIRRORED_LEAD)
    expect(
      await texts(other, "search", { ref: "check_permission" }),
    ).toHaveLength(1)
    await other.close()

    const code = await connectAs("claude-code")
    expect((await texts(code, "search", {}))[0]).not.toContain(MIRRORED_LEAD)
    expect(
      (await texts(code, "search", { query: "memory" })).join("\n"),
    ).not.toContain(MIRRORED_LEAD)
    await code.close()
  })

  it("notes the owner's answers in the next answer, once each, and lists them in check_permission (#59)", async () => {
    const app = await connectAs("generic", { keepMemories: true })
    await texts(app, "search", {})

    const asked = await app.callTool(
      entryCall("memory", {
        command: "create",
        path: "/memories/shared/coffee.md",
        file_text: "The owner drinks coffee black.",
      }),
    )
    const said = (asked.content as Array<{ text: string }>)
      .map((part) => part.text)
      .join("\n")
    expect(said).toContain(
      "On the owner's next message, whatever it says, call check_permission",
    )
    const row = await db().permissionRequest.findFirstOrThrow()

    // Not answered yet: nothing to note.
    expect(
      await texts(app, "search", { ref: "check_permission" }),
    ).toHaveLength(1)

    await decidePermission(ctx, row.id, "allow_once", { publicUrl: PUBLIC_URL })

    // The next answer of any of PCP's own tools says so, first...
    const next = await texts(app, "search", { ref: "check_permission" })
    expect(next).toHaveLength(2)
    expect(next[0]).toContain("Answered by the owner since PCP last told you")
    expect(next[0]).toContain(`- ${row.id} (memory_share, answered just now)`)
    // ...and the one after that, nothing.
    expect(
      await texts(app, "search", { ref: "check_permission" }),
    ).toHaveLength(1)

    // check_permission with no id lists it, with its outcome.
    const listed = await app.callTool(entryCall("check_permission", {}))
    const structured = listed.structuredContent as {
      requests: unknown[]
      answered: Array<{ id: string; status: string; outcome: string }>
    }
    expect(structured.requests).toEqual([])
    expect(structured.answered).toEqual([
      expect.objectContaining({ id: row.id, status: "executed" }),
    ])
    const listedText = (listed.content as Array<{ text: string }>).map(
      (part) => part.text,
    )
    expect(listedText).toHaveLength(1)
    expect(listedText[0]).toContain(
      "Answered by the owner in the last hour, newest first",
    )

    // One whose outcome check_permission gave is not noted after it.
    await app.callTool(
      entryCall("memory", {
        command: "create",
        path: "/memories/shared/tea.md",
        file_text: "The owner drinks tea after six.",
      }),
    )
    const second = await db().permissionRequest.findFirstOrThrow({
      where: { NOT: { id: row.id } },
    })
    await decidePermission(ctx, second.id, "decline", {
      publicUrl: PUBLIC_URL,
    })
    expect(
      await texts(app, "check_permission", { id: second.id }),
    ).toHaveLength(1)
    expect(
      await texts(app, "search", { ref: "check_permission" }),
    ).toHaveLength(1)
    await app.close()

    // A new session of the token (an initialize) hears of answers from the
    // last hour, once.
    const later = await connectAs("generic", { reuse: made })
    const again = await texts(later, "search", {})
    expect(again).toHaveLength(2)
    expect(again[0]).toContain(row.id)
    expect(again[0]).toContain(second.id)
    expect(
      await texts(later, "search", { ref: "check_permission" }),
    ).toHaveLength(1)
    await later.close()

    // Another token's session hears nothing of it.
    const other = await connectAs("generic")
    await texts(other, "search", {})
    expect(
      await texts(other, "search", { ref: "check_permission" }),
    ).toHaveLength(1)
    await other.close()
  })

  it("brings the owner's instructions along where the standing rules have not", async () => {
    const app = await connectAs("claude-ai", {
      keepMemories: false,
      instructions: true,
    })
    const searched = await texts(app, "search", { query: "search" })

    expect(searched).toHaveLength(2)
    expect(searched[1]).toContain(MIRRORED_LEAD)
    expect(searched[1]).toContain("Answer in Dutch.")
    await app.close()
  })
})
