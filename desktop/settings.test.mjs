import { describe, expect, it } from "vitest"

import { DEFAULT_PORT, lanAddresses, parseSettings } from "./settings.mjs"

describe("parseSettings", () => {
  it("defaults when there is no file", () => {
    expect(parseSettings(null)).toEqual({
      port: DEFAULT_PORT,
      acceptConnectionsFromNetwork: false,
      toldAboutTray: false,
    })
  })

  it("reads what the file holds", () => {
    expect(
      parseSettings(
        '{"port": 8080, "acceptConnectionsFromNetwork": true, "toldAboutTray": true}',
      ),
    ).toEqual({
      port: 8080,
      acceptConnectionsFromNetwork: true,
      toldAboutTray: true,
    })
  })

  it("falls back to PORT in the environment, then the default", () => {
    expect(parseSettings("{}", { PORT: "4000" }).port).toBe(4000)
    expect(parseSettings('{"port": 5000}', { PORT: "4000" }).port).toBe(5000)
    expect(parseSettings("{}", { PORT: "" }).port).toBe(DEFAULT_PORT)
  })

  it("replaces malformed values with defaults rather than refusing to start", () => {
    expect(parseSettings("not json").port).toBe(DEFAULT_PORT)
    expect(parseSettings("[1]").port).toBe(DEFAULT_PORT)
    for (const port of ['"abc"', "0", "65536", "3.5", "-1", "null"]) {
      expect(parseSettings(`{"port": ${port}}`).port, port).toBe(DEFAULT_PORT)
    }
    expect(parseSettings('{"port": "8080"}').port).toBe(8080)
    expect(
      parseSettings('{"acceptConnectionsFromNetwork": "yes"}')
        .acceptConnectionsFromNetwork,
    ).toBe(false)
  })
})

describe("lanAddresses", () => {
  it("lists the IPv4 addresses that are not loopback, once each, sorted", () => {
    expect(
      lanAddresses({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [
          { address: "192.168.1.23", family: "IPv4", internal: false },
          { address: "fe80::1", family: "IPv6", internal: false },
        ],
        en1: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
        en2: [{ address: "192.168.1.23", family: "IPv4", internal: false }],
        down: undefined,
      }),
    ).toEqual(["10.0.0.5", "192.168.1.23"])
  })
})
