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
  type GatewayScope,
} from "../gateway"
import { db } from "../db"
import { decidePermission } from "../permissions"
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
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
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
  "run_code_read",
  "run_code_write",
  "run_code_destructive",
  "check_run",
  "read_image",
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
    const { tools } = await client.listTools()

    for (const tool of tools) {
      expect(tool.description, tool.name).not.toMatch(
        /says? they (have|are)|once they have answered/,
      )
    }

    for (const name of [
      "call_tool_read",
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
    const { tools } = await client.listTools()
    const opening = (name: string) =>
      tools.find((tool) => tool.name === name)!.description!.slice(0, 25)

    for (const tool of tools) {
      const first = tool.description!.slice(0, 25)

      expect(first, tool.name).toMatch(
        /^(START HERE: |(Search|List|Get|Call|Run|Check|Withdraw|Read|Share|Receive|Propose|Change|Fetch|Save|Edit|Convert|Find|Make|Move|Delete) )/,
      )
      // A verb and an object, not a verb alone.
      expect(first.trim().split(/\s+/).length, tool.name).toBeGreaterThan(2)
    }

    // The words a search for the tool would use, where it can see them.
    const keywords: Record<string, RegExp> = {
      search: /^Search tools, skills, mem/,
      read_memory: /^START HERE: owner's rules/,
      memory: /^Save memories/,
      describe: /call_handle/,
      call_tool_read: /^Call a Read/,
      call_tool_write: /^Call a Write/,
      call_tool_destructive: /^Call a Destructive/,
      run_code_read: /code/,
      run_code_write: /code/,
      run_code_destructive: /code/,
      check_permission: /permission/,
      withdraw_request: /request/,
      check_server: /server/,
      check_run: /run_code/,
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

    expect(Object.keys(keywords).sort()).toEqual([...ALL_TOOLS].sort())

    for (const [name, pattern] of Object.entries(keywords)) {
      expect(opening(name), name).toMatch(pattern)
    }
  })

  it("keep the run_code entries' and register_server's own descriptions short", async () => {
    const { tools } = await client.listTools()
    const length = (name: string) =>
      tools.find((tool) => tool.name === name)!.description!.length

    for (const tier of ["read", "write", "destructive"]) {
      expect(length(`run_code_${tier}`)).toBeLessThan(3_000)
    }
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
      // What the owner is asked, for a client that shows only this.
      message: texts.join("\n\n"),
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
      // What the text says, so a client that shows only this loses nothing.
      result: (settled.content as Array<{ text: string }>)
        .map((part) => part.text)
        .join(""),
    })

    // Several at once: the one withdrawn is answered, an unknown id listed.
    const several = await client.callTool({
      name: "check_permission",
      arguments: { ids: [owner.request, "nowhere"], mode: "all" },
    })
    expect(several.structuredContent).toMatchObject({
      kind: "statuses",
      statuses: [
        { id: owner.request, status: "withdrawn" },
        { id: "nowhere", status: "unknown" },
      ],
    })

    // One id or several, never both.
    const both = await client.callTool({
      name: "check_permission",
      arguments: { id: owner.request, ids: [owner.request] },
    })
    expect(both.isError).toBe(true)
    expect(both._meta?.[ERROR_META_KEY]).toMatchObject({
      code: "invalid_arguments",
    })

    const unknown = await client.callTool({
      name: "check_server",
      arguments: { server: "nowhere" },
    })
    expect(unknown.isError).toBe(true)
    expect(unknown._meta?.[ERROR_META_KEY]).toEqual({ code: "not_found" })
  })
})

