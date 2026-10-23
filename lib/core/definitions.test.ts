import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import { NEW_SECRET } from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import {
  checkPersonalNote,
  cloneServer,
  definitionOf,
  detachServer,
  dismissMerge,
  findIdenticalDefinitions,
  instancesOf,
  mergeDefinitions,
  readServerNote,
  setPersonalNote,
} from "./definitions"
import { getEndpoint, updateEndpointDetails } from "./endpoint-admin"
import { changeEndpoint, createEndpoint, storedSpec } from "./endpoints"
import {
  buildGatewayServer,
  buildInstructions,
  loadGatewayServers,
} from "./gateway"
import { definitionNotices } from "./owner-notices"
import { serializeItem } from "./repos/documents"
import { localItem } from "./repos/local"
import { listTools, ownerNotesFor } from "./search"
import { listSecrets } from "./secrets"
import {
  createServer,
  deleteServer,
  getServer,
  setToolDescription,
  updateServer,
} from "./servers"
import { createSkill, getSkill } from "./skills"
import { scratchDatabase } from "./test-db"
import { setToolAccess } from "./tool-access"
import { setupVault } from "./vault"

// Definitions and instances: servers that are the same thing share one
// definition (description, schema, edits, tool descriptions), each with its
// own address, credential, levels and the owner's note.

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

const SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Coolify" },
  servers: [{ url: "https://gaaf.example.com/api/v1" }],
  paths: {
    "/applications": {
      get: { operationId: "listApplications", summary: "Lists them." },
      post: { operationId: "createApplication" },
    },
    "/servers": { get: { operationId: "listServers" } },
  },
})

async function endpoint(
  name: string,
  baseUrl: string,
  extra: Partial<Parameters<typeof createEndpoint>[1]> = {},
) {
  const { id } = await createEndpoint(ctx, {
    name,
    description: "Coolify's REST API: applications and servers.",
    baseUrl,
    specSource: "upload",
    specText: SPEC,
    readOnly: false,
    authType: "none",
    ...extra,
  })
  return id
}

const toolNames = async (serverId: string) =>
  (
    await db().mcpTool.findMany({
      where: { serverId },
      orderBy: { name: "asc" },
    })
  ).map((tool) => tool.name)

describe("a new server", () => {
  it("is the one instance of a definition of its own, named after it", async () => {
    const id = await endpoint("Coolify on gaaf", "https://gaaf.example.com/")
    const server = await getServer(ctx, id)
    const definition = await definitionOf(ctx, id)

    expect(server.definitionId).toBe(definition!.id)
    expect(definition).toMatchObject({
      kind: "openapi",
      slug: server.slug,
      name: "Coolify on gaaf",
      description: "Coolify's REST API: applications and servers.",
      formatVersion: 1,
    })
    expect(definition!.instances.map((each) => each.id)).toEqual([id])
  })

  it("takes the next free definition slug", async () => {
    const first = await createServer(ctx, {
      name: "Docs",
      url: "https://docs.example.com/mcp",
      authType: "none",
    })
    // The server is renamed; its definition keeps the slug it had.
    await db().mcpServer.update({
      where: { id: first.id },
      data: { slug: "old-docs" },
    })
    const second = await createServer(ctx, {
      name: "Docs",
      url: "https://docs2.example.com/mcp",
      authType: "none",
    })

    expect((await definitionOf(ctx, second.id))!.slug).toBe("docs-2")
  })

  it("has none when it is a kind without one, and one is made for a row that lacks it", async () => {
    const id = await endpoint("Pets", "https://pets.example.com/")
    const definitionId = (await getServer(ctx, id)).definitionId!
    await db().mcpServer.update({ where: { id }, data: { definitionId: null } })
    await db().serverDefinition.delete({ where: { id: definitionId } })

    const made = await definitionOf(ctx, id)
    expect(made!.instances.map((each) => each.id)).toEqual([id])
  })

  it("takes its definition with it when it is the last one deleted", async () => {
    const id = await endpoint("Pets", "https://pets.example.com/")
    const clone = await cloneServer(ctx, id, {
      name: "Pets two",
      url: "https://pets2.example.com/",
      authType: "none",
    })
    const definitionId = (await getServer(ctx, id)).definitionId!

    await deleteServer(ctx, id)
    expect(
      await db().serverDefinition.count({ where: { id: definitionId } }),
    ).toBe(1)

    await deleteServer(ctx, clone.id)
    expect(
      await db().serverDefinition.count({ where: { id: definitionId } }),
    ).toBe(0)
  })
})

