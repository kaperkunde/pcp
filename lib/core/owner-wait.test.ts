import { describe, expect, it } from "vitest"

import { waitForOwner } from "./owner-wait"

describe("waitForOwner", () => {
  it("returns as soon as the owner has done their part", async () => {
    let calls = 0
    const value = await waitForOwner(
      async () => (++calls >= 3 ? "done" : null),
      { ms: 5_000, pollMs: 10 },
    )

    expect(value).toBe("done")
    expect(calls).toBe(3)
  })

  it("gives up with null after its time", async () => {
    const started = Date.now()
    const value = await waitForOwner(async () => null, { ms: 60, pollMs: 10 })

    expect(value).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
  })

  it("stops when the client goes away", async () => {
    const gone = new AbortController()
    const started = Date.now()
    setTimeout(() => gone.abort(), 30)

    const value = await waitForOwner(async () => null, {
      ms: 10_000,
      pollMs: 5_000,
      signal: gone.signal,
    })

    expect(value).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
