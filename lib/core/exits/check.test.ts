import { describe, expect, it } from "vitest"

import { exitVerdict, isLoopbackAddress } from "./check"

const side = { own: ["203.0.113.7", "2001:db8::7"], allowPrivate: false }

describe("exitVerdict: addresses judged from the exit's side", () => {
  it("lets public addresses through", () => {
    expect(exitVerdict("93.184.216.34", 443, side)).toBe("ok")
    expect(exitVerdict("2606:2800:220:1::1", 443, side)).toBe("ok")
  })

  it("never reaches the exit's own loopback, even with private addresses allowed", () => {
    for (const address of [
      "127.0.0.1",
      "127.8.9.10",
      "::1",
      "0.0.0.0",
      "::",
      "::ffff:127.0.0.1",
    ]) {
      expect(exitVerdict(address, 8080, side)).toBe("own")
      expect(exitVerdict(address, 8080, { ...side, allowPrivate: true })).toBe(
        "own",
      )
    }
  })

  it("never reaches the exit's own address", () => {
    expect(
      exitVerdict("203.0.113.7", 22, { ...side, allowPrivate: true }),
    ).toBe("own")
    expect(exitVerdict("[2001:DB8::7]", 22, side)).toBe("own")
  })

  it("refuses the exit's network and the metadata service without a private line", () => {
    for (const address of [
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "fe80::1",
      "fd00::1",
    ]) {
      expect(exitVerdict(address, 80, side)).toBe("private")
      expect(exitVerdict(address, 80, { ...side, allowPrivate: true })).toBe(
        "ok",
      )
    }
  })

  it("refuses what is not an address", () => {
    expect(exitVerdict("example.com", 80, side)).toBe("private")
  })

  it("knows a loopback address in any spelling", () => {
    expect(isLoopbackAddress("[::1]")).toBe(true)
    expect(isLoopbackAddress("::ffff:7f00:1")).toBe(true)
    expect(isLoopbackAddress("8.8.8.8")).toBe(false)
  })
})
