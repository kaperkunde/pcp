"use server"

import { revalidatePath } from "next/cache"

import { invalid } from "@/lib/core/errors"
import {
  removePacingSite,
  resetPacingClasses,
  setPacingClasses,
  setPacingServer,
  setPacingSite,
} from "@/lib/core/pacing/config"
import {
  PACING_CLASSES,
  type PacingClass,
  type PacingOverride,
} from "@/lib/core/pacing/limits"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

/**
 * Pacing (lib/core/pacing/): how fast assistants may act on one site or
 * server. The vault's own settings; the bounds are checked in core.
 */

export type PacingResult = ActionState<{ message?: string }>

/** Seconds as the owner typed them, in milliseconds; empty is none. */
function milliseconds(value: string, name: string): number {
  const trimmed = value.trim()

  if (trimmed === "") {
    return 0
  }

  if (!/^\d{1,6}(\.\d{1,3})?$/.test(trimmed)) {
    throw invalid(`Enter ${name} in seconds, like 1.5.`)
  }

  return Math.round(Number(trimmed) * 1000)
}

/**
 * One pace from a form's fields under `prefix`: "unpaced" when its switch
 * is off, else the pause, the random extra wait, and the cap (none when
 * the number of actions is left empty).
 */
function readOverride(formData: FormData, prefix: string): PacingOverride {
  if (field(formData, `${prefix}paced`) !== "on") {
    return "unpaced"
  }

  const max = field(formData, `${prefix}burstMax`).trim()
  const minutes = field(formData, `${prefix}burstMinutes`).trim()
  let burst: { max: number; perMs: number } | null = null

  if (max !== "") {
    if (!/^\d{1,6}$/.test(max)) {
      throw invalid("Enter the number of actions as a whole number.")
    }

    if (!/^\d{1,4}(\.\d{1,2})?$/.test(minutes)) {
      throw invalid(
        "Enter the minutes for that many actions, like 1, or leave the number of actions empty.",
      )
    }

    burst = { max: Number(max), perMs: Math.round(Number(minutes) * 60_000) }
  }

  return {
    minIntervalMs: milliseconds(
      field(formData, `${prefix}min`),
      "the pause between actions",
    ),
    jitterMs: milliseconds(
      field(formData, `${prefix}jitter`),
      "the random extra wait",
    ),
    burst,
  }
}

export async function savePacingClassesAction(
  _previous: PacingResult,
  formData: FormData,
): Promise<PacingResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const values: Partial<Record<PacingClass, PacingOverride>> = {}

    for (const name of PACING_CLASSES) {
      values[name] = readOverride(formData, `${name}-`)
    }

    await setPacingClasses(ctx, values)
    return { message: "Saved. Calls from now on follow this pace." }
  })

  revalidatePath("/settings")
  return result
}

export async function resetPacingAction(): Promise<PacingResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await resetPacingClasses(ctx)
    return { message: "Back to PCP's defaults. Your sites and servers stay." }
  })

  revalidatePath("/settings")
  return result
}

export async function savePacingSiteAction(
  _previous: PacingResult,
  formData: FormData,
): Promise<PacingResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const replacing = field(formData, "replacing").trim()
    const host = await setPacingSite(
      ctx,
      {
        site: field(formData, "site"),
        subdomains: field(formData, "subdomains") === "on",
        pace: readOverride(formData, ""),
      },
      replacing || undefined,
    )

    return { message: `Saved ${host}.` }
  })

  revalidatePath("/settings")
  return result
}

export async function removePacingSiteAction(
  _previous: PacingResult,
  formData: FormData,
): Promise<PacingResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    await removePacingSite(ctx, field(formData, "site"))
    return {
      message: "Removed. The site follows the pace for its kind of action.",
    }
  })

  revalidatePath("/settings")
  return result
}

export async function saveServerPacingAction(
  _previous: PacingResult,
  formData: FormData,
): Promise<PacingResult> {
  const ctx = await requireContext()
  const serverId = field(formData, "serverId")

  const result = await guarded(async () => {
    const mode = field(formData, "mode")

    if (mode !== "default" && mode !== "own" && mode !== "unpaced") {
      throw invalid("Choose how this server is paced.")
    }

    await setPacingServer(
      ctx,
      serverId,
      mode === "default"
        ? null
        : mode === "unpaced"
          ? "unpaced"
          : readOverride(formData, ""),
    )

    return { message: "Saved. Calls from now on follow this pace." }
  })

  revalidatePath(`/servers/${serverId}`)
  return result
}
