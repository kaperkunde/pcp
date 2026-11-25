import type { FetchLike } from "@modelcontextprotocol/client"

import { checkedFetch } from "../openapi/transport"
import { googleProduct } from "./products"

/**
 * Where PCP talks to Google: the sign-in, the token and revoke addresses,
 * who signed in, and each product's MCP server. Constants, written once;
 * tests point them at a server of their own (`setGoogleEndpointsForTest`),
 * and only then are requests allowed to reach a private address. Everything
 * PCP sends to Google goes to a public address only, no redirect followed.
 */

export type GoogleEndpoints = {
  authorize: string
  token: string
  revoke: string
  userinfo: string
  /** The issuer a sign-in answer's `iss` must match (RFC 9207). */
  issuer: string
  /** A product's MCP server address. */
  mcp: (productId: string) => string
  /** Requests may reach a private address (tests only). */
  privateAddresses: boolean
}

const GOOGLE: GoogleEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  issuer: "https://accounts.google.com",
  mcp: (productId) => googleProduct(productId)?.url ?? "",
  privateAddresses: false,
}

let current: GoogleEndpoints = GOOGLE

export function googleEndpoints(): GoogleEndpoints {
  return current
}

/** Tests: point PCP at a fake Google; no argument puts the real one back. */
export function setGoogleEndpointsForTest(
  endpoints?: Partial<GoogleEndpoints>,
): void {
  current = endpoints ? { ...GOOGLE, ...endpoints } : GOOGLE
}

/** The fetch every request to Google goes through. */
export function googleFetch(): FetchLike {
  return current.privateAddresses
    ? (input, init) => fetch(input, { ...init, redirect: "error" })
    : checkedFetch({ publicOnly: true })
}
