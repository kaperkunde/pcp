import { wipeVault } from "./backup"
import { withBrowserClosed } from "./browser/runtime"
import type { VaultContext } from "./context"
import { db } from "./db"
import { PcpError } from "./errors"
import { deleteRequestLog } from "./request-log"
import { forgetSetupState } from "./vault"

/**
 * Deleting the vault, for the owner who wants PCP back as it was before
 * setup: every row of the vault goes in one transaction, the way a restore
 * wipes it (wipeVault), and the request log with it. What is left is a PCP
 * that is not set up, whose setup page makes the next vault.
 *
 * The machine's settings (lib/core/host-settings.ts: pcp.gg, Dynamic DNS,
 * HTTPS, updates, cleanup, resources) stay, and so do the apps registered
 * with PCP's own sign-in (oauth_client, which open nothing by themselves):
 * they belong to the machine, not to the vault, and turning HTTPS off under
 * the owner's feet would cut off the page they are on. Nothing here makes the vault readable without a credential:
 * the caller has confirmed it is the owner (confirmOwner) before this runs.
 */
export async function deleteVault(ctx: VaultContext): Promise<void> {
  // The vault's browser would save its sign-ins over the deleted profile:
  // closed first, and none started until the rows are gone.
  await withBrowserClosed(ctx, () =>
    db().$transaction(
      async (tx) => {
        const existing = await tx.vault.findUnique({
          where: { id: ctx.vaultId },
          select: { id: true },
        })

        if (!existing) {
          throw new PcpError("state", "The vault is already deleted.")
        }

        await wipeVault(tx, ctx.vaultId)
      },
      { timeout: 60_000 },
    ),
  )

  forgetSetupState()
  await deleteRequestLog()
}
