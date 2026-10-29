import { createHmac, hkdfSync } from "node:crypto"

import type { PermissionKind } from "./constants"
import type { VaultContext } from "./context"
import { decryptString } from "./crypto"
import { db } from "./db"

/**
 * What a permission request is about, kept so that changes to one thing
 * meet (permissions.ts): an assistant's second change to a skill, a shared
 * memory or the owner's note on an item, made while its first still waits
 * for the owner, folds into that request (one diff against what the owner
 * has, approved together), and another token's request for the same thing
 * is shown beside it as a conflict, since approving one makes the other
 * stale.
 *
 * The target (`skill:<id>`, `memory:<id or path>`, `note:<kind>:<id>`) is
 * stored only as an HMAC under a key derived from the vault's data key, like
 * a call handle's (call-handles.ts): equal targets compare equal, and the
 * column says nothing without the key.
 */

const KEY_LABEL = "pcp permission target v1"

/** The kinds whose requests fold, and show their conflicts. */
export const FOLDING_KINDS: ReadonlySet<PermissionKind> = new Set([
  "skill_change",
  "memory_share",
  "memory_change",
  "note_change",
])

export function isFoldingKind(kind: string): boolean {
  return FOLDING_KINDS.has(kind as PermissionKind)
}

/** The keyed hash of a request's target, as `target_key` stores it. */
export function targetKey(dek: Buffer, target: string): string {
  const key = Buffer.from(
    hkdfSync("sha256", dek, Buffer.alloc(0), KEY_LABEL, 32),
  )

  return createHmac("sha256", key).update(target).digest("hex")
}

/** A request still waiting for the owner, with what it asks for. */
export type OpenRequest<T> = { id: string; args: T }

/**
 * The newest request of `kind` from the token about `target` that the owner
 * has not answered yet, with its arguments opened; null when there is none.
 */
export async function openRequestFor<T>(
  ctx: VaultContext,
  tokenId: string,
  kind: PermissionKind,
  target: string,
): Promise<OpenRequest<T> | null> {
  const row = await db().permissionRequest.findFirst({
    where: {
      vaultId: ctx.vaultId,
      tokenId,
      kind,
      targetKey: targetKey(ctx.dek, target),
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, argsCiphertext: true },
  })

  if (!row) {
    return null
  }

  return {
    id: row.id,
    args: JSON.parse(
      decryptString(
        ctx.dek,
        Buffer.from(row.argsCiphertext),
        `permission_request:${row.id}`,
      ),
    ) as T,
  }
}

/** What an assistant is told when its change joined a waiting request. */
export function foldedText(id: string, kind: PermissionKind): string {
  return kind === "note_change"
    ? `Replaced the note in your open request ${id}; the owner reads only this one.`
    : `Folded into the open request ${id} (now shows both changes); the owner approves them together.`
}
