import { describe, expect, it } from "vitest"

import { EXPORTED_HOST_KEYS } from "../backup-format"
import {
  parsePcpggInput,
  PCPGG_CONFIG_KEY,
  PCPGG_STATUS_KEY,
  pcpggKeyHint,
  readPcpggKey,
} from "./pcpgg"

// The key the owner pastes from their pcp.gg dashboard.

const KEY = "pcpgg_0123456789abcdefABCDEF-_xyz0123456789abcdef"
const now = new Date("2026-10-01T12:00:00Z")

describe("reading a pasted key", () => {
  it("takes the key alone", () => {
    expect(readPcpggKey(`  ${KEY}\n`)).toBe(KEY)
  })

  it("finds it in the command pcp.gg shows for running it by hand", () => {
    expect(
      readPcpggKey(
        `curl -fsSL https://pcp.gg/connector.mjs -o connector.mjs && PCPGG_KEY=${KEY} node connector.mjs`,
      ),
    ).toBe(KEY)
  })

  it("finds nothing in what is not a key", () => {
    expect(readPcpggKey("hunter2")).toBeNull()
    expect(readPcpggKey("pcpgg_short")).toBeNull()
  })

  it("shows only the start of a key", () => {
    expect(pcpggKeyHint(KEY)).toBe("pcpgg_0123…")
  })
})

describe("the pcp.gg form", () => {
  it("needs Let's Encrypt's agreement", () => {
    expect(() =>
      parsePcpggInput({ key: KEY, agreed: false }, null, now),
    ).toThrow(/accept its agreement/)
  })

  it("keeps the saved key when the field is left blank", () => {
    const existing = { key: KEY, agreedAt: "2026-01-01T00:00:00.000Z" }
    expect(parsePcpggInput({ key: " ", agreed: true }, existing, now)).toEqual({
      key: KEY,
      agreedAt: now.toISOString(),
    })
  })

  it("needs a key the first time", () => {
    expect(() => parsePcpggInput({ key: "", agreed: true }, null, now)).toThrow(
      /Paste the connection key/,
    )
  })

  it("refuses something that is not a key", () => {
    expect(() =>
      parsePcpggInput({ key: "my password", agreed: true }, null, now),
    ).toThrow(/starts with pcpgg_/)
  })
})

describe("the key", () => {
  it("stays out of an export", () => {
    const exported: readonly string[] = EXPORTED_HOST_KEYS
    expect(exported).not.toContain(PCPGG_CONFIG_KEY)
    expect(exported).not.toContain(PCPGG_STATUS_KEY)
  })
})
