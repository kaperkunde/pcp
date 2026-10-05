"use server"

import { revalidatePath } from "next/cache"

import { PcpError } from "@/lib/core/errors"
import { checkRateLimit } from "@/lib/core/rate-limit"
import { CHECK_NOW_LIMIT } from "@/lib/core/updates/limits"
import { checkNow, reconcileUpdates } from "@/lib/core/updates/runtime"
import { isNewer } from "@/lib/core/updates/semver"
import {
  newerRelease,
  requestInstall,
  saveUpdateConfig,
} from "@/lib/core/updates/state"
import { PCP_VERSION } from "@/lib/core/version"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { desktopUpdater, isDesktopApp } from "@/lib/server/desktop"
import { requireContext } from "@/lib/server/session"

/**
 * The update check. A setting of the machine, not of the vault
 * (lib/core/updates/state.ts), but only the signed-in owner changes it.
 */

export type UpdatesResult = ActionState<{ message?: string }>

/** The header shows the notice on every page, so all of them are refreshed. */
function refresh() {
  revalidatePath("/", "layout")
}

export async function setUpdateCheckAction(
  _previous: UpdatesResult,
  formData: FormData,
): Promise<UpdatesResult> {
  await requireContext()

  const result = await guarded(async () => {
    const check = field(formData, "check") === "on"
    await saveUpdateConfig({ check })
    await reconcileUpdates()

    return {
      message: check
        ? "PCP checks for new releases once a day."
        : "PCP no longer checks for new releases by itself.",
    }
  })

  refresh()
  return result
}

export async function checkForUpdatesAction(): Promise<UpdatesResult> {
  await requireContext()

  const result = await guarded(async () => {
    if (!checkRateLimit("updates:check-now", CHECK_NOW_LIMIT)) {
      throw new PcpError(
        "forbidden",
        "You checked several times just now. Wait a minute and try again.",
      )
    }

    const status = await checkNow()

    if (status.lastError) {
      throw new PcpError("upstream", status.lastError)
    }

    const newer = newerRelease(status)
    const latest = status.latest?.version

    if (newer) {
      return { message: `v${newer.version} is available.` }
    }

    return {
      message:
        latest && isNewer(PCP_VERSION, latest)
          ? `This PCP, v${PCP_VERSION}, is newer than the latest release, v${latest}.`
          : `You have the latest release, v${PCP_VERSION}.`,
    }
  })

  refresh()
  return result
}

/**
 * "Install and restart" in the desktop app: PCP notes the request, and the
 * app (which reads /api/health) downloads the release and restarts into it.
 */
export async function requestInstallAction(): Promise<UpdatesResult> {
  await requireContext()

  const result = await guarded(async () => {
    if (!isDesktopApp() || desktopUpdater() !== "auto") {
      throw new PcpError(
        "state",
        "This PCP cannot install updates itself. Follow the steps under How to update this PCP.",
      )
    }

    const request = await requestInstall()

    return {
      message: `The app is downloading v${request.version}. PCP restarts by itself when it is done.`,
    }
  })

  refresh()
  return result
}
