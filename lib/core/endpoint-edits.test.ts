import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { db } from "./db"
import {
  createApprovedEndpoint,
  getEndpoint,
  prepareRegistration,
  updateEndpointDetails,
  type EndpointScope,
  type RegistrationInput,
} from "./endpoint-admin"
import { syncEndpointTools, updateEndpoint } from "./endpoints"
import { json, startTestApi, type TestApi } from "./openapi/test-api"
import { createSecret } from "./secrets"
import { getServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

/**
 * Schemas registered by URL, and edits (a JSON Patch kept beside a schema).
 * The test servers are on loopback, which a public-only download refuses;
 * here it is let through, except where a test turns that off to see it
 * refused.
 */
const network = vi.hoisted(() => ({ allowLoopback: true }))

vi.mock("./openapi/fetch-spec", async (importOriginal) => {
  const real = await importOriginal<typeof import("./openapi/fetch-spec")>()

  return {
    ...real,
    fetchSpec: (
      url: string,
      options: Parameters<typeof real.fetchSpec>[1] = {},
    ) =>
      real.fetchSpec(
        url,
        network.allowLoopback
          ? { ...options, addressCheck: () => true }
          : options,
      ),
  }
})

let cleanup: () => Promise<void>
let api: TestApi
let docs: TestApi
let ctx: Awaited<ReturnType<typeof setupVault>>
let scope: EndpointScope
/** What the schema URL answers; tests change it to change the document. */
let published: string

function spec(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Pets" },
    servers: [{ url: "https://demo.example.com/api" }],
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          parameters: [{ $ref: "#/components/parameters/XRequestedWith" }],
        },
        post: { operationId: "createPet" },
      },
      "/login": { post: { operationId: "login" } },
    },
    components: {
      parameters: {
        XRequestedWith: {
          name: "X-Requested-With",
          in: "header",
          required: true,
          schema: { type: "string" },
        },
      },
    },
    ...extra,
  })
}

/** The fixes an assistant would send for this schema. */
const fixes = () => [
  { op: "replace", path: "/servers/0/url", value: `${api.origin}/api` },
  { op: "remove", path: "/paths/~1login" },
  {
    op: "replace",
    path: "/components/parameters/XRequestedWith/required",
    value: false,
  },
]

const specUrl = () => `${docs.origin}/openapi.json`

async function approve(input: RegistrationInput) {
  const prepared = await prepareRegistration(ctx, input)
  const { id } = await createApprovedEndpoint(ctx, {
    name: prepared.name,
    description: prepared.description,
    url: prepared.url,
    authType: input.authSecretId ? "header" : "none",
    authHeaderName: input.authHeaderNames?.[0] ?? null,
    authValueTemplate: input.authSecretId ? "{{secret}}" : null,
    authSecretId: input.authSecretId ?? null,
    endpoint: prepared.registration,
  })

  return { id, slug: (await getServer(ctx, id)).slug, prepared }
}

/** Registered from the URL with the fixes, approved and enabled. */
async function fromUrl() {
  return approve({ name: "Pets", specUrl: specUrl(), patches: fixes() })
}

const toolNames = async (slug: string) =>
  (await getEndpoint(scope, slug)).tools!.map((tool) => tool.name)

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  scope = { ctx, tokenId: "token", serverIds: null }
  network.allowLoopback = true
  published = spec()
  api = await startTestApi((req, res) => json(res, 200, { path: req.url }))
  docs = await startTestApi((_, res) => {
    res.setHeader("content-type", "application/json")
    res.end(published)
  })
})

afterEach(async () => {
  await api.close()
  await docs.close()
  await cleanup()
})

