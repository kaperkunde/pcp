import { isIP } from "node:net"
import type { Duplex } from "node:stream"

import { AddressBlockedError } from "../openapi/address"
import { exitVerdict, type ExitVerdict } from "./check"
import {
  DOH_RESOLVERS,
  newDohCache,
  resolveThroughExit,
  type DohCache,
  type DohResolver,
} from "./doh"
import { httpConnect, socks5Connect, type ProxyAuth } from "./handshake"

/**
 * How a connection leaves through an exit. An exit is a way out to the
 * internet from somewhere else than PCP's machine: the SSH server itself
 * (kind "ssh": a direct-tcpip channel from it), or a VPN container PCP
 * started on one (kind "service": a channel to the container's proxy on
 * the SSH server's loopback, then CONNECT or SOCKS5 on to the address).
 *
 * Whatever the kind, a connection goes through `dial`: the name is looked
 * up through the exit (exits/doh.ts), every address it has is checked from
 * the exit's side (exits/check.ts), and the exit connects to the address
 * that was checked, never to a name. An assistant names an exit, never a
 * destination of the exit's: the address comes from the URL it asked for,
 * checked here.
 */

/** A raw connection from the exit's side, the part that differs per kind. */
export type ExitTransport = {
  /**
   * Opens a connection from the exit to an address and port. Called only
   * with an address `dial` checked, or a fixed resolver's (exits/doh.ts).
   */
  open: (address: string, port: number, signal?: AbortSignal) => Promise<Duplex>
  /** The exit's own addresses, refused as destinations. */
  own: () => readonly string[]
}

export type ExitInfo = {
  id: string
  name: string
  /** The owner's label for where it comes out ("US — home VPS"); may be "". */
  label: string
}

/** An address the exit may not reach, for the token or for anyone. */
export class ExitAddressError extends AddressBlockedError {
  constructor(
    host: string,
    address: string,
    readonly verdict: Exclude<ExitVerdict, "ok">,
    readonly exit: string,
  ) {
    super(host, address)
    this.name = "ExitAddressError"
    this.message =
      verdict === "own"
        ? `${host} is, or resolves to, an address of the exit ${exit} itself (its loopback or its own address), which PCP never reaches through it.`
        : verdict === "local"
          ? `${host} is, or resolves to, a link-local or cloud metadata address on the exit ${exit}'s side, which PCP never reaches through an exit, for any token.`
          : `${host} is, or resolves to, a private or local address on the exit ${exit}'s side, which the owner has not allowed for this token. They can allow private addresses on the token's page in PCP.`
  }
}

export type ExitDialer = ExitInfo & {
  /** Every address of a name, looked up through the exit. */
  resolve: (host: string, signal?: AbortSignal) => Promise<string[]>
  /** Decides one address as the exit would connect to it. */
  verdict: (address: string, port: number, allowPrivate: boolean) => ExitVerdict
  /**
   * A connection from the exit to `host`:`port`: looked up through the
   * exit, every address checked, the checked one dialed (IPv4 first, then
   * IPv6 if that fails). Throws ExitAddressError for a refused address.
   */
  dial: (
    host: string,
    port: number,
    options: { allowPrivate: boolean; signal?: AbortSignal },
  ) => Promise<Duplex>
}

const CACHES = Symbol.for("pcp.exits.doh")

/** One answer cache per exit, kept across requests and bundles. */
function cacheFor(exitId: string): DohCache {
  const holder = globalThis as unknown as { [CACHES]?: Map<string, DohCache> }
  holder[CACHES] ??= new Map()
  let cache = holder[CACHES].get(exitId)

  if (!cache) {
    cache = newDohCache()
    holder[CACHES].set(exitId, cache)
  }

  return cache
}

/** Forgets an exit's answers (it changed, or went). */
export function forgetExitAnswers(exitId: string): void {
  const holder = globalThis as unknown as { [CACHES]?: Map<string, DohCache> }
  holder[CACHES]?.delete(exitId)
}

function bare(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase()
}

export function makeExitDialer(
  info: ExitInfo,
  transport: ExitTransport,
  {
    resolvers = DOH_RESOLVERS,
    cache = cacheFor(info.id),
  }: { resolvers?: readonly DohResolver[]; cache?: DohCache } = {},
): ExitDialer {
  const resolve = async (host: string, signal?: AbortSignal) => {
    const name = bare(host)

    if (isIP(name)) {
      return [name]
    }

    return resolveThroughExit(name, {
      connect: (address, port, abort) => transport.open(address, port, abort),
      cache,
      resolvers,
      signal,
    })
  }

  const verdict = (address: string, port: number, allowPrivate: boolean) =>
    exitVerdict(address, port, { own: transport.own(), allowPrivate })

  return {
    ...info,
    resolve,
    verdict,
    async dial(host, port, { allowPrivate, signal }) {
      const addresses = await resolve(host, signal)

      // Every address the name has must pass: the one dialed is ours to
      // pick, but a name that answers with a private one is refused whole.
      for (const address of addresses) {
        const said = verdict(address, port, allowPrivate)

        if (said !== "ok") {
          throw new ExitAddressError(bare(host), address, said, info.name)
        }
      }

      const v4 = addresses.find((address) => isIP(address) === 4)
      const v6 = addresses.find((address) => isIP(address) === 6)
      const tries = [v4, v6].filter((address): address is string => !!address)
      let failure: unknown = new Error(`${host} has no address.`)

      for (const address of tries) {
        try {
          return await transport.open(address, port, signal)
        } catch (error) {
          signal?.throwIfAborted()
          failure = error
        }
      }

      throw failure
    },
  }
}

/**
 * The transport of an exit container (gluetun, wireproxy): a connection to
 * the container's proxy on the SSH server's own loopback, which PCP
 * published there itself, then the proxy's handshake to the checked
 * address. `loopback` opens the channel to that one port; nothing else
 * reaches the SSH server's loopback.
 */
export function proxiedTransport(
  loopback: (signal?: AbortSignal) => Promise<Duplex>,
  proxy: { protocol: "http" | "socks5"; auth?: ProxyAuth },
  own: () => readonly string[],
): ExitTransport {
  return {
    own,
    async open(address, port, signal) {
      const socket = await loopback(signal)

      try {
        if (proxy.protocol === "socks5") {
          await socks5Connect(socket, address, port, {
            auth: proxy.auth,
            signal,
          })
        } else {
          await httpConnect(socket, address, port, { auth: proxy.auth, signal })
        }
      } catch (error) {
        socket.destroy()
        throw error
      }

      return socket
    },
  }
}
