import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import {
  EMPTY_CONFIG,
  forgetResourceLimits,
  saveResourceConfig,
} from "../resources/state"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"

import { startFakeGitHub, type FakeGitHub } from "./fake-github"
import { browseItems, listRemote } from "./remote"
import { clientFor, createRepo, getRepo } from "./store"

// A linked repository's schema file is bounded by the owner's limit on API
// schemas, read from their settings even when PCP has not read them yet
// (#141).

let cleanup: () => Promise<void>
let fake: FakeGitHub
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  fake = await startFakeGitHub()
  process.env.PCP_GITHUB_API_URL = fake.url
})

afterEach(async () => {
  delete process.env.PCP_GITHUB_API_URL
  await fake.close()
  await cleanup()
})

async function browseBigSpec() {
  const big = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Big", description: "x".repeat(3 * 1024 * 1024) },
    paths: { "/a": { get: { operationId: "a" } } },
  })
  fake.addRepo("ada", "specs", {
    files: {
      "endpoints/big/openapi.json": big,
      "endpoints/big/pcp.yaml":
        "pcp_format: 2\nname: Big\ndescription: A big one.\n",
    },
  })
  const { id } = await createRepo(ctx, {
    owner: "ada",
    name: "specs",
    trust: "untrusted",
    access: "read",
    secretId: null,
  })
  const repo = await getRepo(ctx, id)
  const gh = await clientFor(ctx, repo)
  const listing = await listRemote(gh, repo, repo.branch)

  return browseItems(gh, repo, listing)
}

describe("a schema file in a linked repository", () => {
  it("is held to the owner's limit even before PCP has read the settings", async () => {
    await saveResourceConfig({ ...EMPTY_CONFIG, specMb: 2 })
    // As on a fresh start: nothing read yet, so the machine's pick would be
    // used unless the entry points read the setting.
    forgetResourceLimits()

    const [item] = await browseBigSpec()

    expect(item!.problem ?? "").toMatch(/at most 2,097,152/)
  })

  it("is read when it is within the limit", async () => {
    await saveResourceConfig({ ...EMPTY_CONFIG, specMb: 8 })
    forgetResourceLimits()

    const [item] = await browseBigSpec()

    expect(item!.problem ?? "").not.toMatch(/at most/)
  })
})
