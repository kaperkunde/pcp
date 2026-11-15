import { BlockList, isIP } from "node:net"

import { isOwnAddress, isPublicAddress } from "../openapi/address"

/**
 * Which addresses an exit may connect to, judged from the exit's side:
 * what is private there is the exit's own network, not PCP's.
 *
 * - The exit's own loopback (127.0.0.0/8, ::1, and the unspecified
 *   addresses that reach it) and the exit's own address (where PCP's SSH
 *   connection went): never, whatever the levels say. The one way to the
 *   exit's loopback is the port of an exit container PCP started itself,
 *   which never comes through here (exits/dial.ts proxiedTransport).
 * - Link-local addresses (169.254.0.0/16, fe80::/10) and the cloud
 *   metadata services' (169.254.169.254, AWS's fd00:ec2::254, Alibaba's
 *   100.100.100.200, Azure's 168.63.129.16): never, whatever the levels
 *   say. Through an exit they are the exit's machine's own: its cloud
 *   credentials, not a site on its network.
 * - Its private and other non-public ranges: only for a token whose
 *   "private" line allows private addresses, as web fetch follows it from
 *   PCP's side.
 * - PCP's own addresses: never, as for web fetch.
 * - Every other address is public, and passes.
 */

export type ExitVerdict = "ok" | "private" | "own" | "local"

const loopback = new BlockList()
loopback.addSubnet("127.0.0.0", 8, "ipv4")
loopback.addSubnet("0.0.0.0", 8, "ipv4")
loopback.addSubnet("::", 127, "ipv6") // unspecified and ::1
loopback.addSubnet("::ffff:127.0.0.0", 104, "ipv6")
loopback.addSubnet("::ffff:0.0.0.0", 104, "ipv6")

/** Link-local, and the cloud metadata services, in every spelling PCP dials. */
const local = new BlockList()
local.addSubnet("169.254.0.0", 16, "ipv4")
local.addAddress("100.100.100.200", "ipv4")
local.addAddress("168.63.129.16", "ipv4")
local.addSubnet("fe80::", 10, "ipv6")
local.addAddress("fd00:ec2::254", "ipv6")
local.addSubnet("::ffff:169.254.0.0", 112, "ipv6")
local.addAddress("::ffff:100.100.100.200", "ipv6")
local.addAddress("::ffff:168.63.129.16", "ipv6")
// NAT64 (RFC 6052): the exit's resolver may hand these out for IPv4 ones.
local.addSubnet("64:ff9b::a9fe:0", 112, "ipv6")
local.addAddress("64:ff9b::6464:64c8", "ipv6")
local.addAddress("64:ff9b::a83f:8110", "ipv6")

function bare(address: string): string {
  return address
    .replace(/%.*$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
}

/** Whether an address is a loopback (or unspecified) one, on whichever host. */
export function isLoopbackAddress(address: string): boolean {
  const value = bare(address)
  const family = isIP(value)
  return family !== 0 && loopback.check(value, family === 4 ? "ipv4" : "ipv6")
}

export type ExitSide = {
  /** The exit's own addresses: where PCP's connection to it went. */
  own: readonly string[]
  /** The token may reach private addresses (its "private" line). */
  allowPrivate: boolean
}

/** Whether an address is link-local or a cloud metadata service's. */
export function isLocalOrMetadataAddress(address: string): boolean {
  const value = bare(address)
  const family = isIP(value)
  return family !== 0 && local.check(value, family === 4 ? "ipv4" : "ipv6")
}

/** Decides one address an exit is about to connect to. */
export function exitVerdict(
  address: string,
  port: number,
  { own, allowPrivate }: ExitSide,
): ExitVerdict {
  const value = bare(address)

  if (isIP(value) === 0) {
    return "private"
  }

  if (
    isLoopbackAddress(value) ||
    own.some((mine) => bare(mine) === value) ||
    isOwnAddress(value, port)
  ) {
    return "own"
  }

  if (isLocalOrMetadataAddress(value)) {
    return "local"
  }

  if (isPublicAddress(value)) {
    return "ok"
  }

  return allowPrivate ? "ok" : "private"
}
