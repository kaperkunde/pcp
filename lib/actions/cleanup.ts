"use server"

import { revalidatePath } from "next/cache"

import { CLEAN_NOW_LIMIT, CLEANUP_SCHEDULES } from "@/lib/core/cleanup/limits"
import { cleanUp, reconcileCleanup } from "@/lib/core/cleanup/runtime"
import { describeRemoved, saveCleanupConfig } from "@/lib/core/cleanup/state"
import { invalid, PcpError } from "@/lib/core/errors"
import { checkRateLimit } from "@/lib/core/rate-limit"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

/**
 * The scheduled cleanup. A setting of the machine, not of the vault
 * (lib/core/cleanup/state.ts), but only the signed-in owner changes it.
 */

export type CleanupResult = ActionState<{ message?: string }>

function refresh() {
  revalidatePath("/settings")
  revalidatePath("/log")
}

export async function saveCleanupAction(
  _previous: CleanupResult,
  formData: FormData,
): Promise<CleanupResult> {
  await requireContext()

  const result = await guarded(async () => {
    const chosen = field(formData, "schedule")
    const preset = CLEANUP_SCHEDULES.find((option) => option.id === chosen)

    if (!preset && chosen !== "custom") {
      throw invalid("Choose when the cleanup runs.")
    }

    const days = field(formData, "logDays").trim()

    if (!/^\d{1,5}$/.test(days)) {
      throw invalid("Enter how many days of log to keep.")
    }

    await saveCleanupConfig({
      cron: preset ? preset.cron : field(formData, "cron"),
      logDays: Number(days),
    })
    await reconcileCleanup()

    return { message: "Saved. The next cleanup follows the new schedule." }
  })

  refresh()
  return result
}

export async function cleanUpNowAction(): Promise<CleanupResult> {
  await requireContext()

  const result = await guarded(async () => {
    if (!checkRateLimit("cleanup:now", CLEAN_NOW_LIMIT)) {
      throw new PcpError(
        "forbidden",
        "You cleaned up several times just now. Wait a minute and try again.",
      )
    }

    const status = await cleanUp("owner")

    if (status.problems?.length) {
      throw new PcpError("state", status.problems.join(" "))
    }

    const removed = status.removed ? describeRemoved(status.removed) : null

    return {
      message: removed ? `Removed ${removed}.` : "There was nothing to remove.",
    }
  })

  refresh()
  return result
}
