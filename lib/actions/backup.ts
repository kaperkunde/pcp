"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { readExport, restoreExport } from "@/lib/core/backup"
import type { ExportPreview } from "@/lib/core/backup-format"
import { MAX_EXPORT_FILE_BYTES } from "@/lib/core/constants"
import { rebuildOutdatedEndpoints } from "@/lib/core/endpoints"
import { invalid, PcpError } from "@/lib/core/errors"
import { reconcileNetwork } from "@/lib/core/network/runtime"
import { reconcileUpdates } from "@/lib/core/updates/runtime"
import { isSetUp, unlockOwnerVault } from "@/lib/core/vault"
import {
  type ActionState,
  field,
  file,
  guarded,
} from "@/lib/server/action-state"
import {
  confirmPassword,
  TOO_MANY_ATTEMPTS,
  withinExportLimits,
  withinSignInLimits,
} from "@/lib/server/password-attempts"
import {
  clearSessionCookie,
  requireSession,
  signIn,
} from "@/lib/server/session"

/**
 * Restoring an export (lib/core/backup.ts), in two steps through one
 * action: without `confirm`, the file is opened and what it holds is handed
 * back for the owner to read; with it, the same file is opened again and
 * written in place of everything here. The export download is a route
 * handler (app/api/export/route.ts): an action cannot send a file.
 */

export type RestoreResult = ActionState<{ preview: ExportPreview }>

async function uploadFrom(formData: FormData): Promise<Buffer> {
  const upload = file(formData, "file")

  if (!upload) {
    throw invalid("Choose an export file.")
  }

  // Checked before reading, so an oversized file costs nothing.
  if (upload.size > MAX_EXPORT_FILE_BYTES) {
    throw invalid(
      `That file is larger than ${MAX_EXPORT_FILE_BYTES / 1024 / 1024} MB.`,
    )
  }

  return Buffer.from(await upload.arrayBuffer())
}

/** What boot does for rows it did not write: as instrumentation.ts. */
async function afterRestore(restoreHostSettings: boolean): Promise<void> {
  void rebuildOutdatedEndpoints().catch((error) =>
    console.error("[backup] rebuild after restore failed", error),
  )

  if (restoreHostSettings) {
    await reconcileNetwork({ ddnsNow: true, tlsNow: true })
    await reconcileUpdates()
  }

  revalidatePath("/", "layout")
}

/** The signed-in owner replaces their vault with the file's. */
export async function restoreAction(
  _previous: RestoreResult,
  formData: FormData,
): Promise<RestoreResult> {
  const session = await requireSession()
  const confirm = field(formData, "confirm") === "on"
  const restoreHostSettings = field(formData, "restoreHostSettings") === "on"
  const password = field(formData, "password")
  let restored = false

  const result = await guarded(async () => {
    if (!withinExportLimits(session.sessionId)) {
      throw new PcpError("forbidden", TOO_MANY_ATTEMPTS)
    }

    const { payload, preview } = await readExport(
      await uploadFrom(formData),
      field(formData, "exportPassword"),
    )

    if (!confirm) {
      return { preview }
    }

    if (field(formData, "replace") !== "on") {
      throw invalid("Tick the box to confirm that everything here is replaced.")
    }

    await confirmPassword(session, password)
    await restoreExport(
      payload,
      { into: "vault", vaultId: session.ctx.vaultId },
      { restoreHostSettings },
    )
    restored = true

    return { preview }
  })

  if (result.status !== "ok" || !restored) {
    return result
  }

  await afterRestore(restoreHostSettings)

  // The session went with the vault. The owner's own export opens with the
  // password they just typed; another PCP's opens with its own.
  const ctx = await unlockOwnerVault(password)

  if (ctx) {
    await signIn(ctx)
    redirect("/settings?restored=1")
  }

  await clearSessionCookie()
  redirect("/login?restored=1")
}

/** A PCP not set up yet takes the file's vault as its owner's. */
export async function restoreAtSetupAction(
  _previous: RestoreResult,
  formData: FormData,
): Promise<RestoreResult> {
  if (await isSetUp()) {
    redirect("/login")
  }

  if (!(await withinSignInLimits("export"))) {
    return { status: "error", error: TOO_MANY_ATTEMPTS }
  }

  const confirm = field(formData, "confirm") === "on"
  const restoreHostSettings = field(formData, "restoreHostSettings") === "on"
  let restored = false

  const result = await guarded(async () => {
    const { payload, preview } = await readExport(
      await uploadFrom(formData),
      field(formData, "exportPassword"),
    )

    if (!confirm) {
      return { preview }
    }

    await restoreExport(payload, { into: "fresh" }, { restoreHostSettings })
    restored = true

    return { preview }
  })

  if (result.status !== "ok" || !restored) {
    return result
  }

  await afterRestore(restoreHostSettings)
  redirect("/login?restored=1")
}
