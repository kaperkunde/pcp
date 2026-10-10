/**
 * A copy of pcp.gg's relay (tunnel/relay/ in kaperkunde/pcp-gg), for tests
 * only: PCP never runs a relay. The pcp.gg app's own directory is left out;
 * tests answer for it.
 *
 * What the relay asks the pcp.gg app: whose key this is, which names it may
 * serve, and which tunnels must go (a key replaced, an account closed). The
 * relay keeps no database of its own.
 */

export type Authorization = {
  deviceId: string
  hostnames: string[]
  /** Changes whenever the key or the names change; a stale one is cut. */
  generation: number
}

export type OnlineTunnel = {
  deviceId: string
  generation: number
  connectedAt: string
}

export interface Directory {
  /** null: no such key. Throws when the app cannot be asked. */
  authorize(token: string): Promise<Authorization | null>
  /** Tells the app who is online; answers with the devices to cut. */
  report(online: OnlineTunnel[]): Promise<{ disconnect: string[] }>
}
