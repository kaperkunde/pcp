import { describe, expect, it } from "vitest"

import { javaScriptExecutor, runJavaScript } from "./quickjs"
import type { Bridge, BridgeReply } from "./types"

// The QuickJS executor on its own, with a bridge that answers from a table:
// what the program can reach, how it gets answers, and what stops it.

function run(
  code: string,
  bridge: Bridge = async () => ({ ok: true, value: null }),
) {
  return runJavaScript({ code, bridge, signal: new AbortController().signal })
}

describe("what a program can reach", () => {
  it("has the language and pcp, and nothing of Node's", async () => {
    const result = await run(`
      return {
        node: [typeof require, typeof process, typeof fetch, typeof setTimeout,
               typeof module, typeof Buffer, typeof WebAssembly, typeof __pcp_host],
        pcp: Object.keys(pcp).sort(),
        frozen: Object.isFrozen(pcp),
      }
    `)

    expect(result.kind).toBe("done")
    expect(JSON.parse((result as { returned: string }).returned)).toEqual({
      node: Array(8).fill("undefined"),
      pcp: ["call", "keep", "read"],
      frozen: true,
    })
  })

  it("cannot reach the host through constructors or eval", async () => {
    const result = await run(`
      const viaConstructor = (() => {}).constructor("return typeof process")()
      const viaEval = eval("typeof require")
      return [viaConstructor, viaEval, typeof globalThis.process]
    `)

    expect(result).toMatchObject({
      kind: "done",
      returned: '["undefined","undefined","undefined"]',
    })
  })
})

describe("talking to the bridge", () => {
  it("sends each request as an operation and JSON, and hands back the value", async () => {
    const seen: Array<{ op: string; payload: unknown }> = []
    const result = await run(
      `
      const one = await pcp.call("files", "list", { dir: "/" }, { fields: ["name"] })
      const [two, three] = await Promise.all([pcp.read({ $result: "r1", type: "text/plain" }), pcp.keep({ a: 1 }, { name: "a.json" })])
      console.log("got", one, two)
      return { one, two, three }
    `,
      async (op, payload) => {
        seen.push({ op, payload })
        return { ok: true, value: `${op} answered` }
      },
    )

    expect(seen).toEqual([
      {
        op: "call",
        payload: {
          server: "files",
          tool: "list",
          args: { dir: "/" },
          fields: ["name"],
        },
      },
      { op: "read", payload: { id: "r1" } },
      {
        op: "keep",
        payload: { value: '{"a":1}', type: "application/json", name: "a.json" },
      },
    ])
    expect(result).toMatchObject({
      kind: "done",
      returned:
        '{"one":"call answered","two":"read answered","three":"keep answered"}',
      output: "got call answered read answered\n",
    })
  })

  it("throws a refusal into the program, which may catch it", async () => {
    const result = await run(
      `
      try {
        await pcp.call("files", "delete")
      } catch (error) {
        return "caught: " + error.message
      }
    `,
      async () => ({ ok: false, error: "The owner has blocked files/delete." }),
    )

    expect(result).toMatchObject({
      kind: "done",
      returned: '"caught: The owner has blocked files/delete."',
    })
  })

  it("stops at a stop, and runs nothing of the program after it, caught or not", async () => {
    const after: string[] = []
    const result = await run(
      `
      try {
        await pcp.call("mail", "send")
      } catch {
        await pcp.call("mail", "after")
      }
      await pcp.call("mail", "after")
    `,
      async (op, payload): Promise<BridgeReply> => {
        const tool = (payload as { tool: string }).tool
        if (tool === "send") return { stop: true }
        after.push(tool)
        return { ok: true, value: null }
      },
    )

    expect(result.kind).toBe("stopped")
    expect(after).toEqual([])
  })
})

