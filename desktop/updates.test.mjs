import { describe, expect, it } from "vitest"

import {
  INSTALL_REQUEST_FRESH_MS,
  isNewer,
  parseHealth,
  pendingInstall,
  updaterMode,
} from "./updates.mjs"

const STARTED = Date.parse("2026-10-05T10:00:00Z")
const request = (overrides = {}) => ({
  id: "r1",
  at: "2026-10-05T10:05:00.000Z",
  version: "0.3.0",
  ...overrides,
})
const health = (installRequest) => ({ version: "0.2.0", installRequest })

describe("updaterMode", () => {
  it("installs itself only when packaged as auto", () => {
    expect(updaterMode({ pcpUpdater: "auto" }, true)).toBe("auto")
    expect(updaterMode({ pcpUpdater: "manual" }, true)).toBe("manual")
    expect(updaterMode({}, true)).toBe("manual")
    expect(updaterMode({ pcpUpdater: "auto" }, false)).toBe("manual")
  })
})

describe("parseHealth", () => {
  it("reads the version and the owner's request", () => {
    expect(
      parseHealth(
        JSON.stringify({
          status: "ok",
          version: "0.2.0",
          installRequest: request(),
        }),
      ),
    ).toEqual(health(request()))
  })

  it("reads a server that says nothing about updates", () => {
    expect(parseHealth('{"status":"ok"}')).toEqual({
      version: null,
      installRequest: null,
    })
  })

  it("ignores a request it cannot trust, and answers that are not PCP's", () => {
    for (const bad of [{ version: "latest" }, { at: "yesterday" }, { id: 7 }]) {
      expect(
        parseHealth(
          JSON.stringify({ status: "ok", installRequest: request(bad) }),
        )?.installRequest,
      ).toBeNull()
    }
    expect(parseHealth("<html>")).toBeNull()
    expect(parseHealth('{"status":"error"}')).toBeNull()
  })
})

describe("pendingInstall", () => {
  const state = (overrides = {}) => ({
    startedAt: STARTED,
    handled: new Set(),
    current: "0.2.0",
    now: Date.parse("2026-10-05T10:06:00Z"),
    ...overrides,
  })

  it("starts a fresh request for a later version", () => {
    expect(pendingInstall(health(request()), state())).toEqual(request())
  })

  it("never acts on a request twice, or on one from before this start", () => {
    expect(
      pendingInstall(health(request()), state({ handled: new Set(["r1"]) })),
    ).toBeNull()
    expect(
      pendingInstall(
        health(request({ at: "2026-10-05T09:59:00.000Z" })),
        state(),
      ),
    ).toBeNull()
  })

  it("lets an old request go, and one for this version or an earlier one", () => {
    expect(
      pendingInstall(
        health(request()),
        state({ now: STARTED + 5 * 60_000 + INSTALL_REQUEST_FRESH_MS + 1 }),
      ),
    ).toBeNull()
    expect(
      pendingInstall(health(request({ version: "0.2.0" })), state()),
    ).toBeNull()
    expect(
      pendingInstall(health(request({ version: "0.1.9" })), state()),
    ).toBeNull()
  })

  it("does nothing without a request", () => {
    expect(pendingInstall(health(null), state())).toBeNull()
    expect(pendingInstall(null, state())).toBeNull()
  })
})

describe("isNewer", () => {
  it("orders by number", () => {
    expect(isNewer("0.10.0", "0.9.9")).toBe(true)
    expect(isNewer("0.2.0", "0.2.0")).toBe(false)
    expect(isNewer("garbage", "0.2.0")).toBe(false)
  })
})
