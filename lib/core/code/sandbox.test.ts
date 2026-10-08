import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  sandboxExecutor,
  sandboxLanguages,
  startSandbox,
  stopSandbox,
} from "./sandbox"
import type { Bridge, BridgeReply } from "./types"

// The sandbox executor against the real runner (sandbox/runner.py), run
// here in development mode: as this user, with no container around it. The
// container's own walls (no network, a user of the program's own, the
// socket out of its reach) are the compose file's and the image's; this is
// the protocol and the runner: programs in bash and Python reaching the
// bridge through `pcp`, what they print, how they end, and stopping.

const has = (command: string) =>
  spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0
const ready = has("python3") && has("bash") && has("jq")

const root = path.resolve(__dirname, "../../..")
let dir: string
let runner: ChildProcess | null = null

function run(
  language: "bash" | "python",
  code: string,
  bridge: Bridge = async () => ({ ok: true, value: null }),
  signal = new AbortController().signal,
) {
  return sandboxExecutor(language)({ code, bridge, signal })
}

describe.skipIf(!ready)("the sandbox runner", () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pcp-sandbox-"))
    const socket = path.join(dir, "socket", "sandbox.sock")
    await startSandbox(socket)

    runner = spawn("python3", [path.join(root, "sandbox", "runner.py")], {
      env: {
        ...process.env,
        PCP_SANDBOX_SOCKET: socket,
        PCP_SANDBOX_WORK: path.join(dir, "work"),
        PCP_SANDBOX_SAME_USER: "1",
      },
      stdio: "ignore",
    })

    const deadline = Date.now() + 10_000
    while (sandboxLanguages().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }, 20_000)

  afterAll(async () => {
    runner?.kill("SIGKILL")
    await stopSandbox()
    rmSync(dir, { recursive: true, force: true })
  })

  it("says hello with the languages it has", () => {
    expect(sandboxLanguages()).toEqual(["bash", "python"])
  })

  it("runs a shell program whose pcp calls reach the bridge", async () => {
    const seen: Array<{ op: string; payload: unknown }> = []
    const result = await run(
      "bash",
      `
      names=$(pcp call files list '{"dir": "/"}' --fields names | jq -c '.names | length')
      echo "names: $names"
      echo "to stderr" >&2
      `,
      async (op, payload) => {
        seen.push({ op, payload })
        return { ok: true, value: { names: ["a", "b", "c"] } }
      },
    )

    expect(result).toMatchObject({
      kind: "done",
      returned: null,
      output: "names: 3\nto stderr\n",
    })
    expect(seen).toEqual([
      {
        op: "call",
        payload: {
          server: "files",
          tool: "list",
          args: { dir: "/" },
          fields: ["names"],
        },
      },
    ])
  })

  it("runs a Python program with the pcp module", async () => {
    const seen: string[] = []
    const result = await run(
      "python",
      `
import pcp
answer = pcp.call("files", "count", {"x": 1})
handle = pcp.keep({"total": answer["n"]}, name="total.json")
print(answer["n"], handle["$result"], pcp.read(handle))
`,
      async (op): Promise<BridgeReply> => {
        seen.push(op)
        return op === "call"
          ? { ok: true, value: { n: 7 } }
          : op === "keep"
            ? { ok: true, value: { $result: "r1", type: "application/json" } }
            : { ok: true, value: "kept text" }
      },
    )

    expect(result).toMatchObject({ kind: "done", output: "7 r1 kept text\n" })
    expect(seen).toEqual(["call", "keep", "read"])
  })

  it("reads and keeps a file's bytes, and lists tools, from Python and the shell", async () => {
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.alloc(64, 0xfe),
    ])
    const seen: Array<{ op: string; payload: unknown }> = []
    const bridge: Bridge = async (op, payload) => {
      seen.push({ op, payload })
      return op === "read"
        ? { ok: true, value: pdf.toString("base64") }
        : op === "tools"
          ? { ok: true, value: [{ name: "list", access: "allowed" }] }
          : { ok: true, value: { $result: "k1" } }
    }

    const python = await run(
      "python",
      `
import pcp
data = pcp.read({"$result": "f1"}, as_="bytes")
pcp.keep(data[:4], name="head.bin")
pcp.keep("aGk=", encoding="base64", type="text/plain")
print(len(data), data[:8].decode(), [tool["name"] for tool in pcp.tools("files")])
`,
      bridge,
    )
    const shell = await run(
      "bash",
      `
      pcp read --bytes f1 > file.pdf
      head -c 8 file.pdf; echo
      pcp keep --bytes --type application/pdf file.pdf > /dev/null
      pcp tools | jq -c .
      `,
      bridge,
    )

    expect(python).toMatchObject({
      kind: "done",
      output: `${pdf.length} %PDF-1.7 ['list']\n`,
    })
    expect(shell).toMatchObject({
      kind: "done",
      output: '%PDF-1.7\n[{"name":"list","access":"allowed"}]\n',
    })
    expect(seen).toEqual([
      { op: "read", payload: { id: "f1", as: "base64" } },
      {
        op: "keep",
        payload: {
          value: pdf.subarray(0, 4).toString("base64"),
          encoding: "base64",
          type: "application/octet-stream",
          name: "head.bin",
        },
      },
      {
        op: "keep",
        payload: { value: "aGk=", encoding: "base64", type: "text/plain" },
      },
      { op: "tools", payload: { server: "files" } },
      { op: "read", payload: { id: "f1", as: "base64" } },
      {
        op: "keep",
        payload: {
          value: pdf.toString("base64"),
          encoding: "base64",
          type: "application/pdf",
        },
      },
      { op: "tools", payload: { server: null } },
    ])
  })

  it("hands a refusal to the program as an error, and says how it exited", async () => {
    const result = await run(
      "bash",
      `pcp call files burn || echo "pcp said no ($?)"; exit 3`,
      async () => ({ ok: false, error: "The owner has blocked files/burn." }),
    )

    expect(result).toMatchObject({
      kind: "error",
      message: "The program exited with status 3.",
      output: "pcp: The owner has blocked files/burn.\npcp said no (1)\n",
    })
  })

  it("stops the program at a stop, and nothing of it runs after", async () => {
    const result = await run(
      "bash",
      `echo before; pcp call mail send; echo after`,
      async () => ({ stop: true }),
    )

    expect(result).toMatchObject({ kind: "stopped", output: "before\n" })
  })

  it("stops a program when the run is aborted, with the reason", async () => {
    const controller = new AbortController()
    const running = run(
      "bash",
      `echo started; sleep 30; echo late`,
      undefined,
      controller.signal,
    )

    await new Promise((resolve) => setTimeout(resolve, 500))
    controller.abort("The run took longer than 3 minutes and was stopped.")

    expect(await running).toMatchObject({
      kind: "error",
      message: "The run took longer than 3 minutes and was stopped.",
      output: "started\n",
    })
  })

  it("takes one program at a time, in order", async () => {
    const [first, second] = await Promise.all([
      run("bash", "sleep 0.3; echo first"),
      run("bash", "echo second"),
    ])

    expect(first.output).toBe("first\n")
    expect(second.output).toBe("second\n")
  })
})

describe("without a runner", () => {
  it("says the sandbox is not connected, and JavaScript runs without it", async () => {
    const result = await sandboxExecutor("bash")({
      code: "echo hi",
      bridge: async () => ({ ok: true, value: null }),
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ kind: "error" })
    expect((result as { message: string }).message).toContain(
      "is not connected to PCP",
    )
  })
})