describe("how a run ends", () => {
  it("says null for a program that returns nothing", async () => {
    expect(await run(`const x = 1`)).toMatchObject({
      kind: "done",
      returned: null,
    })
  })

  it("reports a syntax error and an uncaught error with the program's line", async () => {
    const syntax = await run(`return (`)
    expect(syntax.kind).toBe("error")
    expect((syntax as { message: string }).message).toContain("SyntaxError")

    const thrown = await run(`const a = 1\nnull.x`)
    expect(thrown.kind).toBe("error")
    expect((thrown as { message: string }).message).toMatch(/TypeError/)
    expect((thrown as { message: string }).message).toContain("code.js:2")
  })

  it("keeps what was printed before an error", async () => {
    const result = await run(
      `console.log("first"); throw new Error("then this")`,
    )

    expect(result).toMatchObject({
      kind: "error",
      output: "first\n",
    })
    expect((result as { message: string }).message).toContain("then this")
  })

  it("stops a program that computes too long, even one that catches", async () => {
    const started = Date.now()
    const result = await javaScriptExecutor({ cpuMs: 300 })({
      code: `for (;;) { try { while (true) {} } catch {} }`,
      bridge: async () => ({ ok: true, value: null }),
      signal: new AbortController().signal,
    })

    expect(result.kind).toBe("error")
    expect((result as { message: string }).message).toContain(
      "more than 0.3 seconds",
    )
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("stops a program that waits on a promise nothing settles", async () => {
    const result = await run(`await new Promise(() => {})`)

    expect(result.kind).toBe("error")
    expect((result as { message: string }).message).toContain(
      "nothing will settle",
    )
  })

  it("stops at once when aborted, with the reason given", async () => {
    const controller = new AbortController()
    const running = runJavaScript({
      code: `await pcp.call("slow", "tool")`,
      bridge: () => new Promise(() => {}),
      signal: controller.signal,
    })

    controller.abort("The run took longer than 3 minutes and was stopped.")

    expect(await running).toMatchObject({
      kind: "error",
      message: "The run took longer than 3 minutes and was stopped.",
    })
  })

  it("refuses memory past its limit", async () => {
    const result = await javaScriptExecutor({ memoryBytes: 32 * 1024 * 1024 })({
      code: `const parts = []; for (;;) parts.push("x".repeat(1 << 16) + parts.length)`,
      bridge: async () => ({ ok: true, value: null }),
      signal: new AbortController().signal,
    })

    expect(result.kind).toBe("error")
    expect((result as { message: string }).message).toMatch(/out of memory/i)
  })

  it("refuses an answer too large for its memory, as an error it can catch", async () => {
    const result = await javaScriptExecutor({ memoryBytes: 32 * 1024 * 1024 })({
      code: `try { await pcp.call("files", "huge") } catch (error) { return error.message }`,
      bridge: async () => ({ ok: true, value: "z".repeat(10_000_000) }),
      signal: new AbortController().signal,
    })

    expect(result.kind).toBe("done")
    expect((result as { returned: string }).returned).toContain(
      "too large for the program's memory (32 MB)",
    )
  })

  it("stops a program whose memory is too full to take an answer", async () => {
    const result = await javaScriptExecutor({ memoryBytes: 32 * 1024 * 1024 })({
      code: `
        const hoard = []
        try { for (;;) hoard.push("x".repeat(1 << 16) + hoard.length) } catch {}
        try { await pcp.call("files", "list") } catch { return "went on" }
        return "went on"
      `,
      bridge: async () => ({ ok: true, value: "z".repeat(4_000_000) }),
      signal: new AbortController().signal,
    })

    expect(result.kind).toBe("error")
    expect((result as { message: string }).message).toContain(
      "ran out of memory (32 MB)",
    )
  })

  it("cuts what it prints past the limit and counts the rest", async () => {
    const result = await run(
      `for (let i = 0; i < 3000; i++) console.log("y".repeat(1000))`,
    )

    expect(result.kind).toBe("done")
    expect(result.output.length).toBe(1_000_000)
    expect(result.dropped).toBe(3000 * 1001 - 1_000_000)
  })

  it("lets one run see nothing of another", async () => {
    await run(`globalThis.leftBehind = "secret"`)

    expect(await run(`return typeof leftBehind`)).toMatchObject({
      returned: '"undefined"',
    })
  })
})
