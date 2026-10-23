import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import type { VaultContext } from "../context"
import { db } from "../db"
import {
  buildGatewayServer,
  loadGatewayServers,
  type GatewayScope,
} from "../gateway"
import {
  checkPermission,
  confirmProposedShare,
  decidePermission,
  getPermissionView,
  openShareRequest,
} from "../permissions"
import { createSecret } from "../secrets"
import { createSkill, getSkill, setTokenSkills, updateSkill } from "../skills"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"

import { startFakeGitHub, type FakeGitHub } from "./fake-github"
import { REVIEW_CHANGED, shareReview } from "./share-review"
import { createRepo } from "./store"

// An assistant proposing that an item go to a linked repository, through
// the memory tool's /repos/share/: one item, a request that writes and
// pushes nothing, answered on the push's review, which runs the
// personal-data check and pushes exactly what it shows.

vi.mock("../request-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../request-log")>()),
  appendRequestLog: vi.fn(async () => {}),
}))

const PUBLIC_URL = "http://localhost:3000"
const PAT = "github_pat_TESTTOKEN_123456"

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
  fake.tokens.set(PAT, { push: true })
})

afterEach(async () => {
  delete process.env.PCP_GITHUB_API_URL
  await fake.close()
  await cleanup()
})

async function writeRepo(
  name: string,
  { private: hidden = false, access = "write" as "read" | "write" } = {},
): Promise<string> {
  fake.addRepo("ada", name, {
    private: hidden,
    files: { "README.md": "Shared things." },
  })
  const secret = await db().secret.findFirst({ where: { name: "GitHub" } })
  const secretId =
    secret?.id ?? (await createSecret(ctx, { name: "GitHub", value: PAT })).id

  return (
    await createRepo(ctx, {
      owner: "ada",
      name,
      trust: "trusted",
      access,
      secretId,
    })
  ).id
}

async function notes(description = "Take notes."): Promise<string> {
  return (
    await createSkill(ctx, {
      name: "notes",
      description,
      body: "Write it down.",
      tools: [],
    })
  ).id
}

async function connect(
  options: { manageEndpoints?: boolean; skillIds?: string[] } = {},
) {
  const { id, token } = await createApiToken(ctx, {
    name: "Helper",
    allowAllServers: true,
    keepMemories: true,
    manageEndpoints: options.manageEndpoints ?? true,
  })

  if (options.skillIds) {
    await setTokenSkills(ctx, id, { all: false, skillIds: options.skillIds })
  }

  const scope: GatewayScope = {
    ...(await resolveApiToken(token))!,
    publicUrl: PUBLIC_URL,
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
    serverSide,
  )
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)

  return {
    tokenId: scope.tokenId,
    call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      return {
        isError: result.isError === true,
        text: (result.content as Array<{ text?: string }>)
          .map((part) => part.text ?? "")
          .join(""),
      }
    },
  }
}

const propose = (path: string, why = "Others could use it.") => ({
  command: "create",
  path,
  file_text: why,
})

