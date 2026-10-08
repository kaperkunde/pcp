import { BlockList, isIP } from "node:net"
import os from "node:os"

/**
 * Which addresses count as "public". An endpoint that only reaches public
 * addresses (publicOnly) refuses loopback, private, link-local, carrier-grade
 * NAT, multicast and documentation ranges, and the IPv6 forms that wrap an
 * IPv4 address (mapped, NAT64, 6to4), because a request to any of them would
 * reach something on the host's own network: a cloud metadata service, an
 * admin port, another service of the owner's.
 *
 * node:net's BlockList compares an IPv4-mapped IPv6 address ("::ffff:7f00:1")
 * against the IPv4 rules, so the mapped form of a blocked address is blocked.
 */

const blocked = new BlockList()

const V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["168.63.129.16", 32], // Azure's virtual host address (a public range)
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
]

const V6: Array<[string, number]> = [
  ["::", 96], // unspecified, loopback, and IPv4-compatible (::7f00:1)
  ["::ffff:0:0:0", 96], // SIIT: an IPv4 address translated into IPv6
  ["64:ff9b::", 96], // NAT64: wraps an IPv4 address
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: wraps an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
]

for (const [network, prefix] of V4) blocked.addSubnet(network, prefix, "ipv4")
for (const [network, prefix] of V6) blocked.addSubnet(network, prefix, "ipv6")

/** True for a public IP address; false for anything else, malformed included. */
export function isPublicAddress(address: string): boolean {
  // A zone id ("fe80::1%eth0") is not part of the address.
  const bare = address.replace(/%.*$/, "").replace(/^\[|\]$/g, "")
  const family = isIP(bare)

  if (family === 0) {
    return false
  }

  return !blocked.check(bare, family === 4 ? "ipv4" : "ipv6")
}

const loopback = new BlockList()
loopback.addSubnet("127.0.0.0", 8, "ipv4")
loopback.addSubnet("0.0.0.0", 8, "ipv4")
loopback.addSubnet("::", 127, "ipv6") // unspecified and ::1

function portFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 && value < 65536
    ? value
    : fallback
}

/**
 * The ports PCP itself listens on: the app (Next's PORT) and its own HTTP
 * and HTTPS listeners (lib/core/network/edge.ts reads the same variables).
 */
export function pcpPorts(): number[] {
  return [
    portFromEnv("PORT", 3000),
    portFromEnv("PCP_HTTP_PORT", 80),
    portFromEnv("PCP_HTTPS_PORT", 443),
  ]
}

/**
 * One spelling per address, so a set lookup cannot be dodged: an IPv6
 * address in its shortest form, and an IPv4-mapped one ("::ffff:192.0.2.2",
 * "::ffff:c000:202") as the IPv4 address it reaches.
 */
function canonicalAddress(bare: string): string {
  if (isIP(bare) !== 6) {
    return bare
  }

  // The URL parser writes IPv6 in its shortest form, the mapped tail in hex.
  const short = new URL(`http://[${bare}]`).hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(short)

  if (!mapped) {
    return short
  }

  const high = parseInt(mapped[1]!, 16)
  const low = parseInt(mapped[2]!, 16)

  return [high >> 8, high & 255, low >> 8, low & 255].join(".")
}

/** The addresses of this machine's own network interfaces. */
function interfaceAddresses(): Set<string> {
  const found = new Set<string>()

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      found.add(
        canonicalAddress(entry.address.replace(/%.*$/, "").toLowerCase()),
      )
    }
  }

  return found
}

/**
 * Whether an address and port reach PCP itself: one of its ports on a
 * loopback or unspecified address, or on an address of this machine. A
 * request there would hand an assistant PCP's own pages, so it is refused
 * even where private addresses are allowed. `extraPorts` adds listeners of
 * PCP's own that are not in the environment (the browser's proxy).
 */
export function isOwnAddress(
  address: string,
  port: number,
  extraPorts: readonly number[] = [],
): boolean {
  if (!pcpPorts().includes(port) && !extraPorts.includes(port)) {
    return false
  }

  const bare = address
    .replace(/%.*$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
  const family = isIP(bare)

  if (family === 0) {
    return true
  }

  return (
    loopback.check(bare, family === 4 ? "ipv4" : "ipv6") ||
    interfaceAddresses().has(canonicalAddress(bare))
  )
}

/** The host of a URL without the brackets an IPv6 literal carries. */
export function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "")
}

export class AddressBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly address: string,
  ) {
    // The address stays out of the message, which can reach an assistant:
    // for a name it would say what the owner's DNS holds.
    super(
      `${host} is, or resolves to, a private or local address, and this endpoint only reaches public ones. The owner can allow private addresses in its settings.`,
    )
    this.name = "AddressBlockedError"
  }
}
