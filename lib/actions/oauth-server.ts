"use server"

import { revalidatePath } from "next/cache"

import { PcpError } from "@/lib/core/errors"
import {
  approveAuthorization,
  checkAuthorizationRequest,
  denyAuthorization,
  type AuthorizationParams,
  type AuthorizationRequest,
} from "@/lib/core/oauth-server/authorize"
import {
  type ActionState,
  field,
  fields,
  guarded,
} from "@/lib/server/action-state"
import { confirmOwner } from "@/lib/server/password-attempts"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireSession } from "@/lib/server/session"

/**
 * The owner's answer to an assistant's sign-in (app/oauth/authorize/). The
 * request travels back as the query it came with and is checked again
 * here, client and metadata document included: nothing the page held is
 * taken on trust. Either way the answer is where to send the browser.
 */

export type SignInAnswer = ActionState<{ redirect: string }>

function requestParams(query: string): AuthorizationParams {
  return Object.fromEntries(new URLSearchParams(query))
}

/** The checked request, or the redirect that refuses it. */
async function recheck(
  query: string,
  publicUrl: string,
): Promise<{ request: AuthorizationRequest } | { redirect: string }> {
  const check = await checkAuthorizationRequest(requestParams(query), publicUrl)

  if (check.kind === "show") {
    throw new PcpError("validation", check.message)
  }

  return check.kind === "redirect"
    ? { redirect: check.url }
    : { request: check.request }
}

export async function approveSignInAction(
  _previous: SignInAnswer,
  formData: FormData,
): Promise<SignInAnswer> {
  const session = await requireSession()

  const result = await guarded(async () => {
    const publicUrl = await publicUrlFor(session.ctx)
    const checked = await recheck(field(formData, "request"), publicUrl)

    if ("redirect" in checked) {
      return checked
    }

    // What the assistant gets is a lasting copy of the vault key, as an API
    // token is: the session alone is not enough to make one.
    await confirmOwner(session, formData)

    const connectAs = field(formData, "connectAs")
    const { redirect } = await approveAuthorization(
      session.ctx,
      checked.request,
      connectAs && connectAs !== "new"
        ? { tokenId: connectAs }
        : {
            token: {
              name: field(formData, "name"),
              allowAllServers: field(formData, "access") !== "selected",
              serverIds: fields(formData, "serverIds"),
              manageEndpoints: field(formData, "manageEndpoints") === "on",
              keepMemories: field(formData, "keepMemories") === "on",
              webFetch: field(formData, "webFetch") === "on",
              runCode: field(formData, "runCode") === "on",
            },
          },
      publicUrl,
    )

    return { redirect }
  })

  revalidatePath("/tokens")

  return result
}

export async function denySignInAction(query: string): Promise<SignInAnswer> {
  const session = await requireSession()

  return guarded(async () => {
    const publicUrl = await publicUrlFor(session.ctx)
    const checked = await recheck(query, publicUrl)

    return "redirect" in checked
      ? checked
      : { redirect: denyAuthorization(checked.request, publicUrl) }
  })
}
