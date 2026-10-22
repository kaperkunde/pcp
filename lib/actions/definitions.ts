"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import {
  cloneServer,
  detachServer,
  dismissMerge,
  mergeDefinitions,
  setPersonalNote,
  type CloneInput,
  type NoteKind,
} from "@/lib/core/definitions"
import { getServer } from "@/lib/core/servers"
import { syncServerTools } from "@/lib/core/upstream"
import {
  type ActionState,
  field,
  fields,
  guarded,
} from "@/lib/server/action-state"
import { extraHeadersFrom } from "@/lib/server/extra-headers"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

/**
 * The owner's own changes to definitions and instances (lib/core/
 * definitions.ts): the note on a server or skill, cloning a server,
 * detaching one, and merging endpoints with the same schema. Nothing here
 * is reachable by an assistant.
 */

export type DefinitionActionResult = ActionState<{
  message?: string
  note?: string | null
}>

function revalidateItem(kind: NoteKind, id: string) {
  if (kind === "skill") {
    revalidatePath("/skills")
    revalidatePath(`/skills/${id}`)
  } else {
    revalidatePath("/servers")
    revalidatePath(`/servers/${id}`)
  }
}

/** The About card's note, saved as typed; empty takes it away. */
export async function setNoteAction(
  kind: NoteKind,
  id: string,
  note: string,
): Promise<DefinitionActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => ({
    note: await setPersonalNote(
      ctx,
      kind === "skill" ? "skill" : "server",
      id,
      note,
    ),
    message: note.trim() ? "Note saved." : "Note removed.",
  }))

  revalidateItem(kind, id)

  return result
}

/** The server goes its own way: a definition of its own, as it is now. */
export async function detachServerAction(
  id: string,
): Promise<DefinitionActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await detachServer(ctx, id)
    return {
      message:
        "Detached: changes to its description, schema and tool descriptions now change this server alone.",
    }
  })

  revalidatePath("/servers", "layout")

  return result
}

function cloneInputFrom(formData: FormData): CloneInput {
  const authType = field(formData, "authType")

  return {
    name: field(formData, "name"),
    url: field(formData, "url"),
    note: field(formData, "note"),
    authType:
      authType === "header" || authType === "basic" || authType === "oauth"
        ? authType
        : "none",
    authHeaderName: field(formData, "authHeaderName") || null,
    authValueTemplate: field(formData, "authValueTemplate") || null,
    authSecretId: field(formData, "authSecretId") || null,
    authSecretName: field(formData, "authSecretName") || null,
    authSecretValue: field(formData, "authSecretValue") || null,
    authUsername: field(formData, "authUsername") || null,
    oauthClientId: field(formData, "oauthClientId") || null,
    oauthClientSecretId: field(formData, "oauthClientSecretId") || null,
    oauthClientSecretValue: field(formData, "oauthClientSecretValue") || null,
    oauthScope: field(formData, "oauthScope") || null,
    oauthAuthorizeParams: field(formData, "oauthAuthorizeParams") || null,
    authExtraHeaders: extraHeadersFrom(formData),
  }
}

/** Another server of the same definition; opens its page when made. */
export async function cloneServerAction(
  _previous: DefinitionActionResult,
  formData: FormData,
): Promise<DefinitionActionResult> {
  const ctx = await requireContext()
  const sourceId = field(formData, "sourceId")
  const result = await guarded(() =>
    cloneServer(ctx, sourceId, cloneInputFrom(formData)),
  )

  if (result.status !== "ok") {
    return result
  }

  const made = result.id
  // An MCP server's tools come from it: read them now, as adding one does.
  const server = await getServer(ctx, made)
  if (server.kind === "mcp") {
    await syncServerTools(ctx, server, { publicUrl: await publicUrlFor(ctx) })
  }

  revalidatePath("/servers", "layout")
  redirect(`/servers/${made}`)
}

/** Merges the endpoints the owner was shown, keeping the definition they chose. */
export async function mergeDefinitionsAction(
  _previous: DefinitionActionResult,
  formData: FormData,
): Promise<DefinitionActionResult> {
  const ctx = await requireContext()
  const result = await guarded(() =>
    mergeDefinitions(
      ctx,
      field(formData, "keep"),
      fields(formData, "definition"),
      { key: field(formData, "key"), name: field(formData, "name") },
    ),
  )

  if (result.status !== "ok") {
    return result
  }

  const first = result.instances[0]?.id
  revalidatePath("/", "layout")
  redirect(first ? `/servers/${first}` : "/servers")
}

/** The owner keeps them apart: the offer goes away. */
export async function dismissMergeAction(key: string): Promise<void> {
  const ctx = await requireContext()
  await dismissMerge(ctx, key)
  revalidatePath("/", "layout")
  redirect("/servers")
}
