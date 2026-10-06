import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { exportVault, readExport, restoreExport } from "../backup"
import { startTestApi, type TestApi } from "../openapi/test-api"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { setFetchPrivate, setFetchRuleShared } from "../web-fetch"
import { chromiumExecutable } from "./executable"
import { openOwnerTab } from "./owner"
import { loadProfile } from "./profile"
import { closeAllBrowsers, ensureBrowser, runningBrowser } from "./runtime"
import { createBrowserServer } from "./server"

// A restore replaces the vault whole, its saved sign-ins too, so the vault's
// running browser is closed before the rows are written: left running, it
// would save what it holds from before over what the restore wrote.

const executable = await chromiumExecutable()
const PUBLIC_URL = "http://pcp.test"
const PASSWORD = "correct horse battery staple"

let cleanup: () => Promise<void>
let api: TestApi
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: PASSWORD })
  await createBrowserServer(ctx)
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  const { tokenId } = (await resolveApiToken(token))!
  api = await startTestApi((request, res) => {
    res.setHeader("content-type", "text/html")
    if (request.url !== "/favicon.ico") {
      res.setHeader("set-cookie", `${request.url!.slice(1)}=1; Max-Age=3600`)
    }
    res.end(`<title>${request.url}</title>`)
  })
  // The owner's own tab follows the line for all tokens: loopback allowed.
  await setFetchPrivate(ctx, tokenId, "allowed")
  await setFetchRuleShared(ctx, tokenId, "private", "private", true)
})

afterEach(async () => {
  await closeAllBrowsers()
  await api.close()
  await cleanup()
})

async function cookieNames(): Promise<string[]> {
  return ((await loadProfile(ctx))?.cookies ?? [])
    .map((cookie) => cookie.name)
    .sort()
}

describe.skipIf(!executable)(
  "restoring into a vault with a running browser",
  { timeout: 120_000 },
  () => {
    it("closes it, and what it held before does not come back over the restored profile", async () => {
      const visit = (path: string) =>
        openOwnerTab(ctx, {
          url: `${api.origin}/${path}`,
          publicUrl: PUBLIC_URL,
        })

      await visit("before")
      const file = await exportVault(ctx, "a long export password")
      const { payload } = await readExport(file, "a long export password")

      // Signed in somewhere else after the export: the restore undoes it.
      await visit("after")
      expect(await cookieNames()).toEqual(["after", "before"])
      expect(runningBrowser(ctx.vaultId)?.tabs.size).toBe(2)

      await restoreExport(
        payload,
        { into: "vault", ctx },
        { restoreHostSettings: false },
      )

      expect(runningBrowser(ctx.vaultId)).toBeNull()
      expect(await cookieNames()).toEqual(["before"])

      // The next browser starts from the restored profile, with no tabs.
      await visit("next")
      expect(runningBrowser(ctx.vaultId)?.tabs.size).toBe(1)
      expect(await cookieNames()).toEqual(["before", "next"])
    })

    it("keeps a browser from starting while the rows are written, and from saving after", async () => {
      await openOwnerTab(ctx, {
        url: `${api.origin}/before`,
        publicUrl: PUBLIC_URL,
      })
      const file = await exportVault(ctx, "a long export password")
      const { payload } = await readExport(file, "a long export password")

      let duringWrite: unknown = null
      const restoring = restoreExport(
        payload,
        { into: "vault", ctx },
        { restoreHostSettings: false },
      )
      // Started the moment the restore began: it is refused, not queued.
      duringWrite = await ensureBrowser(ctx).then(
        () => "started",
        (error: Error) => error.message,
      )
      await restoring

      expect(duringWrite).toMatch(/being restored/)
      expect(runningBrowser(ctx.vaultId)).toBeNull()
      expect(await cookieNames()).toEqual(["before"])
      // Afterwards it starts again.
      await ensureBrowser(ctx)
      expect(runningBrowser(ctx.vaultId)).not.toBeNull()
    })
  },
)
