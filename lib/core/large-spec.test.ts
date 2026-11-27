import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import * as yaml from "js-yaml"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { decrypt } from "./crypto"
import { db } from "./db"
import { createEndpoint, readDocument, storedSpec } from "./endpoints"
import { buildGatewayServer } from "./gateway"
import { fetchSpec } from "./openapi/fetch-spec"
import { parseSpecText, forgetPreparedSpecs } from "./openapi/parse"
import { prepareSpecText } from "./openapi/parse"
import { startTestApi } from "./openapi/test-api"
import { decidePermission, getPermissionView } from "./permissions"
import {
  EMPTY_CONFIG,
  forgetResourceLimits,
  resourceLimits,
  useResourceConfig,
} from "./resources/state"
import { convertInline } from "./openapi/yaml-json"
import { sealArgs, openArgs } from "./sealed-args"
import { encrypt } from "./crypto"
import { getServer } from "./servers"
import { openSpec, sealedSpecText, SPEC_SELECT } from "./spec-rows"
import { sealJson } from "./sealed"
import { scratchDatabase } from "./test-db"
import { entryCall } from "./test-handles"
import { setupVault } from "./vault"

// A schema the size of GitHub's REST description (1,278 operations, 14 MB as
// JSON, 11 MB as YAML), made up here rather than kept as a fixture: through
// each way in, within the owner's limit, compressed at rest, and read
// without holding up the rest of PCP (#141).

const PUBLIC_URL = "http://localhost:3000"
const OPERATIONS = 1200

/** A large, GitHub-shaped document: many operations, many schemas. */
function largeSpec(schemas = 450): Record<string, unknown> {
  const paths: Record<string, unknown> = {}

  for (let i = 0; i < OPERATIONS; i++) {
    paths[`/things${i}/{id}`] = {
      get: {
        operationId: `things${i}/get`,
        summary: `Get thing ${i}`,
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    }
  }

  const properties: Record<string, unknown> = {}
  for (let p = 0; p < 150; p++) {
    properties[`property_${p}`] = {
      type: "string",
      description: `What property ${p} of a thing is for, and the rules around it.`,
      example: `example-${p}`,
    }
  }
  const components: Record<string, unknown> = {}
  for (let s = 0; s < schemas; s++) {
    components[`Thing${s}`] = { type: "object", properties }
  }

  return {
    openapi: "3.0.3",
    info: { title: "Large", description: "Many things." },
    servers: [{ url: "https://api.large.example/v1" }],
    paths,
    components: { schemas: components },
  }
}

const LARGE = largeSpec()
const LARGE_JSON = JSON.stringify(LARGE, null, 2)
const LARGE_YAML = yaml.dump(LARGE, { lineWidth: -1, noRefs: true })

let cleanup: () => Promise<void>
let ctx: VaultContext
let client: Client

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
  })
  const scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()

  await buildGatewayServer(scope, []).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  forgetPreparedSpecs()
  forgetResourceLimits()
})

afterEach(async () => {
  await client.close()
  forgetResourceLimits()
  await cleanup()
})

async function register(args: Record<string, unknown>) {
  const result = await client.callTool(entryCall("register_server", args))
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return { isError: result.isError === true, text }
}

async function approveNewest() {
  const row = await db().permissionRequest.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  })
  const view = await getPermissionView(ctx, row.id, { publicUrl: PUBLIC_URL })
  const decided = await decidePermission(
    ctx,
    row.id,
    "allow_once",
    { publicUrl: PUBLIC_URL },
    { syncAfter: false } as never,
  ).catch((error) => error)

  return { row, view: view!, decided }
}

