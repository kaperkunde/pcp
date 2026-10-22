import { afterEach, describe, expect, it } from "vitest"

import { createBrowserServer } from "../browser/server"
import type { VaultContext } from "../context"
import { db } from "../db"
import { createEndpoint, storedSpec } from "../endpoints"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"

import { applyItem, resolveItem, wrapperInput } from "./apply"
import {
  readRepo,
  serializeItem,
  type EndpointDocument,
  type ItemDocument,
  type ServerDocument,
  type SkillDocument,
  type WrapperDocument,
} from "./documents"
import type { RepoFiles } from "./layout"
import { findLocalItem, localItem, localItems } from "./local"
import { addSecrets, PETS_SPEC, populate } from "./test-vault"

// Applying what the owner approved: names resolved against this vault and
// never guessed, a secret the vault lacks left out with a note, and the
// owner's own write paths doing the writing.

let cleanup: (() => Promise<void>) | null = null

async function freshVault(): Promise<VaultContext> {
  await cleanup?.()
  ;({ cleanup } = await scratchDatabase())
  return setupVault({ name: "Ada", password: "correct horse battery staple" })
}

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

/** Every item of a populated vault, read back from its files. */
async function populatedItems(): Promise<ItemDocument[]> {
  const ctx = await freshVault()
  await populate(ctx)
  const files: RepoFiles = {}

  for (const item of await localItems(ctx)) {
    Object.assign(files, serializeItem(item.document))
  }

  return (await readRepo(files)).items
}

type ByKind = {
  skill: SkillDocument
  wrapper: WrapperDocument
  flow: WrapperDocument
  endpoint: EndpointDocument
  server: ServerDocument
}

function find<K extends ItemDocument["kind"]>(
  items: ItemDocument[],
  kind: K,
  name: string,
): ByKind[K] {
  return items.find(
    (item) => item.kind === kind && item.name === name,
  ) as ByKind[K]
}

