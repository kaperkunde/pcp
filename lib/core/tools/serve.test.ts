import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { PcpError } from "../errors"
import { defineTool } from "./define"
import { ERROR_META_KEY, NEEDS_OWNER, ok, passOn } from "./outcome"
import {
  ARGUMENTS_DID_NOT_FIT,
  permissionLinkIn,
  registerTool,
  TOOL_REPORTED_ERROR,
  type CallLine,
} from "./serve"

const PUBLIC_URL = "https://pcp.example"
const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

let lines: CallLine[]
let client: Client
let ran: unknown[]

beforeEach(async () => {
  lines = []
  ran = []
  const server = new McpServer({ name: "test", version: "1.0.0" })
  const hooks = {
    publicUrl: PUBLIC_URL,
    log: (line: CallLine) => lines.push(line),
  }

  registerTool(
    server,
    defineTool({
      name: "echo",
      title: "Echo",
      description: "Says it back.",
      input: z.object({
        text: z.string().max(5).describe("What to say."),
        server: z.string().optional().describe("A server, for the log."),
      }),
      aliases: { oldText: "text" },
      annotations,
      log: (args) => ({ server: args.server as string }),
      run: async (args) => {
        ran.push(args)
        return ok(args.text)
      },
    }),
    hooks,
  )
  registerTool(
    server,
    defineTool({
      name: "count",
      title: "Count",
      description: "Counts.",
      input: z.object({
        wrong: z.boolean().optional().describe("Answer the wrong shape."),
      }),
      output: z.object({ n: z.number() }),
      annotations,
      run: async (args) => ok(args.wrong ? { n: "three" } : { n: 3 }),
    }),
    hooks,
  )
  registerTool(
    server,
    defineTool({
      name: "fails",
      title: "Fails",
      description: "Throws.",
      input: z.object({
        pcp: z.boolean().describe("A PcpError, or anything else."),
      }),
      annotations,
      run: async (args) => {
        if (args.pcp) {
          throw new PcpError("not_found", "No such thing.")
        }

        throw new Error("a bug's details")
      },
    }),
    hooks,
  )
  registerTool(
    server,
    defineTool({
      name: "asks",
      title: "Asks",
      description: "Asks the owner.",
      input: z.object({}),
      output: NEEDS_OWNER,
      annotations,
      run: async () =>
        passOn({
          content: [
            {
              type: "text",
              text: `Not done yet.\n\nEnd your reply with this link.\n${PUBLIC_URL}/permissions/req_1`,
            },
          ],
        }),
    }),
    hooks,
  )

  registerTool(
    server,
    defineTool({
      name: "relays",
      title: "Relays",
      description: "Passes on another tool's error.",
      input: z.object({}),
      annotations,
      run: async () =>
        passOn({
          content: [{ type: "text", text: "upstream said: token sk_123 bad" }],
          isError: true,
        }),
    }),
    hooks,
  )

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
})

afterEach(async () => {
  await client.close()
})

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }>

  return {
    result,
    isError: result.isError === true,
    texts: content.map((part) => part.text ?? ""),
  }
}

