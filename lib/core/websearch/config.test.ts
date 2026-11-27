import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { createSecret } from "../secrets"
import { setSetting } from "../settings"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import {
  checkSearchUrl,
  checkWebSearchConfig,
  readWebSearchConfig,
  SETTING_WEB_SEARCH,
  webSearchOverview,
  writeWebSearchConfig,
} from "./config"

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

describe("the web search provider setting", () => {
  it("still reads a SearXNG setting made with an address, before services", async () => {
    await setSetting(
      ctx,
      SETTING_WEB_SEARCH,
      JSON.stringify({
        provider: "searxng",
        secretId: null,
        url: "http://192.168.1.20:8080",
      }),
    )

    expect(await readWebSearchConfig(ctx)).toEqual({
      provider: "searxng",
      secretId: null,
      url: "http://192.168.1.20:8080",
    })
    expect((await webSearchOverview(ctx)).services).toEqual([])
  })

  it("is none until the owner chooses one, and reads back what they saved", async () => {
    expect(await readWebSearchConfig(ctx)).toBeNull()

    const key = await createSecret(ctx, { name: "Brave key", value: "k" })
    const config = await checkWebSearchConfig(ctx, {
      provider: "brave",
      secretId: key.id,
    })
    await writeWebSearchConfig(ctx, config)

    expect(await readWebSearchConfig(ctx)).toEqual({
      provider: "brave",
      secretId: key.id,
    })
    expect((await webSearchOverview(ctx)).secrets).toEqual([
      { id: key.id, name: "Brave key" },
    ])

    await writeWebSearchConfig(ctx, null)
    expect(await readWebSearchConfig(ctx)).toBeNull()
  })

  it("asks for a key where the provider takes one, and a text secret of the vault", async () => {
    await expect(
      checkWebSearchConfig(ctx, { provider: "tavily", secretId: null }),
    ).rejects.toThrow(/Choose the secret/)
    await expect(
      checkWebSearchConfig(ctx, { provider: "tavily", secretId: "nope" }),
    ).rejects.toThrow(/from your secrets/)
  })

  it("takes a search the owner runs by its address, with a key or without", async () => {
    await expect(
      checkWebSearchConfig(ctx, { provider: "searxng", secretId: null }),
    ).rejects.toThrow(/address/)

    expect(
      await checkWebSearchConfig(ctx, {
        provider: "searxng",
        secretId: null,
        url: " http://192.168.1.20:8080/ ",
      }),
    ).toEqual({
      provider: "searxng",
      secretId: null,
      url: "http://192.168.1.20:8080",
    })
  })

  it("refuses an address that is not http(s) or carries a login", () => {
    expect(() => checkSearchUrl("ftp://x.example")).toThrow(/http/)
    expect(() => checkSearchUrl("https://u:p@x.example")).toThrow(/user name/)
    expect(() => checkSearchUrl("nonsense")).toThrow(/full address/)
  })

  it("counts a hand-edited value that does not read as a provider as none", async () => {
    const { setSetting } = await import("../settings")

    await setSetting(ctx, "webSearch", JSON.stringify({ provider: "bing" }))
    expect(await readWebSearchConfig(ctx)).toBeNull()
    await setSetting(ctx, "webSearch", "{")
    expect(await readWebSearchConfig(ctx)).toBeNull()
  })
})
