import { randomUUID } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  allowSiteFor,
  allowToolFor,
  endAllowance,
  listTokenAllowances,
  parseAllowForMinutes,
  pruneAllowances,
} from "./allowances"
import { createApiToken } from "./api-tokens"
import { db } from "./db"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// Tools and sites the owner allowed a token for a while: listed for the
// token's page, ended early by the owner, and removed once they run out.
// What they do to a call is in permissions.test.ts and web-fetch.test.ts.

let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
})

afterEach(async () => {
  await cleanup()
})

async function setup() {
  const ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { id: serverId } = await createServer(ctx, {
    name: "Postcards",
    url: "https://postcards.example.com/mcp",
    authType: "none",
  })
  await db().mcpTool.create({
    data: {
      id: randomUUID(),
      serverId,
      name: "send_postcard",
      inputSchema: JSON.stringify({ type: "object" }),
    },
  })
  const { id: tokenId } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
  })

  return { ctx, serverId, tokenId }
}

describe("allowances", () => {
  it("takes only the times PCP offers", () => {
    expect(parseAllowForMinutes(15)).toBe(15)
    expect(parseAllowForMinutes("480")).toBe(480)
    for (const value of [0, 7, -15, 60.5, "1h", null, undefined]) {
      expect(() => parseAllowForMinutes(value)).toThrow(/Allow for one of/)
    }
  })

  it("lists what still holds, soonest first, and a second answer sets a new end", async () => {
    const { ctx, serverId, tokenId } = await setup()
    const now = new Date()

    await allowToolFor(tokenId, serverId, "send_postcard", 480, now)
    await allowSiteFor(tokenId, "example.com", 15, now)
    await allowSiteFor(
      tokenId,
      "old.example",
      15,
      new Date(now.getTime() - 20 * 60_000),
    )

    expect(await listTokenAllowances(ctx, tokenId, now)).toEqual([
      {
        kind: "site",
        host: "example.com",
        until: new Date(now.getTime() + 15 * 60_000),
      },
      {
        kind: "tool",
        serverId,
        serverName: "Postcards",
        toolName: "send_postcard",
        until: new Date(now.getTime() + 480 * 60_000),
      },
    ])

    await allowToolFor(tokenId, serverId, "send_postcard", 60, now)
    expect(
      (await listTokenAllowances(ctx, tokenId, now)).map((item) => item.until),
    ).toEqual([
      new Date(now.getTime() + 15 * 60_000),
      new Date(now.getTime() + 60 * 60_000),
    ])
    expect(await db().apiTokenToolAllowance.count()).toBe(1)
  })

  it("the owner ends one early, and only in their own vault", async () => {
    const { ctx, serverId, tokenId } = await setup()
    await allowToolFor(tokenId, serverId, "send_postcard", 60)
    await allowSiteFor(tokenId, "example.com", 60)

    await expect(
      endAllowance({ ...ctx, vaultId: "another" }, tokenId, {
        kind: "site",
        host: "example.com",
      }),
    ).rejects.toThrow()
    await expect(
      listTokenAllowances({ ...ctx, vaultId: "another" }, tokenId),
    ).rejects.toThrow()

    await endAllowance(ctx, tokenId, { kind: "site", host: "example.com" })
    expect(await listTokenAllowances(ctx, tokenId)).toMatchObject([
      { kind: "tool" },
    ])
    await endAllowance(ctx, tokenId, {
      kind: "tool",
      serverId,
      toolName: "send_postcard",
    })
    expect(await listTokenAllowances(ctx, tokenId)).toEqual([])
  })

  it("cleanup removes the ones that ran out", async () => {
    const { serverId, tokenId } = await setup()
    const now = new Date()
    const past = new Date(now.getTime() - 60 * 60_000)

    await allowToolFor(tokenId, serverId, "send_postcard", 15, past)
    await allowSiteFor(tokenId, "old.example", 15, past)
    await allowSiteFor(tokenId, "example.com", 60, now)

    expect(await pruneAllowances(now)).toBe(2)
    expect(await db().apiTokenSiteAllowance.findMany()).toMatchObject([
      { host: "example.com" },
    ])
  })
})
