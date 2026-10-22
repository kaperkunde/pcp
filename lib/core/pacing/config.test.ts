import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { db } from "../db"
import { createServer } from "../servers"
import { getSetting } from "../settings"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import {
  pacingOverview,
  readPacingConfig,
  removePacingSite,
  resetPacingClasses,
  resolvePolicy,
  SETTING_PACING,
  setPacingClass,
  setPacingClasses,
  setPacingServer,
  setPacingSite,
  type PacingConfig,
} from "./config"
import { PACING_DEFAULTS, type PacingPolicy } from "./limits"

// The owner's own pace: what a call follows (site, then server, then the
// class, then PCP's default), the bounds held in core, and how it is kept.

const SLOW: PacingPolicy = {
  minIntervalMs: 9_000,
  jitterMs: 1_000,
  burst: null,
}
const SLOWER: PacingPolicy = {
  minIntervalMs: 20_000,
  jitterMs: 0,
  burst: { max: 5, perMs: 60_000 },
}
const CLASS: PacingPolicy = { minIntervalMs: 3_000, jitterMs: 0, burst: null }

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
})

afterEach(async () => {
  await cleanup()
})

describe("resolvePolicy", () => {
  const config: PacingConfig = {
    classes: { browser_act: CLASS, web_fetch: "unpaced" },
    servers: { browser1: SLOWER },
    sites: [
      { host: "example.com", subdomains: true, pace: SLOW },
      { host: "shop.example.com", subdomains: false, pace: "unpaced" },
      { host: "other.test", subdomains: false, pace: SLOWER },
    ],
  }

  it("takes the site's over the server's over the class's over PCP's", () => {
    expect(
      resolvePolicy(config, "browser_act", {
        site: "example.com",
        serverId: "browser1",
      }),
    ).toEqual(SLOW)
    expect(
      resolvePolicy(config, "browser_act", {
        site: "nowhere.test",
        serverId: "browser1",
      }),
    ).toEqual(SLOWER)
    expect(
      resolvePolicy(config, "browser_act", { site: "nowhere.test" }),
    ).toEqual(CLASS)
    expect(
      resolvePolicy(config, "server_change", { serverId: "other" }),
    ).toEqual(PACING_DEFAULTS.server_change)
  })

  it("covers subdomains only where the owner said so, the closest one first", () => {
    expect(
      resolvePolicy(config, "web_fetch", { site: "www.example.com" }),
    ).toEqual(SLOW)
    expect(
      resolvePolicy(config, "web_fetch", { site: "shop.example.com" }),
    ).toBeNull()
    expect(
      resolvePolicy(config, "web_fetch", { site: "a.shop.example.com" }),
    ).toEqual(SLOW)
    expect(resolvePolicy(config, "web_fetch", { site: "x.other.test" })).toBe(
      null,
    )
    expect(resolvePolicy(config, "web_fetch", { site: "badexample.com" })).toBe(
      null,
    )
    expect(
      resolvePolicy(config, "web_fetch", { site: "www.example.com:8443" }),
    ).toBeNull()
  })

  it("says unpaced where an override says so", () => {
    expect(resolvePolicy(config, "web_fetch", { site: "nowhere.test" })).toBe(
      null,
    )
  })
})