describe("registering an endpoint from a schema URL", () => {
  it("downloads it before the owner is asked and shows them the edited tools", async () => {
    const { registration, url } = await prepareRegistration(ctx, {
      name: "Pets",
      specUrl: specUrl(),
      patches: fixes(),
    })

    expect(url).toBe(`${api.origin}/api`)
    expect(registration.specUrl).toBe(specUrl())
    expect(registration.spec).toBe(published)
    expect(registration.patches).toHaveLength(3)
    expect(registration.preview.operations).toEqual(["GET /pets", "POST /pets"])
    expect(docs.requests).toHaveLength(1)
  })

  it("creates the endpoint from the approved copy, not a second download", async () => {
    const prepared = await prepareRegistration(ctx, {
      name: "Pets",
      specUrl: specUrl(),
      patches: fixes(),
    })
    published = spec({ paths: {} })

    const { id } = await createApprovedEndpoint(ctx, {
      name: prepared.name,
      description: prepared.description,
      url: prepared.url,
      authType: "none",
      endpoint: prepared.registration,
    })
    const row = await getServer(ctx, id)
    const details = await getEndpoint(scope, row.slug)
    const { patches } = await getEndpoint(scope, row.slug, {
      includePatches: true,
    })

    expect(docs.requests).toHaveLength(1)
    expect(row).toMatchObject({
      specSource: "url",
      specUrl: specUrl(),
      specUrlFromAssistant: true,
      publicOnly: true,
    })
    expect(details.tools!.map((tool) => tool.name)).toEqual([
      "createPet",
      "listPets",
    ])
    expect(details.schema).toMatchObject({
      source: "url",
      urlFromAssistant: true,
      edits: 3,
    })
    expect(patches).toEqual(fixes())
  })

  it("takes the schema as text or by URL, one of the two", async () => {
    await expect(
      prepareRegistration(ctx, {
        name: "Both",
        spec: spec(),
        specUrl: specUrl(),
      }),
    ).rejects.toThrow(/one of the two/)
    await expect(prepareRegistration(ctx, { name: "Neither" })).rejects.toThrow(
      /one of the two/,
    )
  })

  it("does not repeat what it downloaded when it is not a schema", async () => {
    // JSON.parse quotes the text around where it stopped.
    published = '{"internal": build 4711, "token": "abc"}'

    const refused = prepareRegistration(ctx, {
      name: "Pets",
      specUrl: specUrl(),
    })
    await expect(refused).rejects.toThrow(
      /^The document at that address could not be read as JSON or YAML\.$/,
    )
  })

  it("downloads from public addresses only", async () => {
    network.allowLoopback = false

    await expect(
      prepareRegistration(ctx, { name: "Pets", specUrl: specUrl() }),
    ).rejects.toThrow(/private or local address/)
    expect(docs.requests).toHaveLength(0)
  })

  it("refuses an edit that does not apply before anyone is asked", async () => {
    await expect(
      prepareRegistration(ctx, {
        name: "Pets",
        specUrl: specUrl(),
        patches: [...fixes(), { op: "remove", path: "/paths/~1nope" }],
      }),
    ).rejects.toThrow(/Edit 4 \(remove \/paths\/~1nope\): there is nothing at/)
    await expect(
      prepareRegistration(ctx, {
        name: "Pets",
        spec: spec(),
        patches: [{ op: "replace", path: "/openapi", value: "2.0" }],
      }),
    ).rejects.toThrow(/openapi: 3\.x/)
    expect(await db().mcpServer.count()).toBe(0)
  })

  it("applies edits to a schema given as text too", async () => {
    const { slug } = await approve({
      name: "Pets",
      spec: spec(),
      patches: fixes(),
    })

    expect(await toolNames(slug)).toEqual(["createPet", "listPets"])
  })
})