describe("cloneServer", () => {
  it("makes another instance: the definition's schema and words, its own address, secret and note, the source's levels", async () => {
    const source = await endpoint(
      "Coolify on gaaf",
      "https://gaaf.example.com/",
    )
    await setToolDescription(
      ctx,
      source,
      "listServers",
      "Every server Coolify runs.",
    )
    const { id: tokenId } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })
    await setToolAccess(ctx, tokenId, source, "listApplications", "allowed")
    await setToolAccess(ctx, tokenId, source, "createApplication", "blocked")
    await db().vaultToolAccess.create({
      data: {
        vaultId: ctx.vaultId,
        serverId: source,
        toolName: "listServers",
        access: "allowed",
      },
    })

    const { id } = await cloneServer(ctx, source, {
      name: "Coolify on plekde",
      url: "https://cool.de.example.com/api/v1",
      note: "plek.je production, cool.de.example.com",
      authType: "header",
      authHeaderName: "Authorization",
      authValueTemplate: "Bearer {{secret}}",
      authSecretId: NEW_SECRET,
      authSecretName: "plekde-coolify",
      authSecretValue: "s3cret-token",
    })

    const clone = await getServer(ctx, id)
    const original = await getServer(ctx, source)

    expect(clone.definitionId).toBe(original.definitionId)
    expect(clone.slug).toBe("coolify-on-plekde")
    expect(clone.url).toBe("https://cool.de.example.com/api/v1")
    expect(clone.description).toBe(original.description)
    expect(clone.authType).toBe("header")
    expect(clone.authSecretId).not.toBeNull()
    expect(original.authSecretId).toBeNull()
    expect(
      (await listSecrets(ctx)).find(
        (secret) => secret.id === clone.authSecretId,
      )?.name,
    ).toBe("plekde-coolify")
    expect(readServerNote(ctx, clone)).toBe(
      "plek.je production, cool.de.example.com",
    )
    expect(readServerNote(ctx, original)).toBeNull()

    expect(await toolNames(id)).toEqual(await toolNames(source))
    expect((await storedSpec(id))!.hash).toBe((await storedSpec(source))!.hash)
    expect(
      clone.tools.find((tool) => tool.name === "listServers")
        ?.descriptionOverride,
    ).toBe("Every server Coolify runs.")

    const levels = await db().apiTokenToolAccess.findMany({
      where: { serverId: id },
      orderBy: { toolName: "asc" },
    })
    expect(levels.map((row) => [row.toolName, row.access])).toEqual([
      ["createApplication", "blocked"],
      ["listApplications", "allowed"],
    ])
    expect(
      await db().vaultToolAccess.findMany({
        where: { serverId: id },
        select: { toolName: true, access: true },
      }),
    ).toEqual([{ toolName: "listServers", access: "allowed" }])

    expect(
      (await instancesOf(ctx, clone.definitionId!)).map((each) => each.slug),
    ).toEqual(["coolify-on-gaaf", "coolify-on-plekde"])
  })

  it("clones an MCP server with its address and the definition's description", async () => {
    const { id: source } = await createServer(ctx, {
      name: "Docs",
      url: "https://docs.example.com/mcp",
      description: "Product documentation search.",
      authType: "none",
    })
    const { id } = await cloneServer(ctx, source, {
      name: "Docs staging",
      url: "https://staging.docs.example.com/mcp",
      authType: "none",
      note: "staging",
    })
    const clone = await getServer(ctx, id)

    expect(clone.kind).toBe("mcp")
    expect(clone.url).toBe("https://staging.docs.example.com/mcp")
    expect(clone.description).toBe("Product documentation search.")
    expect(clone.definitionId).toBe((await getServer(ctx, source)).definitionId)
  })

  it("refuses a bad note, or no address, before anything is made", async () => {
    const source = await endpoint("Pets", "https://pets.example.com/")
    const before = await db().mcpServer.count()

    await expect(
      cloneServer(ctx, source, {
        name: "Pets two",
        url: "https://pets2.example.com/",
        authType: "none",
        note: "x".repeat(301),
      }),
    ).rejects.toThrow(/300 characters/)
    await expect(
      cloneServer(ctx, source, {
        name: "Pets two",
        url: " ",
        authType: "none",
      }),
    ).rejects.toThrow(/base URL/)
    expect(await db().mcpServer.count()).toBe(before)
  })
})

