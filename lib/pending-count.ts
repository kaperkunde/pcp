import type { PendingRequestsState } from "@/lib/actions/permissions"

/**
 * What the bell and Home's count show while the owner's answers are on
 * their way (components/answer-queue.tsx): the count drops the moment they
 * answer, and comes back if the answer fails. Client components may import
 * this: it takes the state's type only.
 */

/** What the owner answered and PCP has not yet been read again since. */
export type Answering = {
  /** Requests from assistants, by id. */
  requests: readonly string[]
  /** The bell's notices (a linked repository's change: `repo:<item id>`). */
  notices: readonly string[]
}

export const NOTHING_ANSWERING: Answering = { requests: [], notices: [] }

/** The bell's notice for a linked repository's change to review. */
export function repoNoticeId(itemId: string): string {
  return `repo:${itemId}`
}

/**
 * `state` as it will be once the answers in `answering` arrive. A request
 * listed in `state` is taken out of the list and the count. One not listed
 * is counted off too while the list is cut short (it may be among those
 * not shown), and not when the whole list is there (PCP no longer has it
 * waiting).
 */
export function withoutAnswered(
  state: PendingRequestsState,
  answering: Answering,
): PendingRequestsState {
  if (answering.requests.length === 0 && answering.notices.length === 0) {
    return state
  }

  const listed = new Set(state.requests.map((request) => request.id))
  const requests = state.requests.filter(
    (request) => !answering.requests.includes(request.id),
  )
  const cutShort = state.total > state.requests.length
  const unlisted = cutShort
    ? answering.requests.filter((id) => !listed.has(id)).length
    : 0

  return {
    total: Math.max(
      0,
      state.total - (state.requests.length - requests.length) - unlisted,
    ),
    requests,
    notices: state.notices.filter(
      (notice) => !answering.notices.includes(notice.id),
    ),
  }
}
