import { describe, expect, it } from "vitest"

import type { PendingRequestsState } from "@/lib/actions/permissions"
import {
  NOTHING_ANSWERING,
  repoNoticeId,
  withoutAnswered,
} from "@/lib/pending-count"

function request(id: string) {
  return {
    id,
    title: `Allow ${id}?`,
    tokenName: "Claude",
    createdAt: "2026-10-22T10:00:00.000Z",
    href: `/permissions/${id}`,
  }
}

const STATE: PendingRequestsState = {
  total: 3,
  requests: [request("a"), request("b"), request("c")],
  notices: [
    {
      id: repoNoticeId("item"),
      kind: "repos",
      title: "Change to review in skills/notes",
      href: "/settings/repositories/changes/item",
    },
    {
      id: "instructions",
      kind: "instructions",
      title: "PCP's suggested instructions changed for 1 assistant",
      href: "/tokens/instructions",
    },
  ],
}

describe("the count while answers are on their way", () => {
  it("is the state itself when nothing is being answered", () => {
    expect(withoutAnswered(STATE, NOTHING_ANSWERING)).toBe(STATE)
  })

  it("drops an answered request from the list and the count", () => {
    const shown = withoutAnswered(STATE, { requests: ["a"], notices: [] })

    expect(shown.total).toBe(2)
    expect(shown.requests.map((entry) => entry.id)).toEqual(["b", "c"])
    expect(shown.notices).toEqual(STATE.notices)
  })

  it("drops an answered repository change from the notices", () => {
    const shown = withoutAnswered(STATE, {
      requests: [],
      notices: [repoNoticeId("item")],
    })

    expect(shown.total).toBe(3)
    expect(shown.notices.map((notice) => notice.id)).toEqual(["instructions"])
  })

  it("counts off one not listed only while the list is cut short", () => {
    const cut = { ...STATE, total: 12 }
    expect(withoutAnswered(cut, { requests: ["z"], notices: [] }).total).toBe(
      11,
    )
    // The whole list is there, so PCP already read it as answered.
    expect(withoutAnswered(STATE, { requests: ["z"], notices: [] }).total).toBe(
      3,
    )
  })

  it("never goes below none", () => {
    const one = { ...STATE, total: 1, requests: [request("a")] }

    expect(
      withoutAnswered(one, { requests: ["a", "a"], notices: [] }).total,
    ).toBe(0)
  })
})
