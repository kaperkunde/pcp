import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { logDir } from "./data-dir"
import { appendRequestLog } from "./request-log"
import { scratchDatabase } from "./test-db"

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

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
