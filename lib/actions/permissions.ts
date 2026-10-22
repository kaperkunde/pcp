"use server"

import { revalidatePath } from "next/cache"
import { after } from "next/server"

import { afterAnswerScope } from "@/lib/core/after-answer"
import type { VaultContext } from "@/lib/core/context"
import { notFound } from "@/lib/core/errors"
import { listOwnerNotices, type OwnerNotice } from "@/lib/core/owner-notices"
import { nextPendingRequest } from "@/lib/core/owner-queue"
import { parseDecision } from "@/lib/core/permission-rules"
import {
  applyAccessRequest,
  decidePermission,
  getPermissionView,
  listPendingRequests,
} from "@/lib/core/permissions"
import { type ActionState, guarded } from "@/lib/server/action-state"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

/**
 * Where the owner goes once they answered (components/answer-queue.tsx):
 * the oldest thing still waiting, or null when nothing is. `stay` when the
 * answered request's own page still needs them (a server to connect).
 */
export type QueueStep = { next: string | null; stay: boolean }

export type DecidePermissionResult = ActionState<
  {
    message: string
    isError: boolean
    /** The request's title, to say on the next page what was answered. */
    title: string
  } & QueueStep
>

/** The step after answering request `id`. */
async function stepAfter(
  ctx: VaultContext,
  id: string,
  publicUrl: string,
): Promise<QueueStep> {
  const answered = await getPermissionView(ctx, id, { publicUrl })

  if (answered?.connect) {
    return { next: null, stay: true }
  }

  return { next: await nextPendingRequest(ctx, id), stay: false }
}

/**
 * Every page shows what waits for the owner (the bell, Home's count), so an
 * answer reads them all again; the owner's page itself among them.
 */
function revalidateAnswered(): void {
  revalidatePath("/", "layout")
}

/**
 * The owner's answer on /permissions/<id> or the token page to something an
 * assistant asked for (lib/core/permissions.ts). Only the signed-in owner
 * reaches this; the answer runs the call there and then.
 */
export async function decidePermissionAction(
  id: string,
  decision: string,
  /** A new server's secret, typed in on the page; nowhere else takes it. */
  secretValue?: string,
  /** A memory to share: read it in every conversation, the page's toggle. */
  always?: boolean,
  /** "Allow for": how long, in minutes. */
  minutes?: number,
): Promise<DecidePermissionResult> {
  const ctx = await requireContext()
  const publicUrl = await publicUrlFor(ctx)
  // What the call hands on to do once it has answered (an IMAP send's look
  // for its copy in Sent) runs once this answer is sent.
  const later = afterAnswerScope()
  after(() => later.drain())

  const result = await later.run(() =>
    guarded(async () => {
      const view = await getPermissionView(ctx, id, { publicUrl })

      if (!view) {
        throw notFound("That request")
      }

      const outcome = await decidePermission(
        ctx,
        id,
        parseDecision(view.kind, decision),
        {
          publicUrl,
          secretValue:
            typeof secretValue === "string" ? secretValue : undefined,
          always: always === true,
          minutes: typeof minutes === "number" ? minutes : undefined,
        },
      )
      const message = outcome.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")

      return {
        message: message || "Done.",
        isError: outcome.isError === true,
        title: view.title,
        ...(await stepAfter(ctx, id, publicUrl)),
      }
    }),
  )

  revalidateAnswered()

  return result
}

/**
 * The owner saves tool levels an assistant proposed, as they left them on
 * /permissions/<id>. This is the only way a proposal is ever written.
 */
export async function saveAccessRequestAction(
  id: string,
  levels: Array<{ serverId: string; tool: string; access: string }>,
): Promise<DecidePermissionResult> {
  const ctx = await requireContext()
  const publicUrl = await publicUrlFor(ctx)

  const result = await guarded(async () => {
    const view = await getPermissionView(ctx, id, { publicUrl })

    if (!view) {
      throw notFound("That request")
    }

    const outcome = await applyAccessRequest(ctx, id, levels, { publicUrl })
    const message = outcome.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")

    return {
      message: message || "Saved.",
      isError: outcome.isError === true,
      title: view.title,
      ...(await stepAfter(ctx, id, publicUrl)),
    }
  })

  revalidateAnswered()

  return result
}

export type PendingRequestsState = {
  total: number
  /** The oldest first, as the owner is walked through them. */
  requests: Array<{
    id: string
    title: string
    tokenName: string
    createdAt: string
    href: string
  }>
  /**
   * Not from an assistant: PCP itself needs a look (HTTPS not renewing, new
   * suggested instructions).
   */
  notices: OwnerNotice[]
}

/**
 * What is waiting for the owner, for the header's notifications: read when
 * the menu opens and every little while, so a request an assistant makes
 * shows without reloading the page.
 */
export async function pendingRequestsAction(): Promise<PendingRequestsState> {
  const ctx = await requireContext()
  const [{ total, requests }, notices] = await Promise.all([
    publicUrlFor(ctx).then((publicUrl) => listPendingRequests(ctx, publicUrl)),
    listOwnerNotices(ctx),
  ])

  return {
    total,
    requests: requests.map((request) => ({
      ...request,
      createdAt: request.createdAt.toISOString(),
    })),
    notices,
  }
}