describe("a schema as large as GitHub's REST API", () => {
  it("is of the size the issue is about", () => {
    expect(LARGE_JSON.length).toBeGreaterThan(10 * 1024 * 1024)
    expect(LARGE_YAML.length).toBeGreaterThan(5 * 1024 * 1024)
    expect(resourceLimits().specBytes).toBeGreaterThanOrEqual(16 * 1024 * 1024)
  })

  for (const [label, text] of [
    ["JSON", LARGE_JSON],
    ["YAML", LARGE_YAML],
  ] as const) {
    it(`registers through register_server's openapi_schema as ${label}, with a light permission page`, async () => {
      const asked = await register({
        name: `Large ${label}`,
        openapi_schema: text,
      })

      expect(asked.isError).toBe(false)
      const row = await db().permissionRequest.findFirstOrThrow({
        orderBy: { createdAt: "desc" },
      })
      const view = await getPermissionView(ctx, row.id, {
        publicUrl: PUBLIC_URL,
      })

      // What the owner reads is a preview, not the schema.
      expect(view!.title).toBe(`Add the API endpoint Large ${label}?`)
      expect(JSON.stringify(view).length).toBeLessThan(100_000)
      expect(view!.lines.join("\n")).toMatch(/Tools: 1200 from/)
      // And the request holds it compressed, not at 14 MB.
      expect(row.argsCiphertext.length).toBeLessThan(2 * 1024 * 1024)
    }, 60_000)
  }

  it("is created from the approved copy, kept compressed, and read back whole", async () => {
    await register({ name: "Large", openapi_schema: LARGE_JSON })
    const { decided } = await approveNewest()
    expect(decided).not.toBeInstanceOf(Error)

    const server = await db().mcpServer.findFirstOrThrow({
      where: { kind: "openapi" },
    })
    const row = await db().openApiSpec.findUniqueOrThrow({
      where: { serverId: server.id },
      select: SPEC_SELECT,
    })

    expect(row.sealedText!.length).toBeLessThan(2 * 1024 * 1024)
    expect((await storedSpec(ctx, server.id))!.text).toBe(LARGE_JSON)
    expect(await db().mcpTool.count({ where: { serverId: server.id } })).toBe(
      OPERATIONS,
    )
  }, 60_000)

  it("is refused past the owner's limit, with the limit named", async () => {
    useResourceConfig({ ...EMPTY_CONFIG, specMb: 4 })

    const asked = await register({ name: "Large", openapi_schema: LARGE_JSON })

    expect(asked.isError).toBe(true)
    expect(asked.text).toMatch(/larger than the 4 MB/)
  })

  it("registers by the owner's form path (an upload) and from a URL they typed", async () => {
    const { id } = await createEndpoint(ctx, {
      name: "Uploaded",
      specSource: "upload",
      specText: LARGE_YAML,
      baseUrl: "https://api.large.example/v1",
      readOnly: false,
      authType: "none",
    })
    expect((await storedSpec(ctx, id))!.text).toBe(LARGE_YAML)

    const docs = await startTestApi((_, res) => {
      res.setHeader("content-type", "application/json")
      res.end(LARGE_JSON)
    })

    try {
      const { id: fromUrl } = await createEndpoint(ctx, {
        name: "Downloaded",
        specSource: "url",
        specUrl: `${docs.origin}/openapi.json`,
        baseUrl: "https://api.large.example/v1",
        readOnly: false,
        authType: "none",
        publicOnly: false,
      })
      expect((await storedSpec(ctx, fromUrl))!.text).toBe(LARGE_JSON)
      expect((await getServer(ctx, fromUrl)).specSource).toBe("url")
    } finally {
      await docs.close()
    }
  }, 90_000)
})

