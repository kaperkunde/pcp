import net from "node:net"

import { afterEach, describe, expect, it } from "vitest"

import { newDohCache, resolveThroughExit, type DohResolver } from "./doh"
import { startFakeDoh, type FakeDoh } from "./fake-doh"

let resolvers: FakeDoh[] = []

afterEach(async () => {
  await Promise.all(resolvers.map((resolver) => resolver.close()))
  resolvers = []
})

/**
 * The exit's side, for these tests: a connection to the resolver's IP goes
 * to the test resolver for it on loopback, and the addresses asked for are
 * noted.
 */
function exit(byAddress: Record<string, FakeDoh | null>) {
  const dialed: string[] = []
  return {
    dialed,
    connect: async (address: string, port: number) => {
      dialed.push(`${address}:${port}`)
      const resolver = byAddress[address]
      if (!resolver) throw new Error("connect ECONNREFUSED")
      const socket = net.connect(resolver.port, "127.0.0.1")
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
      return socket
    },
  }
}

function asResolver(fake: FakeDoh, address: string): DohResolver {
  return { address, servername: fake.servername, ca: fake.ca }
}

describe("resolveThroughExit", () => {
  it("looks a name up over HTTPS through the exit, A and AAAA, CNAMEs followed", async () => {
    const fake = await startFakeDoh({
      "www.example.com": { cname: "edge.example.net" },
      "edge.example.net": {
        a: ["93.184.216.34"],
        aaaa: ["2606:2800:220:1::1"],
      },
    })
    resolvers.push(fake)
    const side = exit({ "1.1.1.1": fake })

    const addresses = await resolveThroughExit("WWW.Example.com", {
      connect: side.connect,
      cache: newDohCache(),
      resolvers: [asResolver(fake, "1.1.1.1")],
    })

    expect(addresses).toEqual(["93.184.216.34", "2606:2800:220:1::1"])
    expect(side.dialed).toEqual(["1.1.1.1:443", "1.1.1.1:443"])
    expect(fake.asked.sort()).toEqual([
      "A www.example.com",
      "AAAA www.example.com",
    ])
  })

  it("asks again about where a chain stops without an address", async () => {
    const fake = await startFakeDoh({
      "a.example": { cname: "b.example" },
      "b.example": { a: ["93.184.216.34"] },
    })
    resolvers.push(fake)
    // The resolver answers only the CNAME for a.example; its answer for
    // a.example ends at b.example, which is asked about next.
    const original = fake.asked
    const cache = newDohCache()
    const addresses = await resolveThroughExit("a.example", {
      connect: exit({ "1.1.1.1": fake }).connect,
      cache,
      resolvers: [asResolver(fake, "1.1.1.1")],
    })

    expect(addresses).toEqual(["93.184.216.34"])
    expect(original.length).toBeGreaterThanOrEqual(2)
  })

  it("keeps answers for their TTL, per cache", async () => {
    const fake = await startFakeDoh({
      "a.example": { a: ["93.184.216.34"], ttl: 300 },
    })
    resolvers.push(fake)
    const cache = newDohCache()
    const options = {
      connect: exit({ "1.1.1.1": fake }).connect,
      cache,
      resolvers: [asResolver(fake, "1.1.1.1")],
    }

    await resolveThroughExit("a.example", options)
    const asked = fake.asked.length
    await resolveThroughExit("a.example", options)
    expect(fake.asked.length).toBe(asked)

    // Another exit's cache asks for itself.
    await resolveThroughExit("a.example", { ...options, cache: newDohCache() })
    expect(fake.asked.length).toBe(asked * 2)
  })

  it("falls back to the second resolver", async () => {
    const fake = await startFakeDoh(
      { "a.example": { a: ["93.184.216.34"] } },
      { servername: "dns.quad9.net" },
    )
    resolvers.push(fake)
    const side = exit({ "1.1.1.1": null, "9.9.9.9": fake })

    const addresses = await resolveThroughExit("a.example", {
      connect: side.connect,
      cache: newDohCache(),
      resolvers: [
        { address: "1.1.1.1", servername: "cloudflare-dns.com" },
        asResolver(fake, "9.9.9.9"),
      ],
    })

    expect(addresses).toEqual(["93.184.216.34"])
    expect(side.dialed).toContain("9.9.9.9:443")
  })

  it("checks the resolver's certificate against its name", async () => {
    const fake = await startFakeDoh({ "a.example": { a: ["93.184.216.34"] } })
    resolvers.push(fake)

    await expect(
      resolveThroughExit("a.example", {
        connect: exit({ "1.1.1.1": fake }).connect,
        cache: newDohCache(),
        // Its own certificate is for cloudflare-dns.com, not this name.
        resolvers: [
          { address: "1.1.1.1", servername: "dns.quad9.net", ca: fake.ca },
        ],
      }),
    ).rejects.toThrow()
  })

  it("says a name has no address", async () => {
    const fake = await startFakeDoh({})
    resolvers.push(fake)

    await expect(
      resolveThroughExit("gone.example", {
        connect: exit({ "1.1.1.1": fake }).connect,
        cache: newDohCache(),
        resolvers: [asResolver(fake, "1.1.1.1")],
      }),
    ).rejects.toThrow(/has no address/)
  })
})
