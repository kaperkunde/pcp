"use server"

import { revalidatePath } from "next/cache"

import { invalid, PcpError } from "@/lib/core/errors"
import { checkRateLimit } from "@kaperkunde/security"
import { installHost, installNewest } from "@/lib/core/updates/install"
import { CHECK_NOW_LIMIT, isUpdateChannel } from "@/lib/core/updates/limits"
import {
  checkNow,
  reconcileUpdates,
  setUpdateChannel,
} from "@/lib/core/updates/runtime"
import { isNewer } from "@/lib/core/updates/semver"
import {
  getUpdateConfig,
  newerRelease,
  saveUpdateConfig,
} from "@/lib/core/updates/state"
import { PCP_VERSION } from "@/lib/core/version"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
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

/**
 * Stable or develop. What the last check found is forgotten, and PCP asks
 * again at once while the daily check is on (the owner chose; it counts as
 * a Check now), so the page says straight away what the channel has.
 */
export async function setUpdateChannelAction(
  _previous: UpdatesResult,
  formData: FormData,
): Promise<UpdatesResult> {
  await requireContext()

  const result = await guarded(async () => {
    const channel = field(formData, "channel")

    if (!isUpdateChannel(channel)) {
      throw invalid("Choose stable or develop.")
    }

    await setUpdateChannel(channel)
    const named =
      channel === "develop" ? "develop's builds and releases" : "releases"

    if (
      (await getUpdateConfig()).check &&
      checkRateLimit("updates:check-now", CHECK_NOW_LIMIT).allowed
    ) {
      const status = await checkNow()
      const newer = newerRelease(status)

      if (newer) {
        return {
          message: `PCP now follows ${named}. v${newer.version} is available.`,
        }
      }
      if (!status.lastError) {
        return { message: `PCP now follows ${named}. This PCP is up to date.` }
      }
    }

    return { message: `PCP now follows ${named}.` }
  })

  refresh()
  return result
}

export async function checkForUpdatesAction(): Promise<UpdatesResult> {
  await requireContext()

  const result = await guarded(async () => {
    if (!checkRateLimit("updates:check-now", CHECK_NOW_LIMIT).allowed) {
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
 * "Install and restart": PCP notes the request, and the desktop app (which
 * reads /api/health) or the Linux installer's watcher (which reads the file
 * PCP leaves in its data folder) fetches the release and restarts into it.
 * Whether this PCP can is lib/core/updates/install.ts's, as update_pcp's.
 */
export async function requestInstallAction(): Promise<UpdatesResult> {
  await requireContext()

  const result = await guarded(async () => ({
    message: (await installNewest(installHost())).message,
  }))

  refresh()
  return result
}
