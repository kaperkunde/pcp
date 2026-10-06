import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { connect as connectSocket, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken, updateApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import {
  buildGatewayServer,
  buildInstructions,
  loadGatewayServers,
  type GatewayScope,
} from "../gateway"
import type { PermissionExecutor } from "../permissions"
import { appendRequestLog } from "../request-log"
import { createServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { keepResult } from "../tool-results"
import { writeToolAccess } from "../tool-access"
import { setupVault } from "../vault"
import { MAX_CALLS_PER_RUN } from "./limits"
import { runCode } from "./run"
import { sandboxLanguages, startSandbox, stopSandbox } from "./sandbox"

// run_code as an assistant meets it, through the gateway's MCP interface,
// with the upstream replaced by a stub that records what actually ran: the
// token's levels for each call, files as handles, kept results, and what
// the answer says.

vi.mock("../request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

const PUBLIC_URL = "http://localhost:3000"
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.alloc(2048, 7),
]).toString("base64")

let cleanup: () => Promise<void>
let ctx: VaultContext
let scope: GatewayScope
let client: Client
let ran: Array<{ tool: string; args: Record<string, unknown> }>

const CARDS = Array.from({ length: 500 }, (_, index) => ({
  id: index,
  to: index % 50 === 0 ? "Grace" : "Ada",
  text: "x".repeat(400),
}))

const executor: PermissionExecutor = {
  callTool: async (_ctx, _server, tool, args) => {
    ran.push({ tool, args })

    switch (tool) {
      case "list_cards":
        return { content: [{ type: "text", text: JSON.stringify(CARDS) }] }
      case "scan_card":
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ name: "card.pdf", data: PDF }),
            },
          ],
        }
      case "broken":
        return {
          content: [{ type: "text", text: "The printer is on fire." }],
          isError: true,
        }
      default:
        return { content: [{ type: "text", text: `ran ${tool}` }] }
    }
  },
  syncTools: async () => ({ status: "ok", message: "", toolCount: 0 }),
}

async function connect(runCodeRight = true) {
  const { id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  })

  for (const name of [
    "list_cards",
    "scan_card",
    "send_postcard",
    "burn_cards",
    "broken",
    "archive",
  ]) {
    await db().mcpTool.create({
      data: {
        id: randomUUID(),
        serverId,
        name,
        description: `${name} does one thing.`,
        inputSchema: JSON.stringify({ type: "object" }),
      },
    })
  }

  const { id: tokenId, token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    runCode: runCodeRight,
  })

  for (const name of ["list_cards", "scan_card", "broken", "archive"]) {
    await writeToolAccess(tokenId, serverId, name, "allowed")
  }
  await writeToolAccess(tokenId, serverId, "burn_cards", "blocked")

  scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope), {
    executor,
  }).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ran = []
  vi.mocked(appendRequestLog).mockClear()
})

afterEach(async () => {
  await client?.close()
  await cleanup()
})

async function run(code: string) {
  const result = await client.callTool({
    name: "run_code",
    arguments: { code },
  })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return { isError: result.isError === true, text }
}

/** The JSON after "It returned:". */
function returned(text: string): unknown {
  return JSON.parse(text.split("It returned:\n")[1]!)
}

function logLines(): Array<Record<string, unknown>> {
  return vi
    .mocked(appendRequestLog)
    .mock.calls.map(([entry]) => entry as Record<string, unknown>)
}

describe("the token right", () => {
  it("is off unless the owner turns it on, and only then is there a tool", async () => {
    await connect(false)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).not.toContain("run_code")
    expect(scope.runCode).toBe(false)

    await updateApiToken(ctx, scope.tokenId, {
      name: "Claude",
      allowAllServers: true,
      runCode: true,
    })
    expect(
      (await db().apiToken.findUniqueOrThrow({ where: { id: scope.tokenId } }))
        .runCode,
    ).toBe(true)
  })

  it("is in the instructions of a token that has it, and no other", () => {
    expect(buildInstructions([])).not.toContain("run_code")
    expect(buildInstructions([], { runCode: true })).toContain("run_code")
  })
})

