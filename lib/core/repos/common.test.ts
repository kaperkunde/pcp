import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { db } from "../db"
import {
  parseServiceDefinition,
  readServiceDefinition,
} from "../services/definition"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"

import {
  addCommonRepository,
  COMMON_REPOSITORY,
  commonRepository,
} from "./common"
import { serializeItem, type ServiceDocument } from "./documents"
import { startFakeGitHub, type FakeGitHub } from "./fake-github"
import { fetchItem, listRemote } from "./remote"
import { clientFor, getRepo, getRepoItem, listRepoItems } from "./store"
import { addFromRepo, approveChange, forgetSyncLooks, syncItem } from "./sync"
import { addService, DOCLING } from "./test-vault"

// PCP's common items: kaperkunde/pcp-gg-common linked in one step, read
// without a sign-in because it is public, read-only and untrusted, so what
// is added from it stays as the owner reviewed it until they take an update.

let cleanup: () => Promise<void>
let fake: FakeGitHub
let ctx: VaultContext

const { owner, name } = COMMON_REPOSITORY

function doclingFiles(image: string = DOCLING.image) {
  const document: ServiceDocument = {
    kind: "service",
    name: "docling",
    version: 1,
    displayName: "Docling",
    description: "Turns PDFs and images into Markdown and JSON.",
    definition: parseServiceDefinition({ ...DOCLING, image }),
  }

  return {
    "README.md": "# PCP's common items\n",
    ...serializeItem(document),
  }
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  fake = await startFakeGitHub()
  process.env.PCP_GITHUB_API_URL = fake.url
  forgetSyncLooks()
  fake.addRepo(owner, name, { files: doclingFiles() })
})

afterEach(async () => {
  delete process.env.PCP_GITHUB_API_URL
  await fake.close()
  await cleanup()
})

describe("PCP's common items", () => {
  it("links the public repository read-only and untrusted, with no sign-in, once", async () => {
    expect(await commonRepository(ctx)).toBeNull()

    const { id } = await addCommonRepository(ctx)
    const repo = await getRepo(ctx, id)

    expect(repo).toMatchObject({
      owner,
      name,
      branch: "main",
      access: "read",
      trust: "untrusted",
      secretId: null,
    })
    expect(fake.requests.length).toBeGreaterThan(0)
    expect(
      fake.requests.every((request) => request.authorization === null),
    ).toBe(true)
    expect(await addCommonRepository(ctx)).toEqual({ id })
    expect((await commonRepository(ctx))?.id).toBe(id)

    const listing = await listRemote(
      await clientFor(ctx, repo),
      repo,
      repo.branch,
    )
    expect(listing.items.map((item) => [item.root, item.ref.kind])).toEqual([
      ["services/docling.yaml", "service"],
    ])
  })

  it("keeps a service added from it as reviewed, and offers a change there as an update", async () => {
    const { id: repoId } = await addCommonRepository(ctx)
    const repo = await getRepo(ctx, repoId)
    const listing = await listRemote(
      await clientFor(ctx, repo),
      repo,
      repo.branch,
    )
    const remote = listing.items[0]!
    const fetched = await fetchItem(await clientFor(ctx, repo), repo, remote)

    const [added] = await addFromRepo(ctx, repoId, {
      commit: listing.head.commit,
      items: [
        {
          root: remote.root,
          hash: fetched.hash,
          service: {
            input: {
              name: "",
              hostId: "unused",
              publish: { address: "0.0.0.0", ports: [] },
              env: {},
            },
            // The launch, as rows: nothing connects in this test.
            launch: async (launchCtx, input) =>
              addService(launchCtx, input.definition as typeof DOCLING),
          },
        },
      ],
    })
    expect(added).toMatchObject({ ok: true })
    const [link] = await listRepoItems(ctx)
    expect(link).toMatchObject({ kind: "service", state: "ok" })

    const newer = `ghcr.io/docling-project/docling-serve-cpu@sha256:${"f".repeat(64)}`
    fake.commit(owner, name, doclingFiles(newer))

    const synced = await syncItem(ctx, link!.id)
    expect(synced.outcome).toBe("review")
    // A new image reaches further: it waits for the owner, flagged.
    expect(synced.message).toMatch(/waits for you/)
    const spec = () =>
      db().serviceSpec.findUniqueOrThrow({ where: { serverId: added!.id! } })
    expect(readServiceDefinition((await spec()).definition).image).toBe(
      DOCLING.image,
    )

    const pending = (await getRepoItem(ctx, link!.id)).data.pending!
    const before = await spec()
    await approveChange(ctx, link!.id, {
      sha: pending.sha,
      hash: pending.hash,
    })
    const after = await spec()
    expect(readServiceDefinition(after.definition).image).toBe(newer)
    expect(after).toMatchObject({
      hostId: before.hostId,
      publish: before.publish,
      env: before.env,
      containerName: before.containerName,
      registeredId: before.registeredId,
    })
  })
})
