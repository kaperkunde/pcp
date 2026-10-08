import os from "node:os"

import { describe, expect, it, vi } from "vitest"

import { isOwnAddress, isPublicAddress, pcpPorts } from "./address"

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

  it("refuses the cloud hosts that live in public ranges, and the older IPv6 wrappers", () => {
    for (const address of [
      "168.63.129.16", // Azure's virtual host address
      "100.100.100.200", // Alibaba's metadata service (carrier-grade NAT range)
      "::7f00:1", // IPv4-compatible loopback
      "::a00:1", // IPv4-compatible 10.0.0.1
      "::ffff:0:7f00:1", // SIIT-translated loopback
      "::ffff:0:a9fe:a9fe", // SIIT-translated 169.254.169.254
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    // Its neighbours are ordinary public addresses.
    expect(isPublicAddress("168.63.129.15")).toBe(true)
    expect(isPublicAddress("168.63.129.17")).toBe(true)
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

describe("isOwnAddress", () => {
  it("is PCP's own ports on loopback, unspecified and this machine's addresses", () => {
    const [app] = pcpPorts()

    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "::1",
      "[::1]",
      "::",
      "::ffff:127.0.0.1",
    ]) {
      expect(isOwnAddress(address, app!), address).toBe(true)
    }
  })

  it("leaves other ports and other machines alone", () => {
    const [app] = pcpPorts()

    expect(isOwnAddress("127.0.0.1", 5173)).toBe(false)
    expect(isOwnAddress("192.168.1.20", app!)).toBe(false)
    expect(isOwnAddress("8.8.8.8", app!)).toBe(false)
  })

  it("knows this machine's addresses in their IPv6 spellings too", () => {
    const [app] = pcpPorts()
    const spy = vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [
        { address: "192.0.2.2", family: "IPv4" },
        { address: "2001:db8:0:0::5", family: "IPv6" },
      ] as os.NetworkInterfaceInfo[],
    })

    try {
      for (const address of [
        "192.0.2.2",
        "::ffff:192.0.2.2",
        "[::ffff:192.0.2.2]",
        "::ffff:c000:202",
        "0:0:0:0:0:ffff:c000:0202",
        "2001:db8::5",
        "2001:DB8:0000::0005",
      ]) {
        expect(isOwnAddress(address, app!), address).toBe(true)
      }

      expect(isOwnAddress("::ffff:192.0.2.3", app!)).toBe(false)
      expect(isOwnAddress("2001:db8::6", app!)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it("counts extra listeners of PCP's own, such as the browser's proxy", () => {
    expect(isOwnAddress("127.0.0.1", 41234)).toBe(false)
    expect(isOwnAddress("127.0.0.1", 41234, [41234])).toBe(true)
  })

  it("follows the ports PCP is told to use", () => {
    const before = process.env.PORT

    try {
      process.env.PORT = "4321"
      expect(isOwnAddress("127.0.0.1", 4321)).toBe(true)
    } finally {
      if (before === undefined) delete process.env.PORT
      else process.env.PORT = before
    }
  })
})