describe("reading a schema URL an assistant proposed again", () => {
  it("does not take a changed document unless the owner asks, and keeps the edits when they do", async () => {
    const { id, slug } = await fromUrl()
    published = spec({
      paths: {
        ...JSON.parse(spec()).paths,
        "/pets/{id}": {
          delete: {
            operationId: "deletePet",
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
          },
        },
      },
    })

    const background = await syncEndpointTools(await getServer(ctx, id))
    expect(background.message).toMatch(/changed since it was approved/)
    expect(await toolNames(slug)).toEqual(["createPet", "listPets"])
    expect((await getServer(ctx, id)).status).toBe("ok")

    const byOwner = await syncEndpointTools(await getServer(ctx, id), {
      byOwner: true,
    })
    expect(byOwner.status).toBe("ok")
    // /login is still removed: the edits apply to the new document.
    expect(await toolNames(slug)).toEqual([
      "createPet",
      "deletePet",
      "listPets",
    ])
  })

  it("rebuilds as usual when the document has not changed", async () => {
    const { id, slug } = await fromUrl()
    const sync = await syncEndpointTools(await getServer(ctx, id))

    expect(sync).toMatchObject({ status: "ok", toolCount: 2 })
    expect(await toolNames(slug)).toEqual(["createPet", "listPets"])
  })

  it("keeps the tools it has when an edit no longer applies, and says which", async () => {
    const { id, slug } = await fromUrl()
    published = spec({ servers: [] })

    const sync = await syncEndpointTools(await getServer(ctx, id), {
      byOwner: true,
    })
    expect(sync.status).toBe("error")
    expect(sync.message).toMatch(/Edit 1 \(replace \/servers\/0\/url\)/)
    expect(await toolNames(slug)).toEqual(["createPet", "listPets"])
  })

  it("follows changes again once the owner chooses the URL themselves", async () => {
    const { id } = await fromUrl()
    const row = await getServer(ctx, id)

    await updateEndpoint(ctx, id, {
      name: row.name,
      baseUrl: row.url,
      specSource: "url",
      specUrl: specUrl(),
      readOnly: false,
      publicOnly: true,
      authType: "none",
    })
    expect((await getServer(ctx, id)).specUrlFromAssistant).toBe(true)

    await updateEndpoint(ctx, id, {
      name: row.name,
      baseUrl: row.url,
      specSource: "url",
      specUrl: `${specUrl()}?v=2`,
      readOnly: false,
      publicOnly: true,
      authType: "none",
    })
    const moved = await getServer(ctx, id)
    expect(moved.specUrlFromAssistant).toBe(false)
    // The owner's form keeps the edits it does not mention.
    expect(
      (await getEndpoint(scope, moved.slug, { includePatches: true })).patches,
    ).toEqual(fixes())
  })
})