describe("applying an item", () => {
  it("reports a secret the vault does not have, and saves the item without it", async () => {
    const items = await populatedItems()
    const ctx = await freshVault()
    await createBrowserServer(ctx)

    const pets = find(items, "endpoint", "pets")
    expect(await resolveItem(ctx, pets)).toEqual({
      problems: [],
      missingSecrets: ["Pets key"],
    })

    const endpoint = await applyItem(ctx, pets, { id: null })
    expect(endpoint.notes).toEqual([
      expect.stringContaining('no secret called "Pets key"'),
    ])
    expect(endpoint.notes[0]).toContain("Add the secret under Secrets in PCP")
    expect(
      (await localItem(ctx, "endpoint", endpoint.id)).document,
    ).toMatchObject({ auth: { kind: "none" }, baseUrl: pets.baseUrl })

    const wrapper = find(items, "wrapper", "pet-tools")
    expect((await resolveItem(ctx, wrapper)).missingSecrets).toEqual([
      "Pets key",
    ])
    const applied = await applyItem(ctx, wrapper, { id: null })
    expect(applied.notes).toEqual([
      expect.stringContaining('no secret called "Pets key"'),
    ])
    expect(
      (
        (await localItem(ctx, "wrapper", applied.id))
          .document as WrapperDocument
      ).secrets,
    ).toEqual([])

    const docs = await applyItem(ctx, find(items, "server", "docs"), {
      id: null,
    })
    expect(docs.notes).toEqual([
      expect.stringContaining('no secret called "Pets key"'),
    ])

    const notes = await applyItem(ctx, find(items, "endpoint", "notes"), {
      id: null,
    })
    expect(notes.notes).toEqual([
      expect.stringContaining('no secret called "Notes client secret"'),
    ])
    expect((await localItem(ctx, "endpoint", notes.id)).document).toMatchObject(
      {
        auth: { kind: "oauth", clientId: "notes-client", clientSecret: null },
      },
    )

    // No value was made up for any of them.
    expect(await db().secret.count({ where: { kind: "text" } })).toBe(0)
  })

  it("reports a server or tool the vault does not have, and writes nothing", async () => {
    const items = await populatedItems()
    const ctx = await freshVault()
    await addSecrets(ctx)
    const wrapper = find(items, "wrapper", "pet-tools")
    const { problems } = await resolveItem(ctx, wrapper)

    expect(problems).toEqual([
      "wrappers/pet-tools uses pets/add_pet, but this vault has no server called pets.",
      "wrappers/pet-tools uses pets/list_pets, but this vault has no server called pets.",
    ])
    await expect(applyItem(ctx, wrapper, { id: null })).rejects.toThrow(
      /no server called pets/,
    )
    expect(await db().mcpServer.count({ where: { kind: "wrapper" } })).toBe(0)

    await applyItem(ctx, find(items, "endpoint", "pets"), { id: null })
    const renamed: WrapperDocument = {
      ...wrapper,
      tools: [{ ...wrapper.tools[0]!, calls: ["pets/list_cats"] }],
      secrets: [],
    }
    expect((await resolveItem(ctx, renamed)).problems).toEqual([
      "wrappers/pet-tools uses pets/list_cats, but pets has no tool list_cats.",
    ])

    // A flow needs the browser, and a wrapper that drives it is a flow.
    const flow = find(items, "flow", "open-the-shop")
    expect((await resolveItem(ctx, flow)).problems).toEqual([
      "flows/open-the-shop uses browser/navigate, but this vault has no server called browser.",
    ])
    await createBrowserServer(ctx)
    expect(
      (await resolveItem(ctx, { ...flow, kind: "wrapper" })).problems,
    ).toEqual([
      "wrappers/open-the-shop drives the browser here, so it is a flow: it belongs under flows/.",
    ])
    expect(
      (await resolveItem(ctx, { ...wrapper, kind: "flow" })).problems,
    ).toEqual([
      "flows/pet-tools calls no browser tool here, so it is a wrapper, not a flow: it belongs under wrappers/.",
    ])
  })

  it("refuses a new item whose name the vault has, and an item onto something else", async () => {
    const items = await populatedItems()
    const ctx = await freshVault()
    const { ids } = await populate(ctx)

    await expect(
      applyItem(ctx, find(items, "server", "docs"), { id: null }),
    ).rejects.toThrow(/called docs is in this vault already/)
    await expect(
      applyItem(ctx, find(items, "skill", "release-notes"), { id: null }),
    ).rejects.toThrow(/called release-notes is in this vault already/)
    await expect(
      applyItem(ctx, find(items, "server", "docs"), { id: ids.pets }),
    ).rejects.toThrow(/not a server/)
    await expect(
      applyItem(
        ctx,
        { ...find(items, "server", "docs"), name: "pets" },
        { id: ids.docs },
      ),
    ).rejects.toThrow(/Another server is called pets/)
    expect(await findLocalItem(ctx, { kind: "server", name: "docs" })).toEqual({
      id: ids.docs,
      kind: "server",
    })
  })

  it("renames a row to the item's name, and carries its version", async () => {
    const items = await populatedItems()
    const ctx = await freshVault()
    const { ids } = await populate(ctx)
    const docs = find(items, "server", "docs")

    await applyItem(
      ctx,
      { ...docs, name: "team-docs", version: 7 },
      {
        id: ids.docs,
      },
    )
    expect(
      await db().mcpServer.findUniqueOrThrow({ where: { id: ids.docs } }),
    ).toMatchObject({ slug: "team-docs", syncVersion: 7 })
    expect((await localItem(ctx, "server", ids.docs)).document).toMatchObject({
      name: "team-docs",
      version: 7,
    })
  })

  it("keeps an endpoint read from a URL at its address, with the approved text as its copy", async () => {
    const ctx = await freshVault()
    const { id } = await createEndpoint(ctx, {
      name: "Pets",
      baseUrl: "https://pets.example.com/v1",
      specSource: "url",
      specUrl: "https://pets.example.com/openapi.json",
      fetched: {
        text: PETS_SPEC,
        url: "https://pets.example.com/openapi.json",
      },
      readOnly: false,
      authType: "none",
    })
    const local = (await localItem(ctx, "endpoint", id))
      .document as EndpointDocument
    const text = PETS_SPEC.replace('"title": "Pets"', '"title": "Pet shop"')

    await applyItem(
      ctx,
      {
        ...local,
        spec: { format: "json", text },
        toolDescriptions: { add_pet: "Adds a pet." },
      },
      { id },
    )

    expect(
      await db().mcpServer.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      specSource: "url",
      specUrl: "https://pets.example.com/openapi.json",
    })
    expect((await storedSpec(id))?.text).toBe(text)
    expect(
      await db().mcpTool.findFirstOrThrow({
        where: { serverId: id, name: "add_pet" },
      }),
    ).toMatchObject({ descriptionOverride: "Adds a pet." })
  })

  it("gives resolveDefinition the wrapper as the owner's form would", async () => {
    const items = await populatedItems()
    const wrapper = find(items, "wrapper", "pet-tools")

    expect(wrapperInput(wrapper)).toMatchObject({
      name: "Pet tools",
      callLevels: "approved",
      tools: [
        {
          name: "dogs",
          calls: ["pets/list_pets"],
          replaces: ["pets/list_pets"],
        },
        { name: "add", calls: ["pets/add_pet"] },
      ],
      secrets: [
        {
          secret: "Pets key",
          tool: "pets/list_pets",
          argument: "/key",
          template: "{{secret}}",
        },
      ],
    })
  })
})