describe("a program's calls", () => {
  beforeEach(async () => {
    await connect()
  })

  it("filters a large answer without handing it back, and says what it did", async () => {
    const { isError, text } = await run(`
      const cards = await pcp.call("postcards", "list_cards")
      console.log("cards:", cards.length)
      return cards.filter((card) => card.to === "Grace").map((card) => card.id)
    `)

    expect(isError).toBe(false)
    expect(text).toContain("finished in")
    expect(text).toContain("1 call")
    expect(text).toContain("It printed:\ncards: 500")
    expect(returned(text)).toEqual([
      0, 50, 100, 150, 200, 250, 300, 350, 400, 450,
    ])
    expect(text.length).toBeLessThan(500)
  })

  it("logs each call under run_code, by server and tool, and never the program", async () => {
    await run(
      `await pcp.call("postcards", "list_cards"); await pcp.call("postcards", "broken").catch(() => {})`,
    )
    const lines = logLines()
    expect(
      lines
        .filter((line) => line.upstreamTool)
        .map((line) => [line.tool, line.server, line.upstreamTool, line.ok]),
    ).toEqual([
      ["run_code", "postcards", "list_cards", true],
      ["run_code", "postcards", "broken", false],
    ])
    expect(JSON.stringify(lines)).not.toContain("catch")
  })

  it("hands a tool's error to the program, which may catch it", async () => {
    const { text } = await run(`
      try { await pcp.call("postcards", "broken") } catch (error) { return error.message }
    `)

    expect(returned(text)).toBe("The printer is on fire.")
  })

  it("refuses a blocked tool, and one the token cannot see, as errors", async () => {
    const { text } = await run(`
      const said = []
      for (const [server, tool] of [["postcards", "burn_cards"], ["postcards", "nothing"], ["elsewhere", "list"]]) {
        try { await pcp.call(server, tool) } catch (error) { said.push(error.message) }
      }
      return said
    `)

    expect(returned(text)).toEqual([
      "The owner has blocked postcards/burn_cards for this token.",
      expect.stringContaining("postcards has no tool called nothing"),
      expect.stringContaining("No server called elsewhere"),
    ])
    expect(ran.map((call) => call.tool)).not.toContain("burn_cards")
  })

  it("stops at a tool that asks the owner, with their link last, and runs nothing after it", async () => {
    const { isError, text } = await run(`
      await pcp.call("postcards", "archive", { all: true })
      console.log("sending")
      await pcp.call("postcards", "send_postcard", { to: "Grace" })
      await pcp.call("postcards", "archive", { after: true })
    `)

    expect(isError).toBe(false)
    expect(text).toContain("stopped at postcards/send_postcard")
    expect(text).toContain("It printed:\nsending")
    expect(text).toContain("Not done yet")
    expect(text.trimEnd()).toMatch(/\/permissions\/[\w-]+$/)
    expect(ran).toEqual([{ tool: "archive", args: { all: true } }])

    const request = await db().permissionRequest.findFirstOrThrow()
    expect(request).toMatchObject({
      kind: "call",
      toolName: "send_postcard",
      tokenId: scope.tokenId,
    })

    // The call and the run that stopped at it are both in the log as asked,
    // with the request, so the Log page can link it.
    const lines = logLines()
    expect(
      lines.find((line) => line.upstreamTool === "send_postcard"),
    ).toMatchObject({ tool: "run_code", asked: true, request: request.id })
    expect(
      lines.find((line) => line.tool === "run_code" && !line.upstreamTool),
    ).toMatchObject({ asked: true, request: request.id })
    expect(
      lines.find((line) => line.upstreamTool === "archive"),
    ).not.toHaveProperty("asked")
  })

  it("gets a file as a handle, never its bytes, and passes it on as one", async () => {
    const { text } = await run(`
      const scanned = await pcp.call("postcards", "scan_card")
      await pcp.call("postcards", "archive", { file: scanned.data })
      return scanned
    `)

    const scanned = returned(text) as { data: Record<string, unknown> }
    expect(text).not.toContain(PDF.slice(0, 100))
    expect(scanned.data).toMatchObject({
      $result: expect.any(String),
      type: "application/pdf",
      name: "card.pdf",
    })
    // The handle PCP wrote is passed on bare, where it stands for the file.
    expect(ran.at(-1)).toEqual({
      tool: "archive",
      args: { file: { $result: scanned.data.$result } },
    })
  })

  it("keeps a text for the token and reads it back, and reads no other token's", async () => {
    const { token: otherToken } = await createApiToken(ctx, {
      name: "Phone",
      allowAllServers: true,
    })
    const other = (await resolveApiToken(otherToken))!
    const theirs = await keepResult(ctx, {
      tokenId: other.tokenId,
      serverId: null,
      toolName: "list_cards",
      text: "not yours",
      mediaType: "text/plain",
    })

    const { text } = await run(`
      const handle = await pcp.keep("id,to\\n0,Grace", { name: "grace.csv", type: "text/csv" })
      const back = await pcp.read(handle)
      let refused
      try { await pcp.read("${theirs.id}") } catch (error) { refused = error.message }
      return { handle, back, refused }
    `)

    const value = returned(text) as {
      handle: { $result: string; type: string; name: string }
      back: string
      refused: string
    }
    expect(value.handle).toMatchObject({ type: "text/csv", name: "grace.csv" })
    expect(value.back).toBe("id,to\n0,Grace")
    expect(value.refused).toContain(`No kept result "${theirs.id}"`)

    const row = await db().toolResult.findUniqueOrThrow({
      where: { id: value.handle.$result },
    })
    expect(row).toMatchObject({ tokenId: scope.tokenId, toolName: "run_code" })
  })

  it("reads a file's bytes only as base64, and keeps bytes sent so", async () => {
    const { text } = await run(`
      const scanned = await pcp.call("postcards", "scan_card")
      let refused
      try { await pcp.read(scanned.data) } catch (error) { refused = error.message }
      const base64 = await pcp.read(scanned.data, { as: "base64" })
      const copy = await pcp.keep(base64.slice(0, 12), { encoding: "base64", name: "head.pdf", type: "application/pdf" })
      const bytes = await pcp.keep(new Uint8Array([1, 2, 3]))
      let notBase64
      try { await pcp.keep("not base64!", { encoding: "base64" }) } catch (error) { notBase64 = error.message }
      return { refused, same: base64 === ${JSON.stringify(PDF)}, copy, bytes, notBase64 }
    `)

    const value = returned(text) as {
      refused: string
      same: boolean
      copy: { $result: string; type: string; name: string; size: number }
      bytes: { $result: string; type: string; size: number }
      notBase64: string
    }
    expect(value.refused).toContain(
      'read its bytes as base64 instead (as: "base64")',
    )
    expect(value.same).toBe(true)
    expect(value.copy).toMatchObject({
      type: "application/pdf",
      name: "head.pdf",
      size: 9,
    })
    expect(value.bytes).toMatchObject({
      type: "application/octet-stream",
      size: 3,
    })
    expect(value.notBase64).toContain("is not")

    const row = await db().toolResult.findUniqueOrThrow({
      where: { id: value.copy.$result },
    })
    expect(row).toMatchObject({
      tokenId: scope.tokenId,
      kind: "bytes",
      toolName: "run_code",
    })
  })

  it("lists the token's servers and the tools it can see, as list_tools does", async () => {
    const { text } = await run(`
      const servers = await pcp.tools()
      const tools = await pcp.tools("postcards")
      let missing
      try { await pcp.tools("nowhere") } catch (error) { missing = error.message }
      return { servers, tools: tools.map((tool) => [tool.name, tool.access]), missing }
    `)

    expect(returned(text)).toEqual({
      servers: [
        {
          server: "postcards",
          name: "Postcards",
          description: "",
          tools: 5,
        },
      ],
      tools: [
        ["archive", "allowed"],
        ["broken", "allowed"],
        ["list_cards", "allowed"],
        ["scan_card", "allowed"],
        ["send_postcard", "ask"],
      ],
      missing: "No server called nowhere. Servers: postcards.",
    })
    expect(ran).toEqual([])
  })

  it("says in its description what the program has, and that no sandbox runs", async () => {
    const { tools } = await client.listTools()
    const description =
      tools.find((tool) => tool.name === "run_code")?.description ?? ""

    for (const part of [
      "crypto.getRandomValues",
      'as: "base64"',
      'encoding: "base64"',
      "pcp.tools()",
      'keep: ["password"]',
      "not running on this PCP",
    ]) {
      expect(description).toContain(part)
    }
  })

  it("keeps a long returned value as a result, to read or pass on", async () => {
    const { text } = await run(
      `return await pcp.call("postcards", "list_cards")`,
    )

    const id = text.match(/kept the value as result ([\w-]+)/)?.[1]
    expect(id).toBeDefined()
    const read = await client.callTool({
      name: "read_result",
      arguments: { id, length: 20 },
    })
    expect(JSON.stringify(read.content)).toContain('[{\\"id\\":0')
  })

  it("refuses a handle the token has no result for before anything is sent", async () => {
    const { text } = await run(`
      try { await pcp.call("postcards", "archive", { file: { $result: "gone" } }) } catch (error) { return error.message }
    `)

    expect(returned(text)).toContain('No kept result "gone"')
    expect(ran).toEqual([])
  })

  it(`stops counting at ${MAX_CALLS_PER_RUN} calls`, async () => {
    const { text } = await run(`
      for (let i = 0; i <= ${MAX_CALLS_PER_RUN}; i++) {
        try { await pcp.call("postcards", "archive", { i }) } catch (error) { return [i, error.message] }
      }
    `)

    expect(returned(text)).toEqual([
      MAX_CALLS_PER_RUN,
      `A run makes at most ${MAX_CALLS_PER_RUN} calls.`,
    ])
    expect(ran).toHaveLength(MAX_CALLS_PER_RUN)
  })

  it("says why a program failed, with what it printed", async () => {
    const { isError, text } = await run(
      `console.log("before"); undefinedThing()`,
    )

    expect(isError).toBe(true)
    expect(text).toContain("The program failed after")
    expect(text).toContain("ReferenceError")
    expect(text).toContain("It printed:\nbefore")
  })
})

