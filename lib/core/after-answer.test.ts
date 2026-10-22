import { describe, expect, it } from "vitest"

import { afterAnswer, afterAnswerScope } from "./after-answer"

describe("work handed on until the answer has gone", () => {
  it("runs only when the scope drains, what that hands on included", async () => {
    const ran: string[] = []
    const later = afterAnswerScope()

    const handed = await later.run(async () => {
      await Promise.resolve()
      return afterAnswer(async () => {
        ran.push("first")
        afterAnswer(async () => {
          ran.push("second")
        })
      })
    })

    expect(handed).toBe(true)
    expect(ran).toEqual([])

    await later.drain()
    expect(ran).toEqual(["first", "second"])
  })

  it("refuses work with no scope, or once the scope has run, so the caller does it", async () => {
    expect(afterAnswer(async () => {})).toBe(false)

    const later = afterAnswerScope()
    let late: (() => boolean) | null = null
    await later.run(async () => {
      late = () => afterAnswer(async () => {})
    })
    await later.drain()

    expect(late!()).toBe(false)
  })

  it("keeps one task's failure its own", async () => {
    const ran: string[] = []
    const later = afterAnswerScope()

    await later.run(async () => {
      afterAnswer(async () => {
        throw new Error("gone")
      })
      afterAnswer(async () => {
        ran.push("other")
      })
    })

    await expect(later.drain()).resolves.toBeUndefined()
    expect(ran).toEqual(["other"])
  })
})