describe("the owner's limit on a schema", () => {
  it("stops a download at the limit, by its declared size and by what arrives", async () => {
    useResourceConfig({ ...EMPTY_CONFIG, specMb: 1 })
    const declared = await startTestApi((_, res) => {
      res.setHeader("content-type", "application/json")
      res.end("x".repeat(3 * 1024 * 1024))
    })
    const streamed = await startTestApi((_, res) => {
      res.setHeader("content-type", "application/json")
      res.setHeader("transfer-encoding", "chunked")
      res.write("x".repeat(1024 * 1024))
      res.write("x".repeat(1024 * 1024))
      res.end("x")
    })

    try {
      for (const server of [declared, streamed]) {
        await expect(fetchSpec(`${server.origin}/spec`)).rejects.toThrow(
          /larger than 1 MB/,
        )
      }
    } finally {
      await declared.close()
      await streamed.close()
    }
  })

  it("follows the machine's memory, and a text over it is refused before anything parses it", async () => {
    useResourceConfig({ ...EMPTY_CONFIG, specMb: 2 })
    await expect(prepareSpecText("a".repeat(3 * 1024 * 1024))).rejects.toThrow(
      /larger than 2 MB/,
    )
    expect(() => parseSpecText("a".repeat(3 * 1024 * 1024))).toThrow(
      /larger than 2 MB/,
    )
  })

  it("refuses an alias bomb in a worker, and a worker never sees what it is not given", async () => {
    const lines = [
      'a0: &a0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
    ]
    for (let i = 1; i < 14; i++) {
      lines.push(
        `a${i}: &a${i} [${Array(9)
          .fill(`*a${i - 1}`)
          .join(",")}]`,
      )
    }

    await expect(
      prepareSpecText(`openapi: 3.0.0\npaths: {}\nx:\n  ${lines.join("\n  ")}`),
    ).rejects.toThrow(/too large once its anchors/)
  })
})

describe("reading YAML off the main thread", () => {
  it("leaves the event loop free while a large schema is read, and the parse takes what was made", async () => {
    // What reading it in place costs, for comparison.
    const inline = performance.now()
    const direct = convertInline(LARGE_YAML, 10_000_000)
    const inlineMs = performance.now() - inline

    forgetPreparedSpecs()
    let longest = 0
    let last = performance.now()
    const tick = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 5)

    try {
      await prepareSpecText(LARGE_YAML)
    } finally {
      clearInterval(tick)
    }

    // Reading it here would have held everything for inlineMs; the thread
    // that reads it leaves the loop to turn within a fraction of that.
    expect(inlineMs).toBeGreaterThan(50)
    expect(longest).toBeLessThan(Math.max(80, inlineMs / 2))

    // The parse that follows takes the JSON the worker made.
    const started = performance.now()
    const doc = parseSpecText(LARGE_YAML)
    expect(performance.now() - started).toBeLessThan(inlineMs)
    expect(JSON.stringify(doc)).toBe(JSON.stringify(JSON.parse(direct)))
    expect(Object.keys(doc.paths)).toHaveLength(OPERATIONS)
  }, 60_000)

  it("reads the same as the worker does, in place, for what the worker's file would not be found for", () => {
    const small = "openapi: 3.0.0\npaths:\n  /a: {}\nx-n: 1.5\nx-t: true\n"
    expect(JSON.parse(convertInline(small, 1000))).toEqual({
      openapi: "3.0.0",
      paths: { "/a": {} },
      "x-n": 1.5,
      "x-t": true,
    })
  })
})

