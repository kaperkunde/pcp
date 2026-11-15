import dns from "node:dns"
import { BlockList, isIP } from "node:net"
import os from "node:os"

import { isPublicAddress } from "@kaperkunde/security/net"

/**
 * Which addresses count as "public" is @kaperkunde/security's isPublicAddress:
 * an endpoint that only reaches public addresses (publicOnly) refuses
 * loopback, private, link-local, carrier-grade NAT, multicast and
 * documentation ranges, and the IPv6 forms that wrap an IPv4 address
 * (mapped, NAT64, 6to4, Teredo), because a request to any of them would
 * reach something on the host's own network: a cloud metadata service, an
 * admin port, another service of the owner's. What is PCP's own (its ports
 * on this machine, isOwnAddress) is decided here.
 */
export { isPublicAddress }

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

/** What a name resolves to, every address of it. */
export type HostLookup = (host: string) => Promise<string[]>

export const lookupAll: HostLookup = async (host) =>
  (await dns.promises.lookup(host, { all: true })).map((entry) => entry.address)

/** How long a proposal waits for a name to resolve before it goes unflagged. */
const LOOKUP_TIMEOUT_MS = 5_000

/**
 * Whether a host an assistant proposed is, or resolves to, a private,
 * loopback or link-local address, for the owner's approval page. A name that
 * does not resolve in time is not flagged: nothing is reached through it
 * before the owner agrees, and the connection checks again (a name can answer
 * differently later). What it resolves to is never told to the assistant.
 */
async function resolvesPrivate(
  host: string,
  lookup: HostLookup,
): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, "")

  if (isIP(bare) !== 0) {
    return !isPublicAddress(bare)
  }

  let addresses: string[]
  let timer: NodeJS.Timeout | undefined

  try {
    addresses = await Promise.race([
      lookup(bare),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("no answer")),
          LOOKUP_TIMEOUT_MS,
        )
      }),
    ])
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }

  return addresses.some((address) => !isPublicAddress(address))
}

/**
 * The owner's note on the hosts of a server an assistant proposed that are,
 * or resolve to, a private or local address: "mail.lan is, or resolves to,
 * a private or local address." Null when none is.
 */
export async function privateHostsNote(
  hosts: readonly string[],
  lookup: HostLookup = lookupAll,
): Promise<string | null> {
  const unique = [...new Set(hosts)]
  const found = await Promise.all(
    unique.map((host) => resolvesPrivate(host, lookup)),
  )
  const flagged = unique.filter((_, index) => found[index])

  if (flagged.length === 0) {
    return null
  }

  return flagged.length === 1
    ? `${flagged[0]} is, or resolves to, a private or local address.`
    : `${flagged.join(" and ")} are, or resolve to, private or local addresses.`
}

export class AddressBlockedError extends Error {
  constructor(
    readonly host: string,
    /**
     * The address refused, where the check that refused it says: an IP
     * literal, or an exit's lookup. Empty for a name the socket's lookup
     * refused (@kaperkunde/security's publicLookup names only the host).
     */
    readonly address: string,
    /** What refused it, as the owner calls it: an endpoint or a server. */
    noun: "endpoint" | "server" = "endpoint",
  ) {
    // The address stays out of the message, which can reach an assistant:
    // for a name it would say what the owner's DNS holds.
    super(
      `${host} is, or resolves to, a private or local address, and this ${noun} only reaches public ones. The owner can allow private addresses on its page in PCP.`,
    )
    this.name = "AddressBlockedError"
  }
}
