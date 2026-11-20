import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { VaultContext } from "../context"
import { db } from "../db"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { parseServiceDefinition } from "./definition"
import {
  dropGeneratedSecrets,
  generatedRecipe,
  makeGeneratedSecrets,
} from "./generated"

// The values PCP makes for a service's generated variables: each secret is
// named in `made` as soon as it exists, so a launch that fails part way
// takes back exactly what it made.

const failing = vi.hoisted(() => ({ on: 0, calls: 0 }))

vi.mock("../secrets", async (importOriginal) => {
  const original = await importOriginal<typeof import("../secrets")>()

  return {
    ...original,
    createSecretNamedAfter: vi.fn(
      async (...args: Parameters<typeof original.createSecretNamedAfter>) => {
        failing.calls += 1

        if (failing.calls === failing.on) {
          throw new Error("The disk is full.")
        }

        return original.createSecretNamedAfter(...args)
      },
    ),
  }
})

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  failing.on = 0
  failing.calls = 0
})

afterEach(async () => {
  await cleanup()
})

const DEFINITION = parseServiceDefinition({
  image: `ghcr.io/example/sessions@sha256:${"a".repeat(64)}`,
  env: [
    { name: "FIRST", generated: true },
    { name: "SECOND", generated: { length: 64, symbols: true } },
    { name: "THIRD", generated: true },
  ],
})

describe("makeGeneratedSecrets", () => {
  it("makes one secret for each unbound generated variable, by its recipe", async () => {
    const made: string[] = []
    const bound = await makeGeneratedSecrets(ctx, {
      service: "Sessions",
      definition: DEFINITION,
      bindings: { THIRD: "the-owners-own" },
      made,
    })

    expect(Object.keys(bound).sort()).toEqual(["FIRST", "SECOND", "THIRD"])
    expect(bound.THIRD).toBe("the-owners-own")
    expect(made).toEqual([bound.FIRST, bound.SECOND])
    expect(generatedRecipe(true)).toMatchObject({ length: 40, symbols: false })
    expect(generatedRecipe({ length: 64, symbols: true })).toMatchObject({
      length: 64,
      symbols: true,
    })
  })

  it("names each secret as it is made, so one that fails part way is taken back whole", async () => {
    failing.on = 2
    const made: string[] = []

    await expect(
      makeGeneratedSecrets(ctx, {
        service: "Sessions",
        definition: DEFINITION,
        bindings: {},
        made,
      }),
    ).rejects.toThrow(/disk is full/)
    expect(made).toHaveLength(1)
    expect(await db().secret.count({ where: { id: made[0] } })).toBe(1)

    await dropGeneratedSecrets(ctx, made)
    expect(await db().secret.count({ where: { id: made[0] } })).toBe(0)
  })
})