describe("a server the owner has to connect", () => {
  it("stops the program with the link to connect it", async () => {
    const { id: serverId } = await createServer(ctx, {
      name: "Calendar",
      url: "https://calendar.example.com/mcp",
      authType: "oauth",
    })
    await db().mcpTool.create({
      data: {
        id: randomUUID(),
        serverId,
        name: "list_events",
        description: "Lists events.",
        inputSchema: JSON.stringify({ type: "object" }),
      },
    })
    await connect()
    await writeToolAccess(scope.tokenId, serverId, "list_events", "allowed")
    // A fresh gateway, so the level just written is read.
    await client.close()
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, await loadGatewayServers(scope), {
      executor,
    }).connect(serverSide)
    client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)

    const { text } = await run(`
      await pcp.call("postcards", "archive")
      await pcp.call("calendar", "list_events")
      await pcp.call("postcards", "archive", { after: true })
    `)

    expect(text).toContain("stopped at calendar/list_events")
    expect(text).toContain(`/servers/${serverId}`)
    expect(text).toContain("check_server")
    expect(text).not.toContain("check_permission gives")
    expect(ran).toEqual([{ tool: "archive", args: {} }])
  })
})

describe("the sandbox's languages", () => {
  /** A stand-in runner: says hello, and answers each program with its code. */
  async function fakeRunner(socketPath: string): Promise<Socket> {
    const socket = connectSocket(socketPath)
    await new Promise((resolve) => socket.once("connect", resolve))
    socket.write(
      `${JSON.stringify({ type: "hello", protocol: 1, languages: ["bash", "python"] })}\n`,
    )
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString()
      let at = buffer.indexOf("\n")
      while (at !== -1) {
        const message = JSON.parse(buffer.slice(0, at)) as {
          type: string
          job: string
          language: string
          code: string
        }
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf("\n")
        if (message.type === "run") {
          socket.write(
            `${JSON.stringify({ type: "done", job: message.job, exit: 0, output: `${message.language}: ${message.code}\n`, dropped: 0 })}\n`,
          )
        }
      }
    })
    const deadline = Date.now() + 5_000
    while (sandboxLanguages().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return socket
  }

  it("offers bash and Python only while a runner is connected, and runs them there", async () => {
    await connect()
    const schema = async () =>
      (await client.listTools()).tools.find((tool) => tool.name === "run_code")!
        .inputSchema.properties as Record<string, { enum?: string[] }>

    expect(Object.keys(await schema())).toEqual(["code"])

    const dir = mkdtempSync(path.join(tmpdir(), "pcp-runner-"))
    const socketPath = path.join(dir, "sandbox.sock")
    await startSandbox(socketPath)
    const runner = await fakeRunner(socketPath)

    try {
      // The gateway is built per request: a new one sees the runner.
      await client.close()
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await buildGatewayServer(scope, await loadGatewayServers(scope), {
        executor,
      }).connect(serverSide)
      client = new Client({ name: "test", version: "1.0.0" })
      await client.connect(clientSide)

      expect((await schema()).language?.enum).toEqual([
        "javascript",
        "bash",
        "python",
      ])

      const result = await client.callTool({
        name: "run_code",
        arguments: { code: "echo hi", language: "bash" },
      })
      const text = JSON.stringify(result.content)
      expect(text).toContain("It printed:\\nbash: echo hi")
      // A shell program has no value to return.
      expect(text).not.toContain("It returned")
    } finally {
      runner.destroy()
      await stopSandbox()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("runCode on its own", () => {
  it("ends a run that takes too long, whatever it waits on", async () => {
    await connect()
    const result = await runCode(
      scope,
      { code: `await pcp.call("slow", "tool")` },
      { call: () => new Promise(() => {}), timeoutMs: 2_000 },
    )

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(
      "took longer than 2 seconds",
    )
  })
})
