"use server"

import { revalidatePath } from "next/cache"

import { invalid } from "@/lib/core/errors"
import {
  EMPTY_CONFIG,
  type ResourceConfig,
  type ResourceField,
  saveResourceConfig,
} from "@/lib/core/resources/state"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

/**
 * How much of the machine PCP may use. A setting of the machine, not of the
 * vault (lib/core/resources/state.ts), but only the signed-in owner changes
 * it.
 */

export type ResourcesResult = ActionState<{ message?: string }>

const NAMES: Record<ResourceField, string> = {
  programMemoryMb: "a program's memory",
  programsAtOnce: "programs at once",
  fileMb: "the largest file",
  keptMb: "kept results per token",
  browserIdleMinutes: "the browser's idle minutes",
}

export async function saveResourcesAction(
  _previous: ResourcesResult,
  formData: FormData,
): Promise<ResourcesResult> {
  await requireContext()

  const result = await guarded(async () => {
    const config: ResourceConfig = { ...EMPTY_CONFIG }

    for (const name of Object.keys(NAMES) as ResourceField[]) {
      const value = field(formData, name).trim()

      if (value === "") {
        continue
      }

      if (!/^\d{1,7}$/.test(value)) {
        throw invalid(
          `Enter ${NAMES[name]} as a whole number, or leave it empty for PCP to pick.`,
        )
      }

      config[name] = Number(value)
    }

    await saveResourceConfig(config)

    return {
      message:
        "Saved. Programs that start, results kept and the browser's idle close follow these limits from now on.",
    }
  })

  revalidatePath("/settings")
  return result
}