describe("a change to the definition", () => {
  it("reaches every instance, and each rebuilds its tools", async () => {
    const gaaf = await endpoint("Coolify on gaaf", "https://gaaf.example.com/")
    const { id: plekde } = await cloneServer(ctx, gaaf, {
      name: "Coolify on plekde",
      url: "https://cool.de.example.com/",
      authType: "none",
    })
    await db().mcpServer.update({
      where: { id: plekde },
      data: { readOnly: true },
    })

    await changeEndpoint(ctx, gaaf, {
      description: "Coolify's API.",
      patches: [{ op: "remove", path: "/paths/~1servers" }],
    })

    expect(await toolNames(gaaf)).toEqual([
      "createApplication",
      "listApplications",
    ])
    // Its own read-only setting still applies to the shared schema.
    expect(await toolNames(plekde)).toEqual(["listApplications"])
    expect((await storedSpec(plekde))!.patches).toEqual([
      { op: "remove", path: "/paths/~1servers" },
    ])
    expect((await getServer(ctx, plekde)).description).toBe("Coolify's API.")
    expect((await definitionOf(ctx, plekde))!.description).toBe(
      "Coolify's API.",
    )
    // The instance's own fields stay its own.
    expect((await getServer(ctx, plekde)).url).toBe(
      "https://cool.de.example.com",
    )

    await setToolDescription(
      ctx,
      plekde,
      "listApplications",
      "Apps on this host.",
    )
    expect(
      (await getServer(ctx, gaaf)).tools.find(
        (tool) => tool.name === "listApplications",
      )?.descriptionOverride,
    ).toBe("Apps on this host.")
  })

  it("from an MCP server's form, changes the description of the others", async () => {
    const { id: first } = await createServer(ctx, {
      name: "Docs",
      url: "https://docs.example.com/mcp",
      authType: "none",
    })
    const { id: second } = await cloneServer(ctx, first, {
      name: "Docs staging",
      url: "https://staging.docs.example.com/mcp",
      authType: "none",
    })

    await updateServer(ctx, second, {
      name: "Docs staging",
      url: "https://staging.docs.example.com/mcp",
      description: "Search the docs.",
      authType: "none",
    })

    expect((await getServer(ctx, first)).description).toBe("Search the docs.")
    expect((await getServer(ctx, first)).url).toBe(
      "https://docs.example.com/mcp",
    )
  })

  it("made switched off switches every instance off", async () => {
    const gaaf = await endpoint("Coolify on gaaf", "https://gaaf.example.com/")
    const { id: plekde } = await cloneServer(ctx, gaaf, {
      name: "Coolify on plekde",
      url: "https://cool.de.example.com/",
      authType: "none",
    })

    await changeEndpoint(ctx, gaaf, { description: "Changed.", disable: true })

    expect((await getServer(ctx, plekde)).enabled).toBe(false)
    expect((await getServer(ctx, gaaf)).enabled).toBe(false)
  })
})

