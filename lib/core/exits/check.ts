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
 * - Its private, link-local (the cloud metadata service at
 *   169.254.169.254 among them) and other non-public ranges: only for a
 *   token whose "private" line allows private addresses, as web fetch
 *   follows it from PCP's side.
 * - PCP's own addresses: never, as for web fetch.
 * - Every other address is public, and passes.
 */

export type ExitVerdict = "ok" | "private" | "own"

const loopback = new BlockList()
loopback.addSubnet("127.0.0.0", 8, "ipv4")
loopback.addSubnet("0.0.0.0", 8, "ipv4")
loopback.addSubnet("::", 127, "ipv6") // unspecified and ::1
loopback.addSubnet("::ffff:127.0.0.0", 104, "ipv6")
loopback.addSubnet("::ffff:0.0.0.0", 104, "ipv6")

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

  if (isPublicAddress(value)) {
    return "ok"
  }

  return allowPrivate ? "ok" : "private"
}
