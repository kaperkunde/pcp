import { BlockList, isIP } from "node:net"

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
  ["::", 128], // unspecified
  ["::1", 128], // loopback
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

/** The host of a URL without the brackets an IPv6 literal carries. */
export function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "")
}

export class AddressBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly address: string,
  ) {
    super(
      `${host} resolves to ${address}, a private or local address, and this endpoint only reaches public ones. The owner can allow private addresses in its settings.`,
    )
    this.name = "AddressBlockedError"
  }
}
