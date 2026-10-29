import { afterEach, describe, expect, it } from "vitest"

import { createBrowserServer } from "../browser/server"
import type { VaultContext } from "../context"
import { db } from "../db"
import { readServerNote, setPersonalNote } from "../definitions"
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
import { addSecrets, PETS_SPEC, populate, yamlText } from "./test-vault"

// Applying what the owner approved: names resolved against this vault and
// never guessed, a secret the vault lacks left out with a note, the owner's
// own write paths doing the writing, and a server's item written as its
// definition only: never an instance's own address, sign-in or switches.

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

/** A format-1 pcp.yaml for the pet shop, as an older PCP wrote it. */
function formatOnePets(overrides: Record<string, unknown> = {}): RepoFiles {
  return {
    "endpoints/pets/openapi.json": PETS_SPEC,
    "endpoints/pets/pcp.yaml": yamlText({
      pcp_format: 1,
      version: 3,
      name: "Pets",
      description: "The pet shop's API.",
      baseUrl: "https://pets.example.com/v1",
      readOnly: false,
      publicOnly: true,
      auth: {
        kind: "header",
        header: "X-Api-Key",
        template: "{{secret}}",
        secret: "Pets key",
      },
      ...overrides,
    }),
  }
}

describe("applying an item", () => {
  it("asks for a new server's own address, and takes the one the owner gives", async () => {
    const items = await populatedItems()
    const ctx = await freshVault()
    const pets = find(items, "endpoint", "pets")

    expect(pets.instance).toBeNull()
    await expect(applyItem(ctx, pets, { id: null })).rejects.toThrow(
      /no base URL of its own/,
    )
    await expect(
      applyItem(ctx, find(items, "server", "docs"), { id: null }),
    ).rejects.toThrow(/no address of its own/)

    const { id, notes } = await applyItem(ctx, pets, {
      id: null,
      instance: {
        name: "Pets at home",
        url: "https://pets.home.example/v1",
        note: "The shop in the garage.",
        authType: "none",
      },
    })
    expect(notes).toEqual([])
    const row = await db().mcpServer.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({
      name: "Pets at home",
      slug: "pets-at-home",
      url: "https://pets.home.example/v1",
      // An endpoint the owner adds is read-only until they say otherwise.
      readOnly: true,
    })
    expect(readServerNote(ctx, row)).toBe("The shop in the garage.")
    expect(
      await db().serverDefinition.findUniqueOrThrow({
        where: { id: row.definitionId! },
      }),
    ).toMatchObject({ slug: "pets", name: "Pets" })
    expect(
      await findLocalItem(ctx, { kind: "endpoint", name: "pets" }),
    ).toEqual({ id, kind: "endpoint" })
  })

  it("reports a secret a wrapper places that the vault does not have, and saves it without", async () => {
    const items = await populatedItems()
    const ctx = await freshVault()
    await createBrowserServer(ctx)
    await applyItem(ctx, find(items, "endpoint", "pets"), {
      id: null,
      instance: {
        name: "Pets",
        url: "https://pets.example.com/v1",
        readOnly: false,
        authType: "none",
      },
    })

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

    // No value was made up.
    expect(await db().secret.count({ where: { kind: "text" } })).toBe(0)
  })

  it("fills a first instance in from a format-1 document, and never writes it over a server the vault has", async () => {
    const ctx = await freshVault()
    const secrets = await addSecrets(ctx)
    const [first] = (await readRepo(formatOnePets())).items as [
      EndpointDocument,
    ]

    expect(first.instance).toEqual({
      url: "https://pets.example.com/v1",
      readOnly: false,
      publicOnly: true,
    })
    const { id } = await applyItem(ctx, first, { id: null })
    expect(
      await db().mcpServer.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      url: "https://pets.example.com/v1",
      readOnly: false,
      publicOnly: true,
      authType: "header",
      authHeaderName: "X-Api-Key",
      authSecretId: secrets.pets,
    })

    // The owner moves it, signs it in otherwise and makes it read-only;
    // a later format-1 document saying otherwise changes none of it.
    await db().mcpServer.update({
      where: { id },
      data: {
        url: "https://pets.home.example/v1",
        readOnly: true,
        publicOnly: false,
        authHeaderName: "X-Key",
        authSecretId: secrets.client,
      },
    })
    const [later] = (
      await readRepo(
        formatOnePets({
          baseUrl: "https://evil.example/v1",
          readOnly: false,
          publicOnly: true,
          description: "The pet shop's API, now with cats.",
          auth: { kind: "basic", username: "mallory", secret: "Pets key" },
        }),
      )
    ).items as [EndpointDocument]
    await applyItem(ctx, later, { id })
    expect(
      await db().mcpServer.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      url: "https://pets.home.example/v1",
      readOnly: true,
      publicOnly: false,
      authType: "header",
      authHeaderName: "X-Key",
      authSecretId: secrets.client,
      description: "The pet shop's API, now with cats.",
    })
  })

  it("never writes an instance's own name, address, sign-in, switches, levels or note", async () => {
    const items = await populatedItems()
    const ctx = await freshVault()
    const { ids } = await populate(ctx)
    await setPersonalNote(ctx, "server", ids.docs, "Ours, on the NAS.")
    await db().mcpServer.update({
      where: { id: ids.docs },
      data: {
        name: "Our docs",
        url: "https://docs.home.example/mcp",
        enabled: false,
        publicOnly: false,
      },
    })
    await db().vaultToolAccess.create({
      data: {
        vaultId: ctx.vaultId,
        serverId: ids.pets,
        toolName: "list_pets",
        access: "allow",
      },
    })
    const before = {
      docs: await db().mcpServer.findUniqueOrThrow({ where: { id: ids.docs } }),
      pets: await db().mcpServer.findUniqueOrThrow({ where: { id: ids.pets } }),
    }
    const docs = find(items, "server", "docs")
    const pets = find(items, "endpoint", "pets")

    await applyItem(
      ctx,
      {
        ...docs,
        description: "The team's documents, all of them.",
        instance: { url: "https://evil.example/mcp", publicOnly: true },
        auth: { kind: "none" },
      },
      { id: ids.docs },
    )
    await applyItem(
      ctx,
      {
        ...pets,
        displayName: "Pet shop",
        instance: {
          url: "https://evil.example/v1",
          readOnly: false,
          publicOnly: false,
        },
        auth: { kind: "none" },
        toolDescriptions: { list_pets: "Every pet." },
      },
      { id: ids.pets },
    )

    const instanceFields = [
      "name",
      "slug",
      "url",
      "enabled",
      "readOnly",
      "publicOnly",
      "authType",
      "authHeaderName",
      "authValueTemplate",
      "authSecretId",
      "authUsername",
      "oauthClientId",
      "oauthClientSecretId",
      "personalNote",
    ] as const
    const after = {
      docs: await db().mcpServer.findUniqueOrThrow({ where: { id: ids.docs } }),
      pets: await db().mcpServer.findUniqueOrThrow({ where: { id: ids.pets } }),
    }

    for (const field of instanceFields) {
      expect(after.docs[field]).toEqual(before.docs[field])
      expect(after.pets[field]).toEqual(before.pets[field])
    }

    expect(after.docs.description).toBe("The team's documents, all of them.")
    expect(readServerNote(ctx, after.docs)).toBe("Ours, on the NAS.")
    expect(
      await db().vaultToolAccess.findMany({ where: { serverId: ids.pets } }),
    ).toMatchObject([{ toolName: "list_pets", access: "allow" }])
    // The definition takes the item's name; the instance keeps its own.
    expect(
      await db().serverDefinition.findUniqueOrThrow({
        where: { id: after.pets.definitionId! },
      }),
    ).toMatchObject({ name: "Pet shop" })
    expect(
      await db().mcpTool.findFirstOrThrow({
        where: { serverId: ids.pets, name: "list_pets" },
      }),
    ).toMatchObject({ descriptionOverride: "Every pet." })
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

    await applyItem(ctx, find(items, "endpoint", "pets"), {
      id: null,
      instance: {
        name: "Pets",
        url: "https://pets.example.com/v1",
        readOnly: false,
        authType: "none",
      },
    })
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
    expect(await findLocalItem(ctx, { kind: "server", name: "docs" })).toEqual({
      id: ids.docs,
      kind: "server",
    })
  })

  it("renames the definition to the item's name, never the server, and carries its version", async () => {
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
    const row = await db().mcpServer.findUniqueOrThrow({
      where: { id: ids.docs },
    })
    expect(row).toMatchObject({ slug: "docs", syncVersion: 7 })
    expect(
      await db().serverDefinition.findUniqueOrThrow({
        where: { id: row.definitionId! },
      }),
    ).toMatchObject({ slug: "team-docs" })
    expect((await localItem(ctx, "server", ids.docs)).document).toMatchObject({
      name: "team-docs",
      version: 7,
    })

    // A short name another definition has stays the definition's own.
    await applyItem(ctx, { ...docs, name: "pets" }, { id: ids.docs })
    expect(
      await db().serverDefinition.findUniqueOrThrow({
        where: { id: row.definitionId! },
      }),
    ).toMatchObject({ slug: "team-docs" })
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
