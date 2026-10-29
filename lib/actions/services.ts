"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { invalid } from "@/lib/core/errors"
import { renameServerSlug } from "@/lib/core/servers"
import { saveServiceSettings } from "@/lib/core/services/services"
import type { ServiceStatus } from "@/lib/core/services/services"
import {
  launchService,
  readServiceLogs,
  readServiceStatus,
  recreateService,
  removeService,
  runServiceAction,
  updateService,
} from "@/lib/core/upstream"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import {
  envFrom,
  serviceInputFrom,
  valuesFrom,
  withNewSecrets,
} from "@/lib/server/service-input"
import { requireContext } from "@/lib/server/session"

import type { ServerActionResult } from "./servers"

/**
 * Services: launching one on an SSH server, reading how it is, running it
 * and removing it. Each reads the session, and lib/core/upstream.ts does the
 * work with the SSH server's key and the secrets, inside this request.
 */

export type ServiceStatusResult = ActionState<{ service: ServiceStatus }>
export type ServiceLogsResult = ActionState<{
  text: string
  truncated: boolean
}>

function revalidate(id: string) {
  revalidatePath("/servers")
  revalidatePath(`/servers/${id}`)
  revalidatePath("/tokens/[id]", "page")
}

export async function launchServiceAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const publicUrl = await publicUrlFor(ctx)
  const result = await guarded(async () => {
    const input = serviceInputFrom(formData)
    const launched = await withNewSecrets(ctx, formData, input.env, (env) =>
      launchService(
        ctx,
        {
          ...input,
          env,
          description: field(formData, "description"),
          // Another instance of a service takes its definition from there.
          ...(field(formData, "definitionId")
            ? { definitionId: field(formData, "definitionId") }
            : { definition: field(formData, "definition") }),
        },
        { publicUrl },
      ),
    )

    return { id: launched.id, message: launched.message }
  })

  if (result.status !== "ok" || !result.id) {
    return result
  }

  revalidatePath("/servers")
  redirect(`/servers/${result.id}`)
}

export async function saveServiceSettingsAction(
  _previous: ServerActionResult,
  formData: FormData,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")

  const result = await guarded(async () => {
    const { envChanged } = await saveServiceSettings(ctx, id, {
      name: field(formData, "name"),
      description: field(formData, "description"),
      env: envFrom(formData),
      // Only a service with plain variables sends them.
      ...(field(formData, "values") ? { values: valuesFrom(formData) } : {}),
    })

    const slug = field(formData, "slug")
    if (slug) {
      await renameServerSlug(ctx, id, slug)
    }

    if (!envChanged) {
      return { message: "Saved." }
    }

    // The container keeps the values it was made with.
    await recreateService(ctx, id, { publicUrl: await publicUrlFor(ctx) })
    return { message: "Saved, and the service was restarted with them." }
  })

  revalidate(id)
  return result
}

export async function serviceStatusAction(
  id: string,
): Promise<ServiceStatusResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => ({
    service: await readServiceStatus(ctx, id, {
      publicUrl: await publicUrlFor(ctx),
    }),
  }))

  revalidate(id)
  return result
}

export async function serviceLogsAction(
  id: string,
  lines: number,
): Promise<ServiceLogsResult> {
  const ctx = await requireContext()

  return guarded(async () =>
    readServiceLogs(ctx, id, Math.min(Math.max(1, Math.trunc(lines)), 500), {
      publicUrl: await publicUrlFor(ctx),
    }),
  )
}

const DONE: Record<"start" | "stop" | "restart", string> = {
  start: "Started.",
  stop: "Stopped.",
  restart: "Restarted.",
}

export async function runServiceActionAction(
  id: string,
  action: "start" | "stop" | "restart",
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    if (!(action in DONE)) {
      throw invalid("Start, stop or restart.")
    }

    await runServiceAction(ctx, id, action, {
      publicUrl: await publicUrlFor(ctx),
    })
    return { message: DONE[action] }
  })

  revalidate(id)
  return result
}

export async function updateServiceAction(
  id: string,
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const { image, changed } = await updateService(ctx, id, {
      publicUrl: await publicUrlFor(ctx),
    })
    return {
      message: changed
        ? `Updated to ${image}.`
        : "It already runs the newest image; PCP made its container again from it.",
    }
  })

  revalidate(id)
  return result
}

export async function removeServiceAction(
  id: string,
  choices: { volumes: boolean; registered: boolean },
): Promise<ServerActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => ({
    message: await removeService(
      ctx,
      id,
      {
        volumes: choices.volumes === true,
        registered: choices.registered === true,
      },
      { publicUrl: await publicUrlFor(ctx) },
    ),
  }))

  if (result.status !== "ok") {
    return result
  }

  revalidatePath("/servers")
  redirect("/servers")
}