describe("an assistant's endpoint", () => {
  it("is the owner's once it shares its definition with one of theirs: what they share is only asked for", async () => {
    // As an assistant registers one: public addresses only, no secret.
    const own = await endpoint("Pets", "https://pets.example.com/", {
      publicOnly: true,
    })
    const scope = { ctx, tokenId: "token", serverIds: null }
    const slug = (await getServer(ctx, own)).slug

    expect((await getEndpoint(scope, slug)).belongsTo).toBe("assistant")

    // The owner clones it, with their secret.
    await cloneServer(ctx, own, {
      name: "Pets live",
      url: "https://live.pets.example.com/",
      authType: "header",
      authHeaderName: "Authorization",
      authValueTemplate: "Bearer {{secret}}",
      authSecretId: NEW_SECRET,
      authSecretName: "pets-live",
      authSecretValue: "live-key",
    })

    expect((await getEndpoint(scope, slug)).belongsTo).toBe("owner")
    const result = await updateEndpointDetails(scope, slug, {
      description: "Changed by an assistant.",
    })
    expect("ask" in result && result.ask.shown.lines).toContain(
      "Shared: this changes 2 servers: pets, pets-live",
    )
    expect((await getServer(ctx, own)).description).toBe(
      "Coolify's REST API: applications and servers.",
    )
  })
})

describe("detachServer", () => {
  it("gives the server a definition of its own, so changes no longer reach it", async () => {
    const gaaf = await endpoint("Coolify on gaaf", "https://gaaf.example.com/")
    const { id: plekde } = await cloneServer(ctx, gaaf, {
      name: "Coolify on plekde",
      url: "https://cool.de.example.com/",
      authType: "none",
    })
    const shared = (await getServer(ctx, gaaf)).definitionId

    const { definitionId } = await detachServer(ctx, plekde)

    expect(definitionId).not.toBe(shared)
    expect((await getServer(ctx, plekde)).definitionId).toBe(definitionId)
    expect((await definitionOf(ctx, plekde))!.slug).toBe("coolify-on-plekde")

    await changeEndpoint(ctx, gaaf, {
      description: "Only gaaf.",
      patches: [{ op: "remove", path: "/paths/~1servers" }],
    })

    expect((await getServer(ctx, plekde)).description).toBe(
      "Coolify's REST API: applications and servers.",
    )
    expect(await toolNames(plekde)).toContain("listServers")
    await expect(detachServer(ctx, plekde)).rejects.toThrow(/only server/)
  })
})