describe("a schema at rest", () => {
  it("is kept compressed above 64 KB, and a row from before still opens", () => {
    const small = '{"openapi":"3.0.0","paths":{}}'
    const sealedSmall = sealedSpecText(ctx, "srv1", small)
    expect(
      openSpec(ctx, {
        serverId: "srv1",
        plainPatches: "",
        sealedPatches: null,
        ...sealedSmall,
      }).text,
    ).toBe(small)

    const packed = sealedSpecText(ctx, "srv2", LARGE_JSON)
    expect(packed.sealedText.length).toBeLessThan(LARGE_JSON.length / 10)
    expect(
      openSpec(ctx, {
        serverId: "srv2",
        plainPatches: "",
        sealedPatches: null,
        ...packed,
      }),
    ).toMatchObject({ text: LARGE_JSON, hash: packed.hash })

    // A row sealed before there was a packed value: only `text` in its JSON.
    const before = sealJson(ctx.dek, "openapi_spec:srv3:sealedText", {
      text: LARGE_JSON,
    })
    expect(
      openSpec(ctx, {
        serverId: "srv3",
        plainPatches: "",
        sealedPatches: null,
        plainText: "",
        sealedText: before,
        hash: "h",
      }).text,
    ).toBe(LARGE_JSON)

    // And one from before it was sealed at all.
    expect(
      openSpec(ctx, {
        serverId: "srv4",
        plainPatches: "",
        sealedPatches: null,
        plainText: small,
        sealedText: null,
        hash: "",
      }).text,
    ).toBe(small)
  })

  it("keeps a request's arguments compressed from 64 KB, and opens plain ones from before", () => {
    const aad = "permission_request:r1"
    const small = { name: "Pets" }
    const big = { endpoint: { spec: LARGE_JSON } }

    expect(openArgs(ctx.dek, sealArgs(ctx.dek, small, aad), aad)).toEqual(small)
    const sealedBig = sealArgs(ctx.dek, big, aad)
    expect(sealedBig.length).toBeLessThan(LARGE_JSON.length / 10)
    expect(openArgs(ctx.dek, sealedBig, aad)).toEqual(big)
    // Plain JSON, as every request was written before.
    expect(
      openArgs(
        ctx.dek,
        encrypt(ctx.dek, Buffer.from(JSON.stringify(small)), aad),
        aad,
      ),
    ).toEqual(small)
    // Wrong row: refused.
    expect(() =>
      openArgs(ctx.dek, sealedBig, "permission_request:r2"),
    ).toThrow()
    expect(decrypt(ctx.dek, sealedBig, aad)[0]).toBe(0)
  })
})

describe("edits on a large schema", () => {
  it("apply in reasonable time and leave the text alone", () => {
    const started = performance.now()
    const doc = readDocument(LARGE_JSON, [
      { op: "remove", path: "/paths/~1things5~1{id}" },
      { op: "replace", path: "/info/title", value: "Edited" },
      {
        op: "add",
        path: "/components/schemas/Added",
        value: { type: "string" },
      },
    ])

    expect(performance.now() - started).toBeLessThan(5000)
    expect(Object.keys(doc.paths)).toHaveLength(OPERATIONS - 1)
    expect((doc.info as { title: string }).title).toBe("Edited")
    // The next read is the schema as stored.
    expect(Object.keys(readDocument(LARGE_JSON, []).paths)).toHaveLength(
      OPERATIONS,
    )
  })
})

describe("what the worker refuses stays refused", () => {
  it("is refused again by a later parse of the same text, not read in place", async () => {
    const lines = [
      'a0: &a0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
    ]
    for (let i = 1; i < 14; i++) {
      lines.push(
        `a${i}: &a${i} [${Array(9)
          .fill(`*a${i - 1}`)
          .join(",")}]`,
      )
    }
    const bomb = `openapi: 3.0.0\npaths: {}\nx:\n  ${lines.join("\n  ")}`

    await expect(prepareSpecText(bomb)).rejects.toThrow(/too large/)
    const started = performance.now()
    expect(() => parseSpecText(bomb)).toThrow(/too large/)
    expect(performance.now() - started).toBeLessThan(20)
  })

  it("surfaces a stored schema the owner's lowered limit no longer allows", async () => {
    const { id } = await createEndpoint(ctx, {
      name: "Uploaded",
      specSource: "upload",
      specText: LARGE_YAML,
      baseUrl: "https://api.large.example/v1",
      readOnly: false,
      authType: "none",
    })
    useResourceConfig({ ...EMPTY_CONFIG, specMb: 1 })

    await expect(storedSpec(ctx, id)).rejects.toThrow(/larger than 1 MB/)
  }, 60_000)
})
