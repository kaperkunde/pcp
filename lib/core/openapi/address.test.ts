import { describe, expect, it } from "vitest"

import { isPublicAddress } from "./address"

describe("isPublicAddress", () => {
  it("accepts ordinary public addresses", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "172.15.255.255",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "169.253.1.1",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
    ]) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it("refuses loopback, private, link-local and metadata addresses", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.255.254",
      "0.0.0.0",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // carrier-grade NAT
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fe80::1",
      "fe80::1%eth0",
      "fc00::1",
      "fd12:3456:789a::1",
      "ff02::1",
      "2001:db8::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it("refuses the IPv6 forms that wrap a blocked IPv4 address", () => {
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:a9fe:a9fe", // 169.254.169.254
      "64:ff9b::7f00:1",
      "64:ff9b::a00:1",
      "2002:7f00:1::1",
      "2002:a9fe:a9fe::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    // A mapped public address is still public.
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true)
  })

  it("refuses anything that is not an address", () => {
    for (const address of [
      "",
      "localhost",
      "example.com",
      "1.2.3",
      "999.1.1.1",
      "1.2.3.4.5",
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it("accepts an IPv6 literal with brackets, as a URL host has them", () => {
    expect(isPublicAddress("[2606:4700:4700::1111]")).toBe(true)
    expect(isPublicAddress("[::1]")).toBe(false)
  })
})
