import type { VaultContext } from "../context"
import { asBytes, decryptString, encryptString } from "../crypto"
import { db } from "../db"
import { checkLimits, sameLimits, type ServerLimits } from "./config"

/**
 * A server's own limits, sealed under the vault's key as
 * "mcp_server:<id>:limits" (lib/core/gate/). They are the instance's own:
 * a linked repository's document never carries or writes them, an export
 * carries the sealed column as it is.
 */

function aad(serverId: string): string {
  return `mcp_server:${serverId}:limits`
}

/** Sealed limits, opened; none when there are none or they do not open. */
export function openLimits(
  ctx: VaultContext,
  serverId: string,
  sealed: Uint8Array | null,
): ServerLimits {
  if (!sealed) {
    return {}
  }

  try {
    return checkLimits(
      JSON.parse(decryptString(ctx.dek, Buffer.from(sealed), aad(serverId))),
    )
  } catch {
    // Limits that do not open (or a newer PCP's fields) follow the
    // defaults rather than failing every call.
    return {}
  }
}

/** A server's own limits: what was set for it, nothing else. */
export async function readServerLimits(
  ctx: VaultContext,
  serverId: string,
): Promise<ServerLimits> {
  const row = await db().mcpServer.findFirst({
    where: { id: serverId, vaultId: ctx.vaultId },
    select: { limits: true },
  })

  return openLimits(ctx, serverId, row?.limits ?? null)
}

/**
 * Writes a server's own limits, checked; none clears them. Only the
 * owner's save and what they agreed to on PCP's page call this.
 */
export async function writeServerLimits(
  ctx: VaultContext,
  serverId: string,
  limits: ServerLimits,
): Promise<ServerLimits> {
  const checked = checkLimits(limits)
  const empty = sameLimits(checked, {})

  await db().mcpServer.update({
    where: { id: serverId, vaultId: ctx.vaultId },
    data: {
      limits: empty
        ? null
        : asBytes(
            encryptString(ctx.dek, JSON.stringify(checked), aad(serverId)),
          ),
    },
  })

  return checked
}

/**
 * What a proposal was made on: the server's own limits as the owner was
 * shown them, so a change is made only over those.
 */
export function limitsBasis(limits: ServerLimits): string {
  return JSON.stringify(
    Object.keys(limits)
      .sort()
      .map((key) => [key, limits[key as keyof ServerLimits]]),
  )
}