describe("PCP's own tools in search and describe (#41)", () => {
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

  it("finds them by name, first, and describes them to be called directly", async () => {
    const found = await said(client, "search", {
      query: "check_permission PCP",
    })
    expect(found.text.split("\n")[0]).toMatch(
      /^pcp check_permission \(.+\) \[read\] — .+ PCP's own tool: call it directly \(not through call_tool_\*\)\.$/,
    )
    expect(
      (await said(client, "search", { query: "withdraw" })).text.split("\n")[0],
    ).toMatch(/^pcp withdraw_request /)

    const onlyPcp = await said(client, "search", { query: "run", kind: "pcp" })
    expect(
      onlyPcp.text
        .split("\n")
        .filter((line) => line && !line.startsWith("describe takes"))
        .every((line) => line.startsWith("pcp ")),
    ).toBe(true)

    const described = await said(client, "describe", {
      ref: "check_permission",
    })
    expect(described.isError).toBe(false)
    const tool = JSON.parse(described.text)
    expect(tool).toMatchObject({
      tool: "check_permission",
      kind: "pcp",
      title: expect.any(String),
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: expect.any(Object),
    })
    expect(tool.call_handle).toBeUndefined()

    const handle = await said(client, "call_tool_destructive", {
      call_handle: "check_permission",
      arguments: {},
    })
    expect(handle.isError).toBe(true)
    expect(handle.text).toContain("check_permission is PCP's own tool")
  })

  it("reads a name with an app's prefix as the bare name, and says so", async () => {
    const found = await said(client, "search", {
      query: "mcp__PCP_Bazzite__run_code_read",
    })
    const lines = found.text.split("\n")
    expect(lines[0]).toBe(
      "\"mcp__PCP_Bazzite__\" is your app's prefix for PCP's tools, not part of the name: the tool is run_code_read, and you call it directly.",
    )
    expect(lines[2]).toMatch(/^pcp run_code_read /)

    const described = JSON.parse(
      (
        await said(client, "describe", {
          ref: "mcp__PCP_Bazzite__run_code_read",
        })
      ).text,
    )
    expect(described.tool).toBe("run_code_read")
    expect(described.note).toContain('"mcp__PCP_Bazzite__"')
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

    const found = await said(plain, "search", { query: "run_code_read" })
    expect(found.text).not.toContain("pcp run_code")
    const described = await said(plain, "describe", { ref: "run_code_read" })
    expect(described.isError).toBe(true)
    expect(
      (await said(plain, "search", { query: "check_permission" })).text,
    ).toMatch(/^pcp check_permission /)
    await plain.close()
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
    const result = await on.callTool({ name, arguments: args })
    return (result.content as Array<{ text: string }>).map((part) => part.text)
  }

  it("reminds search and describe once to read the owner's memories, until read_memory every runs", async () => {
    const generic = await connectAs("generic")
    const first = await texts(generic, "search", { query: "memory" })

    expect(first.slice(1)).toEqual([MEMORY_REMINDER])
    expect(await texts(generic, "search", { query: "memory" })).toHaveLength(1)
    expect(await texts(generic, "describe", { ref: "search" })).toHaveLength(1)
    await generic.close()

    const reader = await connectAs("generic")
    await texts(reader, "read_memory", { command: "every" })
    expect(await texts(reader, "describe", { ref: "search" })).toHaveLength(1)
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
    const every = await texts(app, "read_memory", { command: "every" })

    expect(every).toHaveLength(1)
    expect(every[0]).toContain(MIRRORED_LEAD)
    expect(every[0]).toContain("call_handle")
    expect(every[0]).toContain("end your reply with every one of them")
    // read_memory every had them: search does not repeat them.
    expect(await texts(app, "search", { query: "memory" })).toHaveLength(1)
    await app.close()

    // Without read_memory, the first search carries them (and the
    // reminder), and the next nothing.
    const other = await connectAs("claude-ai")
    const searched = await texts(other, "search", { query: "memory" })
    expect(searched).toHaveLength(3)
    expect(searched[1]).toBe(MEMORY_REMINDER)
    expect(searched[2]).toContain(MIRRORED_LEAD)
    expect(await texts(other, "describe", { ref: "search" })).toHaveLength(1)
    await other.close()

    const code = await connectAs("claude-code")
    expect(
      (await texts(code, "read_memory", { command: "every" }))[0],
    ).not.toContain(MIRRORED_LEAD)
    expect(
      (await texts(code, "search", { query: "memory" })).join("\n"),
    ).not.toContain(MIRRORED_LEAD)
    await code.close()
  })

  it("notes the owner's answers in the next answer, once each, and lists them in check_permission (#59)", async () => {
    const app = await connectAs("generic", { keepMemories: true })
    await texts(app, "read_memory", { command: "every" })

    const asked = await app.callTool({
      name: "memory",
      arguments: {
        command: "create",
        path: "/memories/shared/coffee.md",
        file_text: "The owner drinks coffee black.",
      },
    })
    const said = (asked.content as Array<{ text: string }>)
      .map((part) => part.text)
      .join("\n")
    expect(said).toContain(
      "On the owner's next message, whatever it says, call check_permission",
    )
    const row = await db().permissionRequest.findFirstOrThrow()

    // Not answered yet: nothing to note.
    expect(await texts(app, "describe", { ref: "search" })).toHaveLength(1)

    await decidePermission(ctx, row.id, "allow_once", { publicUrl: PUBLIC_URL })

    // The next answer of any of PCP's own tools says so, first...
    const next = await texts(app, "describe", { ref: "search" })
    expect(next).toHaveLength(2)
    expect(next[0]).toContain("Answered by the owner since PCP last told you")
    expect(next[0]).toContain(`- ${row.id} (memory_share, answered just now)`)
    // ...and the one after that, nothing.
    expect(await texts(app, "describe", { ref: "search" })).toHaveLength(1)

    // check_permission with no id lists it, with its outcome.
    const listed = await app.callTool({
      name: "check_permission",
      arguments: {},
    })
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
    await app.callTool({
      name: "memory",
      arguments: {
        command: "create",
        path: "/memories/shared/tea.md",
        file_text: "The owner drinks tea after six.",
      },
    })
    const second = await db().permissionRequest.findFirstOrThrow({
      where: { NOT: { id: row.id } },
    })
    await decidePermission(ctx, second.id, "decline", {
      publicUrl: PUBLIC_URL,
    })
    expect(
      await texts(app, "check_permission", { id: second.id }),
    ).toHaveLength(1)
    expect(await texts(app, "describe", { ref: "search" })).toHaveLength(1)
    await app.close()

    // A new session of the token (an initialize) hears of answers from the
    // last hour, once.
    const later = await connectAs("generic", { reuse: made })
    const again = await texts(later, "read_memory", { command: "every" })
    expect(again).toHaveLength(2)
    expect(again[0]).toContain(row.id)
    expect(again[0]).toContain(second.id)
    expect(await texts(later, "describe", { ref: "search" })).toHaveLength(1)
    await later.close()

    // Another token's session hears nothing of it.
    const other = await connectAs("generic")
    await texts(other, "read_memory", { command: "every" })
    expect(await texts(other, "describe", { ref: "search" })).toHaveLength(1)
    await other.close()
  })

  it("brings the owner's instructions along where read_memory does not", async () => {
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
