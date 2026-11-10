"use server"

import { revalidatePath } from "next/cache"

import {
  setDuplicateCallDefault,
  setDuplicateCallWindow,
} from "@/lib/core/calls/config"
import { invalid } from "@/lib/core/errors"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

/**
 * Settings → Repeated calls (lib/core/calls/): how long the same Write or
 * Destructive call is held back, for every tool and per tool. The vault's
 * own setting; the bounds are checked in core.
 */

export type RepeatedCallsResult = ActionState<{ message?: string }>

/** Whole minutes as the owner typed them. */
function minutes(value: string): number {
  const trimmed = value.trim()

  if (!/^\d{1,5}$/.test(trimmed)) {
    throw invalid("Enter the time in whole minutes, like 30.")
  }

  return Number(trimmed)
}

/** A tool's key as the form sends it: the server's id, "/", the tool. */
function toolKey(value: string): { serverId: string; tool: string } {
  const at = value.indexOf("/")

  if (at <= 0 || at === value.length - 1) {
    throw invalid("Choose a tool.")
  }

  return { serverId: value.slice(0, at), tool: value.slice(at + 1) }
}

export async function saveRepeatedCallsDefaultAction(
  _previous: RepeatedCallsResult,
  formData: FormData,
): Promise<RepeatedCallsResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const typed = field(formData, "minutes").trim()
    await setDuplicateCallDefault(ctx, typed === "" ? null : minutes(typed))
    return {
      message:
        typed === ""
          ? "Back to PCP's default."
          : "Saved. Calls from now on follow it.",
    }
  })

  revalidatePath("/settings")
  return result
}

export async function saveRepeatedCallsToolAction(
  _previous: RepeatedCallsResult,
  formData: FormData,
): Promise<RepeatedCallsResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const { serverId, tool } = toolKey(field(formData, "tool"))
    const never = field(formData, "mode") === "never"
    await setDuplicateCallWindow(
      ctx,
      serverId,
      tool,
      never ? "exempt" : minutes(field(formData, "minutes")),
    )
    return {
      message: never
        ? `Saved: ${tool} is never held back.`
        : `Saved a time of its own for ${tool}.`,
    }
  })

  revalidatePath("/settings")
  return result
}

export async function removeRepeatedCallsToolAction(
  _previous: RepeatedCallsResult,
  formData: FormData,
): Promise<RepeatedCallsResult> {
  const ctx = await requireContext()

  const result = await guarded(async () => {
    const { serverId, tool } = toolKey(field(formData, "tool"))
    await setDuplicateCallWindow(ctx, serverId, tool, null)
    return { message: `${tool} follows the default again.` }
  })

  revalidatePath("/settings")
  return result
}
