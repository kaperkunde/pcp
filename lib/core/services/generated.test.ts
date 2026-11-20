import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_TOKEN_RECIPE } from "../constants"
import type { VaultContext } from "../context"
import { db } from "../db"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { parseServiceDefinition } from "./definition"
import {
  dropGeneratedSecrets,
  generatedRecipe,
  makeGeneratedSecrets,
  type MadeSecret,
} from "./generated"

// The values PCP makes for a service's generated variables, through the
// secrets' own createGeneratedSecret: each is named in `made` as soon as it
// exists, so a launch that fails part way takes back exactly what it made,
// and a value made before (a remake) is kept.

const failing = vi.hoisted(() => ({ on: 0, calls: 0 }))

vi.mock("../secrets", async (importOriginal) => {
  const original = await importOriginal<typeof import("../secrets")>()

  return {
    ...original,
    createGeneratedSecret: vi.fn(
      async (...args: Parameters<typeof original.createGeneratedSecret>) => {
        failing.calls += 1

        if (failing.calls === failing.on) {
          throw new Error("The disk is full.")
        }

        return original.createGeneratedSecret(...args)
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
  it("makes a managed generated secret for each unbound generated variable, named for the service", async () => {
    const made: MadeSecret[] = []
    const { bindings, generated } = await makeGeneratedSecrets(ctx, {
      service: "Sessions",
      definition: DEFINITION,
      bindings: { THIRD: "the-owners-own" },
      made,
    })

    expect(bindings.THIRD).toBe("the-owners-own")
    expect(generated).toEqual(["FIRST", "SECOND"])
    expect(made).toEqual([
      { id: bindings.FIRST, created: true },
      { id: bindings.SECOND, created: true },
    ])
    expect(
      await db().secret.count({
        where: { id: { in: made.map((each) => each.id) }, kind: "generated" },
      }),
    ).toBe(2)
    expect(generatedRecipe(true)).toEqual(DEFAULT_TOKEN_RECIPE)
    expect(generatedRecipe({ length: 64, symbols: true })).toMatchObject({
      format: "password",
      length: 64,
      symbols: true,
    })
  })

  it("keeps a variable's value once bound (a remake), and never hands an unbound one a value that exists by its name", async () => {
    const first: MadeSecret[] = []
    const before = await makeGeneratedSecrets(ctx, {
      service: "Sessions",
      definition: DEFINITION,
      bindings: {},
      made: first,
    })

    // A remake: bound already, nothing made.
    const remade: MadeSecret[] = []
    const kept = await makeGeneratedSecrets(ctx, {
      service: "Sessions",
      definition: DEFINITION,
      bindings: before.bindings,
      made: remade,
    })
    expect(kept.bindings).toEqual(before.bindings)
    expect(remade).toEqual([])

    // Another service of the same name: values of its own, under "-2".
    const other: MadeSecret[] = []
    const fresh = await makeGeneratedSecrets(ctx, {
      service: "Sessions",
      definition: DEFINITION,
      bindings: {},
      made: other,
    })
    for (const name of ["FIRST", "SECOND", "THIRD"]) {
      expect(fresh.bindings[name]).not.toBe(before.bindings[name])
    }
    expect(other.every((each) => each.created)).toBe(true)
    const names = await db().secret.findMany({
      where: { id: { in: other.map((each) => each.id) } },
      select: { id: true },
    })
    expect(names).toHaveLength(3)

    // Taking back the second leaves the first's alone.
    await dropGeneratedSecrets(ctx, other)
    expect(
      await db().secret.count({
        where: { id: { in: Object.values(before.bindings) } },
      }),
    ).toBe(3)
  })

  it("names each secret as it is made, so one that fails part way is taken back whole", async () => {
    failing.on = 2
    const made: MadeSecret[] = []

    await expect(
      makeGeneratedSecrets(ctx, {
        service: "Sessions",
        definition: DEFINITION,
        bindings: {},
        made,
      }),
    ).rejects.toThrow(/disk is full/)
    expect(made).toHaveLength(1)
    expect(await db().secret.count({ where: { id: made[0]!.id } })).toBe(1)

    await dropGeneratedSecrets(ctx, made)
    expect(await db().secret.count({ where: { id: made[0]!.id } })).toBe(0)
  })
})