describe("merging definitions", () => {
  it("offers endpoints with the same schema, and merges them on the owner's word", async () => {
    const gaaf = await endpoint("Coolify on gaaf", "https://gaaf.example.com/")
    const plekde = await endpoint(
      "Coolify on plekde",
      "https://cool.de.example.com/",
      {
        description: "Coolify on the production host.",
      },
    )
    await endpoint("Other", "https://other.example.com/", {
      specText: SPEC.replace("listServers", "listHosts"),
    })

    const [group, ...more] = await findIdenticalDefinitions(ctx)
    expect(more).toEqual([])
    expect(
      group!.definitions.flatMap((definition) =>
        definition.instances.map((instance) => instance.slug),
      ),
    ).toEqual(["coolify-on-gaaf", "coolify-on-plekde"])

    const notices = await definitionNotices(ctx)
    expect(notices).toEqual([
      expect.objectContaining({
        kind: "definitions",
        title: "Two API endpoints have the same schema: merge them?",
        href: `/servers/merge/${group!.key}`,
      }),
    ])

    const keep = (await getServer(ctx, gaaf)).definitionId!
    const gone = (await getServer(ctx, plekde)).definitionId!
    const merged = await mergeDefinitions(ctx, keep, [gone], {
      key: group!.key,
      name: "Coolify API",
    })

    expect(merged.name).toBe("Coolify API")
    expect(merged.instances.map((instance) => instance.id)).toEqual([
      gaaf,
      plekde,
    ])
    expect(await db().serverDefinition.count({ where: { id: gone } })).toBe(0)
    const after = await getServer(ctx, plekde)
    expect(after.definitionId).toBe(keep)
    expect(after.description).toBe(
      "Coolify's REST API: applications and servers.",
    )
    expect(after.url).toBe("https://cool.de.example.com")
    expect(await findIdenticalDefinitions(ctx)).toEqual([])
  })

  it("refuses endpoints that are no longer the same", async () => {
    const gaaf = await endpoint("Coolify on gaaf", "https://gaaf.example.com/")
    const plekde = await endpoint(
      "Coolify on plekde",
      "https://cool.de.example.com/",
    )
    const [group] = await findIdenticalDefinitions(ctx)

    await setToolDescription(ctx, plekde, "listServers", "Changed since.")

    await expect(
      mergeDefinitions(
        ctx,
        (await getServer(ctx, gaaf)).definitionId!,
        [(await getServer(ctx, plekde)).definitionId!],
        { key: group!.key },
      ),
    ).rejects.toThrow(/no longer have the same/)
  })

  it("stops offering a group the owner said no to", async () => {
    await endpoint("Coolify on gaaf", "https://gaaf.example.com/")
    await endpoint("Coolify on plekde", "https://cool.de.example.com/")
    const [group] = await findIdenticalDefinitions(ctx)

    await dismissMerge(ctx, group!.key)

    expect(await findIdenticalDefinitions(ctx)).toEqual([])
  })
})

describe("the owner's note", () => {
  it("is one line of at most 300 characters that all show on screen", () => {
    expect(checkPersonalNote("  plek.je production  ")).toBe(
      "plek.je production",
    )
    expect(checkPersonalNote("")).toBeNull()
    expect(checkPersonalNote(null)).toBeNull()
    expect(checkPersonalNote("é".repeat(300))).toHaveLength(300)
    expect(() => checkPersonalNote("x".repeat(301))).toThrow(/300 characters/)
    expect(() => checkPersonalNote("two\nlines")).toThrow(/one line/)
    expect(() => checkPersonalNote("tab\there")).toThrow(/U\+0009/)
    expect(() => checkPersonalNote("zero​width")).toThrow(/U\+200B/)
    expect(() => checkPersonalNote("bell\u0007")).toThrow(/U\+0007/)
  })

  it("is kept encrypted, for servers and skills, and taken away when empty", async () => {
    const id = await endpoint("Pets", "https://pets.example.com/")
    await setPersonalNote(ctx, "server", id, "the shop's own pets")
    const row = await db().mcpServer.findUniqueOrThrow({ where: { id } })

    expect(Buffer.from(row.personalNote!).toString("utf8")).not.toContain(
      "pets",
    )
    expect(readServerNote(ctx, row)).toBe("the shop's own pets")

    await setPersonalNote(ctx, "server", id, "")
    expect(
      (await db().mcpServer.findUniqueOrThrow({ where: { id } })).personalNote,
    ).toBeNull()

    const skill = await createSkill(ctx, {
      name: "release-notes",
      description: "Write release notes.",
      body: "Steps.",
      tools: [],
    })
    await setPersonalNote(ctx, "skill", skill.id, "for pcp only")
    expect((await getSkill(ctx, skill.id)).note).toBe("for pcp only")
    await expect(setPersonalNote(ctx, "skill", "nope", "x")).rejects.toThrow(
      /not found/,
    )
  })

  it("never goes into a repository document", async () => {
    const id = await endpoint("Pets", "https://pets.example.com/")
    await setPersonalNote(ctx, "server", id, "SECRET-NOTE-endpoint")
    const { id: server } = await createServer(ctx, {
      name: "Docs",
      url: "https://docs.example.com/mcp",
      authType: "none",
    })
    await setPersonalNote(ctx, "server", server, "SECRET-NOTE-server")
    const skill = await createSkill(ctx, {
      name: "release-notes",
      description: "Write release notes.",
      body: "Steps.",
      tools: [],
    })
    await setPersonalNote(ctx, "skill", skill.id, "SECRET-NOTE-skill")

    for (const [kind, itemId] of [
      ["endpoint", id],
      ["server", server],
      ["skill", skill.id],
    ] as const) {
      const { document } = await localItem(ctx, kind, itemId)
      const files = serializeItem(document)

      expect(JSON.stringify(document)).not.toContain("SECRET-NOTE")
      expect(JSON.stringify(files)).not.toContain("SECRET-NOTE")
    }
  })
})