describe("an assistant proposing a push", () => {
  it("is for a token that may manage endpoints only", async () => {
    await writeRepo("shared")
    await notes()
    const { call } = await connect({ manageEndpoints: false })

    const asked = await call(
      "memory",
      propose("/repos/share/ada/shared/skills/notes"),
    )

    expect(asked.isError).toBe(true)
    expect(asked.text).toMatch(/manage endpoints/)
    expect(await db().permissionRequest.count()).toBe(0)
  })

  it("lists the repositories and the items it sees, then asks once and pushes nothing", async () => {
    await writeRepo("shared")
    await writeRepo("mirror", { access: "read" })
    const id = await notes()
    const { call } = await connect()

    const repos = await call("memory", {
      command: "view",
      path: "/repos/share",
    })
    expect(repos.text).toContain("/repos/share/ada/shared — anyone can read it")
    expect(repos.text).not.toContain("ada/mirror")

    const items = await call("memory", {
      command: "view",
      path: "/repos/share/ada/shared",
    })
    expect(items.text).toContain(
      "/repos/share/ada/shared/skills/notes — Not pushed (the skill notes)",
    )

    const readOnly = await call(
      "memory",
      propose("/repos/share/ada/mirror/skills/notes"),
    )
    expect(readOnly.isError).toBe(true)
    expect(readOnly.text).toMatch(/read-only in PCP/)

    const asked = await call(
      "memory",
      propose("/repos/share/ada/shared/skills/notes"),
    )
    expect(asked.text).toContain("Not done yet")
    expect(asked.text).toContain("Push notes to ada/shared?")

    const [request] = await db().permissionRequest.findMany()
    expect(request!.kind).toBe("repo_share")
    expect(request!.toolName).toBe("memory")
    const view = (await getPermissionView(ctx, request!.id, {
      publicUrl: PUBLIC_URL,
    }))!
    expect(view.lines).toEqual(
      expect.arrayContaining([
        "Repository: ada/shared (main), public: anyone can read it",
        "Item: the skill notes, to skills/notes",
        "The assistant says:\nOthers could use it.",
      ]),
    )
    expect(view.shareHref).toBe(
      `/settings/repositories/${encodeURIComponent((await openShareRequest(ctx, request!.id))!.repoId)}/share?item=skill%3A${id}&request=${request!.id}`,
    )
    // Only Not now here: a push is confirmed on its review.
    expect(view.decisions.map((decision) => decision.value)).toEqual([
      "decline",
    ])
    const refused = await decidePermission(ctx, request!.id, "allow_once", {
      publicUrl: PUBLIC_URL,
    })
    expect(refused.isError).toBe(true)

    // Nothing reached the repository.
    expect(fake.log("ada", "shared")).toHaveLength(1)
    expect(Object.keys(fake.files("ada", "shared"))).toEqual(["README.md"])
  })

  it("is not for an item the token does not see, or one the repository has the same", async () => {
    const repoId = await writeRepo("shared")
    const id = await notes()
    const other = (
      await createSkill(ctx, {
        name: "other",
        description: "Another.",
        body: "Do it.",
        tools: [],
      })
    ).id
    const { call } = await connect({ skillIds: [other] })

    const hidden = await call(
      "memory",
      propose("/repos/share/ada/shared/skills/notes"),
    )
    expect(hidden.isError).toBe(true)
    expect(hidden.text).toMatch(/No item at skills\/notes that you see/)

    // Pushed by the owner already: nothing to propose.
    const review = await shareReview(ctx, repoId, { kind: "skill", id })
    const { confirmShare } = await import("./share-review")
    await confirmShare(
      ctx,
      repoId,
      { kind: "skill", id },
      {
        basis: review.basis,
        acknowledged: [],
      },
    )
    const { call: all } = await connect()
    const same = await all(
      "memory",
      propose("/repos/share/ada/shared/skills/notes"),
    )
    expect(same.isError).toBe(true)
    expect(same.text).toMatch(/nothing to push/)
    expect(await db().permissionRequest.count()).toBe(0)
  })

  it("is confirmed on the push's review: a public repository waits on every hit, and then exactly what was shown is pushed", async () => {
    const repoId = await writeRepo("shared")
    const id = await notes("Take notes; mail ada@lovelace.org when stuck.")
    const { call, tokenId } = await connect()
    await call("memory", propose("/repos/share/ada/shared/skills/notes"))
    const [request] = await db().permissionRequest.findMany()
    const item = { kind: "skill" as const, id }
    const review = await shareReview(ctx, repoId, item, {
      publicUrl: PUBLIC_URL,
    })
    expect(review.hits.map((hit) => hit.match)).toContain("ada@lovelace.org")

    // A hit neither fixed nor ticked: nothing pushed, the request still open.
    await expect(
      confirmProposedShare(ctx, request!.id, {
        repoId,
        item,
        basis: review.basis,
        acknowledged: [],
        publicUrl: PUBLIC_URL,
      }),
    ).rejects.toThrow(/still looks? personal/)
    expect(fake.log("ada", "shared")).toHaveLength(1)
    expect(await openShareRequest(ctx, request!.id)).not.toBeNull()

    // Changed since the review opened: nothing pushed either.
    await updateSkill(ctx, id, {
      ...(await getSkill(ctx, id)),
      body: "Write it all down.",
    })
    await expect(
      confirmProposedShare(ctx, request!.id, {
        repoId,
        item,
        basis: review.basis,
        acknowledged: review.hits.map((hit) => hit.id),
        publicUrl: PUBLIC_URL,
      }),
    ).rejects.toThrow(REVIEW_CHANGED)
    expect(fake.log("ada", "shared")).toHaveLength(1)

    const again = await shareReview(ctx, repoId, item, {
      publicUrl: PUBLIC_URL,
    })
    const pushed = await confirmProposedShare(ctx, request!.id, {
      repoId,
      item,
      basis: again.basis,
      acknowledged: again.hits.map((hit) => hit.id),
      publicUrl: PUBLIC_URL,
    })

    expect(pushed.commit).not.toBeNull()
    expect(fake.files("ada", "shared")["skills/notes/SKILL.md"]).toContain(
      "Write it all down.",
    )
    expect(fake.log("ada", "shared")[0]).toContain(
      'Proposed by the assistant "Helper"',
    )
    const told = await checkPermission(
      { ctx, tokenId, publicUrl: PUBLIC_URL },
      request!.id,
    )
    expect(JSON.stringify(told)).toContain(
      "The owner reviewed it and pushed skills/notes to ada/shared",
    )

    // Answered: a second confirm finds no open request.
    await expect(
      confirmProposedShare(ctx, request!.id, {
        repoId,
        item,
        basis: again.basis,
        acknowledged: [],
        publicUrl: PUBLIC_URL,
      }),
    ).rejects.toThrow(/no longer open/)
  })

  it("refuses a confirm for another item than the one proposed", async () => {
    const repoId = await writeRepo("shared")
    await notes()
    const other = (
      await createSkill(ctx, {
        name: "other",
        description: "Another.",
        body: "Do it.",
        tools: [],
      })
    ).id
    const { call } = await connect()
    await call("memory", propose("/repos/share/ada/shared/skills/notes"))
    const [request] = await db().permissionRequest.findMany()
    const review = await shareReview(ctx, repoId, { kind: "skill", id: other })

    await expect(
      confirmProposedShare(ctx, request!.id, {
        repoId,
        item: { kind: "skill", id: other },
        basis: review.basis,
        acknowledged: [],
        publicUrl: PUBLIC_URL,
      }),
    ).rejects.toThrow(/not the item this request is about/)
    expect(fake.log("ada", "shared")).toHaveLength(1)
  })
})
