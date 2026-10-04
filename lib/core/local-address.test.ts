import { describe, expect, it } from "vitest"

import { isLocalAddress, isLocalHostname } from "./local-address"

describe("isLocalHostname", () => {
  it("knows localhost, loopback and private addresses", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "[::1]",
      "::1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.9",
      "192.168.1.23",
      "169.254.10.10",
      "100.64.0.1", // carrier-grade NAT: still not reachable from outside
      "fe80::1",
      "fd00::1",
    ]) {
      expect(isLocalHostname(host), host).toBe(true)
    }
  })

  it("knows a LAN name when it sees one", () => {
    for (const host of [
      "nas",
      "pcp-box",
      "pcp.local",
      "pcp.lan",
      "router.home",
      "pcp.home.arpa",
      "service.internal",
      "app.localhost",
      "pcp.local.",
    ]) {
      expect(isLocalHostname(host), host).toBe(true)
    }
  })

  it("treats public names and addresses as reachable", () => {
    for (const host of [
      "pcp.example.com",
      "example.com",
      "8.8.8.8",
      "2606:4700:4700::1111",
      "[2606:4700:4700::1111]",
      "my-house.duckdns.org",
      "localhost.example.com",
      "home.example.net",
    ]) {
      expect(isLocalHostname(host), host).toBe(false)
    }
  })
})

describe("isLocalAddress", () => {
  it("looks at the host of a URL", () => {
    expect(isLocalAddress("http://localhost:3000")).toBe(true)
    expect(isLocalAddress("http://192.168.1.5:3000/mcp")).toBe(true)
    expect(isLocalAddress("http://[::1]:3000")).toBe(true)
    expect(isLocalAddress("https://pcp.example.com")).toBe(false)
    expect(isLocalAddress("http://my-house.duckdns.org:3000")).toBe(false)
  })

  it("is false for something that is not a URL", () => {
    expect(isLocalAddress("")).toBe(false)
    expect(isLocalAddress("localhost:3000")).toBe(false)
    expect(isLocalAddress("not a url")).toBe(false)
  })
})