describe("what assistants read", () => {
  it("names the owner's note in the instructions, search, list_tools and describe", async () => {
    const id = await endpoint(
      "Coolify on plekde",
      "https://cool.de.example.com/",
    )
    await setPersonalNote(
      ctx,
      "server",
      id,
      "plek.je production, cool.de.example.com",
    )
    const skill = await createSkill(ctx, {
      name: "deploy",
      description: "Deploy an application.",
      body: "Steps.",
      tools: [],
    })
    await setPersonalNote(ctx, "skill", skill.id, "only on weekdays")
    const { token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: true,
    })
    const scope = {
      ...(await resolveApiToken(token))!,
      publicUrl: "http://localhost:3000",
    }
    const servers = await loadGatewayServers(scope)

    expect(servers[0]!.note).toBe("plek.je production, cool.de.example.com")
    expect(buildInstructions(servers)).toContain(
      "- coolify-on-plekde: Coolify's REST API: applications and servers. (3 tools) Owner's note: plek.je production, cool.de.example.com",
    )

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, servers, {
      skills: [
        {
          name: "deploy",
          description: "Deploy an application.",
          note: "only on weekdays",
        },
      ],
    }).connect(serverSide)
    const client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
    const say = async (name: string, args: Record<string, unknown>) =>
      (
        (await client.callTool({ name, arguments: args })).content as Array<{
          text?: string
        }>
      )[0]!.text!

    const told = client.getInstructions() ?? ""
    const found = await say("search", { query: "list applications" })
    const deploy = await say("search", { query: "deploy" })
    const listed = await say("list_tools", { server: "coolify-on-plekde" })
    const described = JSON.parse(
      await say("describe", { ref: "coolify-on-plekde/listApplications" }),
    )
    const skillText = await say("describe", { ref: "skill:deploy" })
    await client.close()

    expect(told).toContain("Owner's note: plek.je production")
    expect(told).toContain(
      "- skill:deploy: Deploy an application. Owner's note: only on weekdays",
    )
    expect(found).toContain(
      "Owner's note on coolify-on-plekde: plek.je production, cool.de.example.com",
    )
    expect(deploy).toContain("Owner's note on skill:deploy: only on weekdays")
    expect(listed.split("\n").slice(0, 2)).toEqual([
      "coolify-on-plekde (Coolify on plekde): Coolify's REST API: applications and servers.",
      "Owner's note: plek.je production, cool.de.example.com",
    ])
    expect(described).toMatchObject({
      server: "coolify-on-plekde",
      serverName: "Coolify on plekde",
      ownerNote: "plek.je production, cool.de.example.com",
    })
    expect(skillText).toContain("Owner's note: only on weekdays")
  })

  it("finds a server by its note, and lists notes once per server", () => {
    expect(
      ownerNotesFor(
        ["a/one", "b/two", "a/three", "skill:x", "/memories/m.md"],
        new Map([
          ["a", "alpha"],
          ["skill:x", "ex"],
        ]),
      ),
    ).toEqual(["Owner's note on a: alpha", "Owner's note on skill:x: ex"])
    expect(
      listTools("a", [], { about: { name: "A", description: "", note: "n" } }),
    ).toBe("a (A)\nOwner's note: n\na has no tools you can see.")
  })
})
