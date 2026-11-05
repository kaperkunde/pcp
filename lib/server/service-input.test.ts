import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "@/lib/core/context"
import { db } from "@/lib/core/db"
import { PcpError } from "@/lib/core/errors"
import { scratchDatabase } from "@/lib/core/test-db"
import { setupVault } from "@/lib/core/vault"

import { NEW_SECRET, withNewSecrets } from "./service-input"

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
})

afterEach(() => cleanup())

function form(): FormData {
  const data = new FormData()
  data.set("env.API_KEY", NEW_SECRET)
  data.set("newSecret.API_KEY.name", "Docs key")
  data.set("newSecret.API_KEY.value", "typed-by-the-owner")
  return data
}

describe("a launch's new secrets", () => {
  it("binds them to their variables", async () => {
    const bound = await withNewSecrets(ctx, form(), {}, async (env) => env)
    const secret = await db().secret.findFirstOrThrow({
      where: { name: "Docs key" },
    })

    expect(bound).toEqual({ API_KEY: secret.id })
  })

  it("keeps them when the launch fails, and says under which name", async () => {
    const failure = await withNewSecrets(ctx, form(), {}, async () => {
      throw new PcpError("upstream", "Build box did not start pcp-docs.")
    }).catch((error: PcpError) => error)

    expect(failure).toBeInstanceOf(PcpError)
    expect((failure as PcpError).code).toBe("upstream")
    expect((failure as PcpError).message).toBe(
      'Build box did not start pcp-docs.\nThe secret you typed is kept in PCP as "Docs key" (for API_KEY): choose it when you try again, or delete it on the Secrets page.',
    )
    expect(await db().secret.count({ where: { name: "Docs key" } })).toBe(1)
  })
})
