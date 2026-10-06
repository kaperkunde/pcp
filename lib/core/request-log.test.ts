import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { logDir } from "./data-dir"
import { LOG_SCAN_LINES } from "./log-limits"
import {
  appendRequestLog,
  noteOwnerAsked,
  pruneRequestLog,
  readRequestLog,
  withLogNote,
  type RequestLogEntry,
} from "./request-log"
import { scratchDatabase } from "./test-db"

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

function line(entry: Partial<RequestLogEntry>): string {
  return JSON.stringify({
    ts: "2026-10-01T12:00:00.000Z",
    vaultId: "v",
    tokenId: "t",
    tool: "call_tool",
    ok: true,
    ms: 3,
    ...entry,
  })
}

/** A day's file, as appendRequestLog writes it. */
function day(name: string, lines: string[]): void {
  mkdirSync(logDir(), { recursive: true })
  writeFileSync(
    path.join(logDir(), `mcp-${name}.jsonl`),
    lines.map((text) => `${text}\n`).join(""),
  )
}

describe("appendRequestLog", () => {
  it("cuts the names a caller chose, so a request cannot grow the log at will", async () => {
    await appendRequestLog({
      vaultId: "v",
      tokenId: "t",
      tool: "get_endpoint",
      server: "s".repeat(5000),
      upstreamTool: "u".repeat(5000),
      ok: false,
      ms: 1,
    })

    const file = readdirSync(logDir())[0]!
    const entry = JSON.parse(
      readFileSync(path.join(logDir(), file), "utf8"),
    ) as {
      server: string
      upstreamTool: string
    }

    expect(entry.server).toHaveLength(80)
    expect(entry.upstreamTool).toHaveLength(80)
  })
})

describe("a call's note", () => {
  it("keeps what the code under it learned, for that call alone", async () => {
    const [outer, inner] = await withLogNote(async (outer) => {
      const inner = await withLogNote(async (inner) => {
        noteOwnerAsked("req-1")
        return inner
      })
      return [outer, inner]
    })

    expect(inner).toEqual({ asked: true, request: "req-1" })
    expect(outer).toEqual({})
  })

  it("is nothing outside a logged call", () => {
    expect(() => noteOwnerAsked("req-1")).not.toThrow()
  })
})

describe("readRequestLog", () => {
  it("reads a vault's own lines, newest first across days, and skips what is not a line", async () => {
    day("2026-09-30", [line({ tool: "search_tools" })])
    day("2026-10-01", [
      line({ tool: "describe_tool" }),
      line({ tool: "web_fetch", vaultId: "someone-else" }),
      "{not json",
      line({ tool: "call_tool", server: "gmail", upstreamTool: "send" }),
    ])

    const { entries, next } = await readRequestLog("v")

    expect(entries.map((entry) => entry.tool)).toEqual([
      "call_tool",
      "describe_tool",
      "search_tools",
    ])
    expect(entries[0]).toMatchObject({
      server: "gmail",
      upstreamTool: "send",
      outcome: "ok",
      id: "2026-10-01:3",
    })
    expect(next).toBeNull()
  })

  it("filters by token, outcome and tool or server", async () => {
    day("2026-10-01", [
      line({ tokenId: "a", tool: "search_tools" }),
      line({ tokenId: "b", tool: "call_tool", server: "Gmail", ok: false }),
      line({ tokenId: "a", tool: "call_tool", asked: true, request: "r1" }),
    ])

    const tools = async (query: Parameters<typeof readRequestLog>[1]) =>
      (await readRequestLog("v", query)).entries.map(
        (entry) => `${entry.tokenId}:${entry.tool}:${entry.outcome}`,
      )

    expect(await tools({ tokenId: "a" })).toEqual([
      "a:call_tool:asked",
      "a:search_tools:ok",
    ])
    expect(await tools({ outcome: "error" })).toEqual(["b:call_tool:error"])
    expect(await tools({ outcome: "asked" })).toEqual(["a:call_tool:asked"])
    expect(await tools({ text: "gmail" })).toEqual(["b:call_tool:error"])
  })

  it("pages with a cursor that still holds while the day grows", async () => {
    day("2026-09-30", [line({ tool: "one" }), line({ tool: "two" })])
    day("2026-10-01", [line({ tool: "three" }), line({ tool: "four" })])

    const first = await readRequestLog("v", { limit: 3 })
    expect(first.entries.map((entry) => entry.tool)).toEqual([
      "four",
      "three",
      "two",
    ])
    expect(first.next).toBe("2026-09-30:1")

    // A line written meanwhile does not move the next page.
    day("2026-10-01", [
      line({ tool: "three" }),
      line({ tool: "four" }),
      line({ tool: "five" }),
    ])

    const second = await readRequestLog("v", { limit: 3, cursor: first.next! })
    expect(second.entries.map((entry) => entry.tool)).toEqual(["one"])
    expect(second.next).toBeNull()
  })

  it("stops after so many lines read, and says where to go on", async () => {
    day(
      "2026-10-01",
      Array.from({ length: LOG_SCAN_LINES + 5 }, () =>
        line({ vaultId: "someone-else" }),
      ),
    )

    const page = await readRequestLog("v")
    expect(page.entries).toEqual([])
    expect(page.next).toBe("2026-10-01:5")
  })

  it("ignores a cursor that is not one", async () => {
    day("2026-10-01", [line({ tool: "one" })])

    const page = await readRequestLog("v", { cursor: "../../etc:1" })
    expect(page.entries.map((entry) => entry.tool)).toEqual(["one"])
  })
})

describe("pruneRequestLog", () => {
  it("deletes the days older than the ones kept, and nothing else in the folder", async () => {
    day("2026-09-01", [line({})])
    day("2026-09-29", [line({})])
    day("2026-09-30", [line({})])
    day("2026-10-06", [line({})])
    writeFileSync(path.join(logDir(), "notes.txt"), "mine")

    const removed = await pruneRequestLog(
      7,
      new Date("2026-10-06T10:00:00.000Z"),
    )

    expect(removed).toBe(2)
    expect(readdirSync(logDir()).sort()).toEqual([
      "mcp-2026-09-30.jsonl",
      "mcp-2026-10-06.jsonl",
      "notes.txt",
    ])
  })

  it("keeps only today with one day", async () => {
    day("2026-10-05", [line({})])
    day("2026-10-06", [line({})])

    expect(await pruneRequestLog(1, new Date("2026-10-06T00:00:01Z"))).toBe(1)
    expect(readdirSync(logDir())).toEqual(["mcp-2026-10-06.jsonl"])
  })
})