describe("the owner's pace", () => {
  it("is kept as the vault's setting, overrides only", async () => {
    expect(await getSetting(ctx, SETTING_PACING)).toBeNull()

    await setPacingClass(ctx, "browser_act", CLASS)
    await setPacingSite(ctx, {
      site: "https://Example.com/path",
      subdomains: true,
      pace: SLOW,
    })

    const config = await readPacingConfig(ctx.vaultId)
    expect(config.classes).toEqual({ browser_act: CLASS })
    expect(config.sites).toEqual([
      { host: "example.com", subdomains: true, pace: SLOW },
    ])

    // The same as PCP's default is no override at all.
    await setPacingClass(ctx, "browser_act", PACING_DEFAULTS.browser_act)
    expect((await readPacingConfig(ctx.vaultId)).classes).toEqual({})

    await removePacingSite(ctx, "example.com")
    expect(await getSetting(ctx, SETTING_PACING)).toBeNull()
  })

  it("puts the classes back to PCP's defaults, and leaves sites and servers", async () => {
    const { id } = await createServer(ctx, {
      name: "Postcards",
      url: "https://postcards.example.com/mcp",
      authType: "none",
    })
    await setPacingClass(ctx, "server_change", "unpaced")
    await setPacingServer(ctx, id, SLOWER)
    await setPacingSite(ctx, { site: "a.test", subdomains: false, pace: SLOW })

    await resetPacingClasses(ctx)
    const overview = await pacingOverview(ctx)
    expect(overview.classes.server_change).toEqual({
      pace: PACING_DEFAULTS.server_change,
      own: false,
    })
    expect(overview.sites).toHaveLength(1)
    expect((await readPacingConfig(ctx.vaultId)).servers).toEqual({
      [id]: SLOWER,
    })
  })

  it("renames a site, and drops servers that are gone as it writes", async () => {
    const { id } = await createServer(ctx, {
      name: "Postcards",
      url: "https://postcards.example.com/mcp",
      authType: "none",
    })
    const { id: other } = await createServer(ctx, {
      name: "Letters",
      url: "https://letters.example.com/mcp",
      authType: "none",
    })
    await setPacingServer(ctx, id, SLOW)
    await db().mcpServer.delete({ where: { id } })
    await setPacingServer(ctx, other, "unpaced")
    expect((await readPacingConfig(ctx.vaultId)).servers).toEqual({
      [other]: "unpaced",
    })
    await expect(setPacingServer(ctx, "nope", SLOW)).rejects.toThrow(
      "That server was not found.",
    )

    await setPacingSite(ctx, { site: "a.test", subdomains: false, pace: SLOW })
    await setPacingSite(
      ctx,
      { site: "b.test", subdomains: false, pace: "unpaced" },
      "a.test",
    )
    expect((await readPacingConfig(ctx.vaultId)).sites).toEqual([
      { host: "b.test", subdomains: false, pace: "unpaced" },
    ])
  })

  it("refuses what is out of bounds, and writes nothing", async () => {
    await expect(
      setPacingClass(ctx, "browser_act", {
        minIntervalMs: -1,
        jitterMs: 0,
        burst: null,
      }),
    ).rejects.toThrow("Keep the pause between actions between 0 s and 600 s.")
    await expect(
      setPacingClass(ctx, "browser_act", {
        minIntervalMs: 0,
        jitterMs: 11 * 60_000,
        burst: null,
      }),
    ).rejects.toThrow("the random extra wait")
    await expect(
      setPacingSite(ctx, {
        site: "a.test",
        subdomains: false,
        pace: {
          minIntervalMs: 0,
          jitterMs: 0,
          burst: { max: 0, perMs: 60_000 },
        },
      }),
    ).rejects.toThrow("number of actions")
    await expect(
      setPacingSite(ctx, {
        site: "a.test",
        subdomains: false,
        pace: { minIntervalMs: 0, jitterMs: 0, burst: { max: 5, perMs: 10 } },
      }),
    ).rejects.toThrow("time for that many actions")
    await expect(
      setPacingClass(ctx, "nothing" as never, CLASS),
    ).rejects.toThrow("no such kind")
    await expect(
      setPacingSite(ctx, { site: "*.a.test", subdomains: false, pace: SLOW }),
    ).rejects.toThrow("no wildcards")
    // Saved together, one out of bounds keeps the others from being written.
    await expect(
      setPacingClasses(ctx, {
        web_fetch: CLASS,
        browser_act: { minIntervalMs: 0, jitterMs: -5, burst: null },
      }),
    ).rejects.toThrow("the random extra wait")

    expect(await getSetting(ctx, SETTING_PACING)).toBeNull()
  })

  it("reads a value that is not one as PCP's defaults", async () => {
    await db().setting.create({
      data: {
        vaultId: ctx.vaultId,
        key: SETTING_PACING,
        value: JSON.stringify({
          classes: { browser_act: { minIntervalMs: 1e12 } },
        }),
      },
    })

    expect(await readPacingConfig(ctx.vaultId)).toEqual({
      classes: {},
      servers: {},
      sites: [],
    })
  })
})
