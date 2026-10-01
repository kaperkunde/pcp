import "server-only"

import { headers } from "next/headers"

import type { VaultContext } from "@/lib/core/context"
import {
  getSetting,
  getVaultSetting,
  SETTING_PUBLIC_URL,
} from "@/lib/core/settings"
import { ownerVault } from "@/lib/core/vault"

/**
 * Where PCP is reachable from outside, for OAuth redirect URIs and the
 * endpoint address shown to the owner. Nothing has to be configured: the
 * request's own Host (and a proxy's X-Forwarded-* headers) say where it
 * came in. The owner can pin it in Settings when that guess is wrong.
 */

export function originFromHeaders(hdrs: Headers): string {
  const proto = hdrs.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http"
  const host =
    hdrs.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    hdrs.get("host") ||
    "localhost:3000"

  return `${proto}://${host}`
}

export async function requestOrigin(): Promise<string> {
  return originFromHeaders(await headers())
}

export async function publicUrlFor(
  ctx: VaultContext,
  request?: Request,
): Promise<string> {
  const pinned = await getSetting(ctx, SETTING_PUBLIC_URL)

  if (pinned) {
    return pinned
  }

  return request ? originFromHeaders(request.headers) : requestOrigin()
}

/**
 * The public URL for a request nobody signed in to make (an authorization
 * server fetching PCP's client metadata document): the owner's pinned
 * address, or where the request came in.
 */
export async function publicUrlWithoutSession(
  request: Request,
): Promise<string> {
  const vault = await ownerVault()
  const pinned = vault
    ? await getVaultSetting(vault.id, SETTING_PUBLIC_URL)
    : null

  return pinned || originFromHeaders(request.headers)
}