describe("changing an endpoint with edits", () => {
  it("adds edits after the ones it has, and is disabled until the owner enables it", async () => {
    const { id, slug } = await fromUrl()
    const result = await updateEndpointDetails(scope, slug, {
      addPatches: [{ op: "remove", path: "/paths/~1pets/post" }],
    })

    expect(result.updated).toMatch(/1 tool\..*disabled until the owner/)
    expect(result.enabled).toBe(false)
    expect(result.schema.edits).toBe(4)
    expect(await toolNames(slug)).toEqual(["listPets"])
    expect((await getServer(ctx, id)).enabled).toBe(false)
  })

  it("replaces every edit with patches, and [] removes them all", async () => {
    const { slug } = await approve({ name: "Pets", spec: spec() })
    await updateEndpointDetails(scope, slug, { patches: fixes() })
    expect(await toolNames(slug)).toEqual(["createPet", "listPets"])

    await updateEndpointDetails(scope, slug, { patches: [] })
    expect(await toolNames(slug)).toEqual(["createPet", "listPets", "login"])
  })

  it("is not disabled by sending the edits it already has", async () => {
    const { id, slug } = await fromUrl()
    const result = await updateEndpointDetails(scope, slug, {
      patches: fixes(),
    })

    expect(result.enabled).toBe(true)
    expect((await getServer(ctx, id)).enabled).toBe(true)
  })

  it("refuses an edit that does not apply and leaves the endpoint as it was, still on", async () => {
    const { id, slug } = await fromUrl()

    // Numbered in the endpoint's whole list: three were there already.
    await expect(
      updateEndpointDetails(scope, slug, {
        name: "Renamed",
        addPatches: [{ op: "remove", path: "/paths/~1cats" }],
      }),
    ).rejects.toThrow(/Edit 4 \(remove \/paths\/~1cats\)/)

    const row = await getServer(ctx, id)
    expect(row).toMatchObject({ enabled: true, name: "Pets" })
    expect(await toolNames(slug)).toEqual(["createPet", "listPets"])
  })

  it("takes patches or addPatches, not both", async () => {
    const { slug } = await fromUrl()

    await expect(
      updateEndpointDetails(scope, slug, { patches: [], addPatches: [] }),
    ).rejects.toThrow(/not both/)
  })

  it("keeps the edits when a schema given as text is replaced", async () => {
    const { slug } = await approve({
      name: "Pets",
      spec: spec(),
      patches: fixes(),
    })
    await updateEndpointDetails(scope, slug, {
      spec: spec({ info: { title: "Pets v2" } }),
    })

    expect(await toolNames(slug)).toEqual(["createPet", "listPets"])
  })

  it("reads the URL again on request: a new document disables, the same one does not", async () => {
    const { slug } = await fromUrl()
    const same = await updateEndpointDetails(scope, slug, {
      refreshSpec: true,
    })
    expect(same.updated).toMatch(/has not changed/)
    expect(same.enabled).toBe(true)

    published = spec({ info: { title: "Pets, now with more" } })
    const changed = await updateEndpointDetails(scope, slug, {
      refreshSpec: true,
    })
    expect(changed.enabled).toBe(false)
    expect(changed.updated).toMatch(/disabled until the owner/)
  })

  it("has no URL to read again for a schema given as text, and takes no text for one with a URL", async () => {
    const text = await approve({ name: "Text pets", spec: spec() })
    await expect(
      updateEndpointDetails(scope, text.slug, { refreshSpec: true }),
    ).rejects.toThrow(/no URL to read again/)

    const url = await fromUrl()
    await expect(
      updateEndpointDetails(scope, url.slug, { spec: spec() }),
    ).rejects.toThrow(/change it with patches/)
  })

  it("leaves an endpoint that sends the owner's secret to the owner", async () => {
    const { id: secretId } = await createSecret(ctx, {
      name: "Pets key",
      value: "sk-live-0123456789",
    })
    const { slug } = await approve({
      name: "Pets",
      specUrl: specUrl(),
      patches: fixes(),
      baseUrl: `${api.origin}/api`,
      authSecretId: secretId,
      authHeaderNames: ["X-API-TOKEN"],
    })

    for (const change of [
      { patches: [] },
      { addPatches: [{ op: "remove", path: "/paths/~1pets/post" }] },
      { refreshSpec: true },
    ]) {
      await expect(updateEndpointDetails(scope, slug, change)).rejects.toThrow(
        /owner's/,
      )
    }

    expect((await getEndpoint(scope, slug)).changes).toMatchObject({
      patches: expect.stringMatching(/^no: the owner/),
      refreshSpec: expect.stringMatching(/^no: the owner/),
    })
  })
})

describe("reading a schema a part at a time", () => {
  it("reads a part of the edited schema by pointer, or of the schema as stored", async () => {
    const { slug } = await fromUrl()
    const edited = await getEndpoint(scope, slug, {
      specPointer: "/servers/0/url",
    })
    const stored = await getEndpoint(scope, slug, {
      specPointer: "/servers/0/url",
      unedited: true,
    })

    expect(edited.specPart).toEqual({
      pointer: "/servers/0/url",
      value: `${api.origin}/api`,
    })
    expect(stored.specPart).toMatchObject({
      value: "https://demo.example.com/api",
    })
    // The tool list is left out so the part has room.
    expect(edited.tools).toBeUndefined()
    expect(edited.toolCount).toBe(2)
  })

  it("answers a part too long to include with its keys, to point further in", async () => {
    const paths = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [
        `/thing${i}`,
        { get: { operationId: `getThing${i}`, description: "x".repeat(100) } },
      ]),
    )
    const { slug } = await approve({
      name: "Things",
      spec: spec({ paths }),
      patches: [fixes()[0]],
    })
    const part = await getEndpoint(scope, slug, { specPointer: "/paths" })

    expect(part.specPart).toMatchObject({
      pointer: "/paths",
      tooLong: true,
      moreKeys: 100,
    })
    expect((part.specPart as { keys: string[] }).keys.slice(0, 2)).toEqual([
      "/thing0",
      "/thing1",
    ])
  })

  it("says how pointers are written when nothing is there", async () => {
    const { slug } = await fromUrl()

    await expect(
      getEndpoint(scope, slug, { specPointer: "/paths//pets" }),
    ).rejects.toThrow(/~1/)
  })
})
