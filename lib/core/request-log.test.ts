import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { randomBytes } from "node:crypto"

import { logDir } from "./data-dir"
import { LOG_SCAN_LINES } from "./log-limits"
import {
  appendKeylessLog,
  appendRequestLog,
  noteExitUsed,
  noteOwnerAsked,
  pruneRequestLog,
  readRequestLog,
  sealRequestLogDay,
  unsealedLogDays,
  withLogNote,
  type RequestLogEntry,
} from "./request-log"
import { scratchDatabase } from "./test-db"

let cleanup: () => Promise<void>

/** The vault's id and key, as the Log page reads with. */
const reader = { vaultId: "v", dek: randomBytes(32) }

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
      dek: reader.dek,
      tokenId: "t",
      tool: "get_endpoint",
      server: "s".repeat(5000),
      upstreamTool: "u".repeat(5000),
      ok: false,
      ms: 1,
    })

    const [entry] = (await readRequestLog(reader)).entries

    expect(entry!.server).toHaveLength(80)
    expect(entry!.upstreamTool).toHaveLength(80)
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
    day("2026-09-30", [line({ tool: "search" })])
    day("2026-10-01", [
      line({ tool: "describe" }),
      line({ tool: "web_fetch", vaultId: "someone-else" }),
      "{not json",
      line({ tool: "call_tool", server: "gmail", upstreamTool: "send" }),
    ])

    const { entries, next } = await readRequestLog(reader)

    expect(entries.map((entry) => entry.tool)).toEqual([
      "call_tool",
      "describe",
      "search",
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
      line({ tokenId: "a", tool: "search" }),
      line({ tokenId: "b", tool: "call_tool", server: "Gmail", ok: false }),
      line({ tokenId: "a", tool: "call_tool", asked: true, request: "r1" }),
    ])

    const tools = async (query: Parameters<typeof readRequestLog>[1]) =>
      (await readRequestLog(reader, query)).entries.map(
        (entry) => `${entry.tokenId}:${entry.tool}:${entry.outcome}`,
      )

    expect(await tools({ tokenId: "a" })).toEqual([
      "a:call_tool:asked",
      "a:search:ok",
    ])
    expect(await tools({ outcome: "error" })).toEqual(["b:call_tool:error"])
    expect(await tools({ outcome: "asked" })).toEqual(["a:call_tool:asked"])
    expect(await tools({ text: "gmail" })).toEqual(["b:call_tool:error"])
  })

  it("pages with a cursor that still holds while the day grows", async () => {
    day("2026-09-30", [line({ tool: "one" }), line({ tool: "two" })])
    day("2026-10-01", [line({ tool: "three" }), line({ tool: "four" })])

    const first = await readRequestLog(reader, { limit: 3 })
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

    const second = await readRequestLog(reader, {
      limit: 3,
      cursor: first.next!,
    })
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

    const page = await readRequestLog(reader)
    expect(page.entries).toEqual([])
    expect(page.next).toBe("2026-10-01:5")
  })

  it("ignores a cursor that is not one", async () => {
    day("2026-10-01", [line({ tool: "one" })])

    const page = await readRequestLog(reader, { cursor: "../../etc:1" })
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

describe("noteExitUsed", () => {
  it("names the exit on the call's line, or on a line of its own outside a call", async () => {
    const note = await withLogNote(async (current) => {
      noteExitUsed({
        vaultId: "v",
        dek: reader.dek,
        tokenId: "t",
        tool: "web_fetch",
        exit: "us-vps",
      })
      return current
    })
    expect(note).toEqual({ exit: "us-vps" })

    noteExitUsed({
      vaultId: "v",
      dek: reader.dek,
      tokenId: "t",
      tool: "tabs",
      exit: "eu-vps",
    })
    await expect
      .poll(async () => (await readRequestLog(reader, {})).entries)
      .toMatchObject([{ tool: "tabs", exit: "eu-vps", ok: true }])
  })
})

describe("a line's names", () => {
  it("are sealed under the vault's key: the file holds none of them", async () => {
    await appendRequestLog({
      vaultId: "v",
      dek: reader.dek,
      tokenId: "t",
      tool: "execute_write",
      server: "SERVER-SLUG-MARKER",
      upstreamTool: "TOOL-NAME-MARKER",
      ok: false,
      ms: 4,
      error: "ERROR-MARKER failed",
      secret: "SECRET-NAME-MARKER",
      origin: "https://origin-marker.example",
      exit: "EXIT-MARKER",
      asked: true,
      request: "req-1",
    })

    const raw = readdirSync(logDir())
      .map((name) => readFileSync(path.join(logDir(), name), "utf8"))
      .join("")
    for (const marker of [
      "execute_write",
      "SERVER-SLUG-MARKER",
      "TOOL-NAME-MARKER",
      "ERROR-MARKER",
      "SECRET-NAME-MARKER",
      "origin-marker",
      "EXIT-MARKER",
    ]) {
      expect(raw).not.toContain(marker)
    }
    // What paging and the cleanup need stays plain.
    expect(JSON.parse(raw)).toMatchObject({
      vaultId: "v",
      tokenId: "t",
      ok: false,
      asked: true,
      request: "req-1",
    })

    expect((await readRequestLog(reader)).entries).toMatchObject([
      {
        tool: "execute_write",
        server: "SERVER-SLUG-MARKER",
        upstreamTool: "TOOL-NAME-MARKER",
        error: "ERROR-MARKER failed",
        secret: "SECRET-NAME-MARKER",
        origin: "https://origin-marker.example",
        exit: "EXIT-MARKER",
        outcome: "asked",
      },
    ])
    // Searched by name once opened.
    expect(
      (await readRequestLog(reader, { text: "tool-name-marker" })).entries,
    ).toHaveLength(1)
  })

  it("open only under the vault's key, and only on their own line", async () => {
    await appendRequestLog({
      vaultId: "v",
      dek: reader.dek,
      tokenId: "t",
      tool: "search",
      ok: true,
      ms: 1,
    })
    await appendRequestLog({
      vaultId: "v",
      dek: reader.dek,
      tokenId: "t2",
      tool: "execute_read",
      ok: true,
      ms: 1,
    })

    expect(
      (await readRequestLog({ vaultId: "v", dek: randomBytes(32) })).entries,
    ).toEqual([])

    // A sealed part moved onto the other line opens on neither.
    const [name] = readdirSync(logDir())
    const file = path.join(logDir(), name!)
    const [first, second] = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((text) => JSON.parse(text) as Record<string, unknown>)
    writeFileSync(
      file,
      `${JSON.stringify({ ...second, sealed: first!.sealed })}\n`,
    )
    expect((await readRequestLog(reader)).entries).toEqual([])
  })

  it("from before are read as they are, and sealed where they are", async () => {
    day("2026-10-01", [
      line({ tool: "describe", server: "OLD-SLUG-MARKER" }),
      line({ tool: "web_fetch", vaultId: "someone-else" }),
      line({ tool: "search" }),
    ])
    const before = (await readRequestLog(reader)).entries

    expect(await unsealedLogDays("v")).toEqual(["2026-10-01"])
    expect(await sealRequestLogDay(reader, "2026-10-01")).toBe(true)
    expect(await unsealedLogDays("v")).toEqual([])
    expect(await sealRequestLogDay(reader, "2026-10-01")).toBe(false)

    const raw = readFileSync(
      path.join(logDir(), "mcp-2026-10-01.jsonl"),
      "utf8",
    )
    expect(raw).not.toContain("OLD-SLUG-MARKER")
    // Another vault's line is left as it is.
    expect(raw).toContain("someone-else")
    // Each line where it was, so the Log page's places hold.
    expect((await readRequestLog(reader)).entries).toEqual(before)
  })

  it("of a link's use, which holds no key, are PCP's own and stay plain", async () => {
    await appendKeylessLog({
      vaultId: "v",
      tokenId: "t",
      tool: "file_link/download",
      ok: true,
      ms: 2,
    })

    expect((await readRequestLog(reader)).entries).toMatchObject([
      { tool: "file_link/download", ok: true },
    ])
    expect(await unsealedLogDays("v")).toEqual([])
  })

  it("leave the cleanup nothing to open: it deletes old days by their names", async () => {
    await appendRequestLog({
      vaultId: "v",
      dek: reader.dek,
      tokenId: "t",
      tool: "search",
      ok: true,
      ms: 1,
    })
    day("2020-01-01", [line({})])

    expect(await pruneRequestLog(7)).toBe(1)
    expect((await readRequestLog(reader)).entries).toHaveLength(1)
  })
})