describe("serveTool", () => {
  it("publishes the schemas and annotations as defined", async () => {
    const { tools } = await client.listTools()
    const echo = tools.find((tool) => tool.name === "echo")!
    const count = tools.find((tool) => tool.name === "count")!

    expect(echo.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    })
    expect(echo.annotations).toEqual(annotations)
    expect(echo.outputSchema).toBeUndefined()
    expect(count.outputSchema).toMatchObject({ type: "object" })
  })

  it("refuses an unknown key in its own words, logged without the arguments", async () => {
    const answer = await call("echo", { text: "hi", txet: "oops" })

    expect(answer.isError).toBe(true)
    expect(answer.texts.join("")).toBe(
      'These arguments do not fit echo\'s inputSchema, so nothing was done:\n- "txet" is not an argument of this tool (it takes: text, server).',
    )
    expect(answer.result._meta?.[ERROR_META_KEY]).toEqual({
      code: "invalid_arguments",
    })
    expect(ran).toEqual([])
    expect(lines).toEqual([
      expect.objectContaining({
        tool: "echo",
        ok: false,
        error: ARGUMENTS_DID_NOT_FIT,
      }),
    ])
  })

  it("checks lengths and types before running", async () => {
    const answer = await call("echo", { text: "too long" })

    expect(answer.isError).toBe(true)
    expect(answer.texts.join("")).toContain(
      '"text" is 8 characters long, but the inputSchema says at most 5.',
    )
    expect(ran).toEqual([])
  })

  it("takes an old name for one release, with a note in front", async () => {
    const answer = await call("echo", { oldText: "hi", server: "mail" })

    expect(answer.isError).toBe(false)
    expect(answer.texts).toEqual([
      "oldText was renamed to text; use text.",
      "hi",
    ])
    expect(ran).toEqual([{ text: "hi", server: "mail" }])
    expect(lines[0]).toMatchObject({ ok: true, names: { server: "mail" } })

    const both = await call("echo", { oldText: "hi", text: "hi" })
    expect(both.isError).toBe(true)
    expect(both.texts.join("")).toContain("pass only text")
  })

  it("keeps a PcpError's code, and says nothing of any other error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})

    const known = await call("fails", { pcp: true })
    expect(known.texts.at(-1)).toBe("No such thing.")
    expect(known.result._meta?.[ERROR_META_KEY]).toEqual({ code: "not_found" })
    expect(lines.at(-1)).toMatchObject({ ok: false, error: "No such thing." })

    const bug = await call("fails", { pcp: false })
    expect(bug.texts.at(-1)).toBe("Something went wrong inside PCP.")
    expect(bug.result._meta?.[ERROR_META_KEY]).toEqual({ code: "internal" })
  })

  it("answers structured values, and never one that does not fit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})

    const fits = await call("count", {})
    expect(fits.result.structuredContent).toEqual({ n: 3 })
    expect(JSON.parse(fits.texts[0]!)).toEqual({ n: 3 })

    const wrong = await call("count", { wrong: true })
    expect(wrong.isError).toBe(true)
    expect(wrong.result._meta?.[ERROR_META_KEY]).toEqual({ code: "internal" })
  })

  it("logs another tool's error without its words", async () => {
    const answer = await call("relays", {})

    expect(answer.isError).toBe(true)
    expect(answer.result.structuredContent).toBeUndefined()
    expect(lines.at(-1)).toMatchObject({
      ok: false,
      error: TOOL_REPORTED_ERROR,
    })
  })

  it("marks a permission request passed on as one, its link still last", async () => {
    const answer = await call("asks", {})

    expect(answer.result.structuredContent).toEqual({
      kind: "needs_owner",
      reason: "permission",
      url: `${PUBLIC_URL}/permissions/req_1`,
      label: "Answer the request in PCP",
      request: "req_1",
    })
    expect(answer.texts.at(-1)!.split("\n").at(-1)).toBe(
      `${PUBLIC_URL}/permissions/req_1`,
    )
  })
})

describe("permissionLinkIn", () => {
  const result = (text: string) => ({
    content: [{ type: "text" as const, text }],
  })

  it("reads the link alone or as a Markdown link, on PCP's own address", () => {
    expect(
      permissionLinkIn(result(`x\n${PUBLIC_URL}/permissions/a1`), PUBLIC_URL)
        ?.request,
    ).toBe("a1")
    expect(
      permissionLinkIn(
        result(`x\n[Allow it?](${PUBLIC_URL}/permissions/a1)`),
        PUBLIC_URL,
      )?.url,
    ).toBe(`${PUBLIC_URL}/permissions/a1`)
    expect(
      permissionLinkIn(
        result("x\nhttps://evil.example/permissions/a1"),
        PUBLIC_URL,
      ),
    ).toBeNull()
    expect(
      permissionLinkIn(
        result(`${PUBLIC_URL}/permissions/a1\nthen more`),
        PUBLIC_URL,
      ),
    ).toBeNull()
  })
})
