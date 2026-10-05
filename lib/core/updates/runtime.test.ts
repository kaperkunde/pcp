import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import {
  checkNow,
  reconcileUpdates,
  setUpdateFetch,
  updateTimerActive,
  updatesIdle,
  updateTick,
} from "./runtime"
import {
  availableUpdate,
  getUpdateConfig,
  getUpdateStatus,
  saveUpdateConfig,
  saveUpdateStatus,
  updatesOverview,
} from "./state"

// The background side as the Server Actions drive it: a timer while the
// check is on, none while it is off, and "Check now" either way.

let cleanup: () => Promise<void>
let asked = 0

function answer(tag: string): typeof fetch {
  return (async () => {
    asked++
    return new Response(
      JSON.stringify({ tag_name: tag, body: "notes", assets: [] }),
      { status: 200 },
    )
  }) as typeof fetch
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  asked = 0
})

afterEach(async () => {
  await saveUpdateConfig({ check: false })
  await reconcileUpdates()
  await updatesIdle()
  setUpdateFetch()
  await cleanup()
})

describe("the update check's settings", () => {
  it("is on until the owner turns it off", async () => {
    expect(await getUpdateConfig()).toEqual({ check: true })

    await saveUpdateConfig({ check: false })
    expect(await getUpdateConfig()).toEqual({ check: false })

    await saveUpdateConfig({ check: true })
    expect(await getUpdateConfig()).toEqual({ check: true })
  })
})

describe("the update runtime", () => {
  it("runs a timer while the check is on and none once it is off", async () => {
    await reconcileUpdates()
    expect(updateTimerActive()).toBe(true)

    await saveUpdateConfig({ check: false })
    await reconcileUpdates()
    expect(updateTimerActive()).toBe(false)
    expect(asked).toBe(0)
  })

  it("asks nothing on its own while the check is off", async () => {
    setUpdateFetch(answer("v9.9.9"))
    await saveUpdateConfig({ check: false })
    await reconcileUpdates()
    await updatesIdle()

    expect(updateTimerActive()).toBe(false)
    expect(asked).toBe(0)
  })

  it("checks when the owner asks, with the timer off, and keeps the result", async () => {
    setUpdateFetch(answer("v999.0.0"))
    await saveUpdateConfig({ check: false })

    const status = await checkNow()

    expect(asked).toBe(1)
    expect(status.latest?.version).toBe("999.0.0")
    expect(await availableUpdate()).toEqual({
      version: "999.0.0",
      url: "https://github.com/kaperkunde/pcp/releases/tag/v999.0.0",
    })
    expect(await updatesOverview()).toMatchObject({
      check: false,
      available: true,
      error: null,
      latest: { version: "999.0.0", notes: "notes" },
    })
  })

  it("shows no update when the latest release is this one", async () => {
    setUpdateFetch(answer("v0.0.1"))
    await checkNow()

    expect(await availableUpdate()).toBeNull()
    expect((await updatesOverview()).available).toBe(false)
  })

  it("keeps an install request the owner made while a round was out", async () => {
    await saveUpdateStatus({
      installRequest: {
        id: "r1",
        at: "2026-10-05T10:00:00.000Z",
        version: "9.9.9",
      },
    })
    setUpdateFetch(answer("v9.9.9"))

    await checkNow()

    expect((await getUpdateStatus()).installRequest).toMatchObject({ id: "r1" })
  })

  it("reports a failure and keeps what it knew", async () => {
    setUpdateFetch(answer("v999.0.0"))
    await checkNow()
    setUpdateFetch((async () => {
      throw new TypeError("fetch failed")
    }) as typeof fetch)

    const status = await checkNow()

    expect(status.lastError).toMatch(/could not reach GitHub/)
    expect(status.latest?.version).toBe("999.0.0")
    expect(status.nextAttemptAt).toBeTruthy()
  })

  it("asks nothing before PCP is set up, and does once it is", async () => {
    setUpdateFetch(answer("v9.9.9"))
    await saveUpdateConfig({ check: true })
    await updateTick()
    expect(asked).toBe(0)

    await setupVault({ name: "Ada", password: "correct horse battery" })
    await updateTick()
    expect(asked).toBe(1)
  })
})
