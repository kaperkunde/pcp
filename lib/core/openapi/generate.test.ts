import { describe, expect, it } from "vitest"

import { generateTools, resolveBaseUrl } from "./generate"
import { parseSpecText, type OpenApiDocument } from "./parse"

function spec(extra: Record<string, unknown> = {}): OpenApiDocument {
  return parseSpecText(
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Petstore", description: "Pets for sale.", version: "1" },
      servers: [{ url: "https://pets.example.com/v1" }],
      paths: {},
      ...extra,
    }),
  )
}

const OPTIONS = { readOnly: false, blockedHeaders: [] as string[] }

const PETSTORE = spec({
  components: {
    parameters: {
      Limit: {
        name: "limit",
        in: "query",
        schema: { type: "integer", maximum: 100 },
      },
    },
    schemas: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          id: { type: "integer", readOnly: true },
          name: { type: "string" },
        },
      },
    },
  },
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets",
        parameters: [
          { $ref: "#/components/parameters/Limit" },
          {
            name: "status",
            in: "query",
            schema: { type: "array", items: { type: "string" } },
          },
        ],
        responses: {
          "200": {
            description: "A list of pets",
            content: { "application/json": { schema: { type: "array" } } },
          },
        },
      },
      post: {
        operationId: "createPet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
        },
        responses: { "201": { description: "Created" } },
      },
    },
    "/pets/{petId}": {
      parameters: [
        {
          name: "petId",
          in: "path",
          required: true,
          schema: { type: "integer" },
        },
      ],
      get: {
        operationId: "getPet",
        responses: { "200": { description: "ok" } },
      },
      delete: {
        operationId: "deletePet",
        responses: { "204": { description: "gone" } },
      },
    },
    "/pets/{petId}/photo": {
      post: {
        operationId: "uploadPhoto",
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        requestBody: {
          required: true,
          content: { "multipart/form-data": { schema: { type: "object" } } },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/session": {
      get: {
        operationId: "session",
        parameters: [
          {
            name: "sid",
            in: "cookie",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
  },
})

describe("generateTools", () => {
  const generated = generateTools(PETSTORE, OPTIONS)
  const byName = Object.fromEntries(
    generated.tools.map((tool) => [tool.name, tool]),
  )

  it("makes a tool per operation it can send, and says what it left out", () => {
    expect(generated.tools.map((tool) => tool.name)).toEqual([
      "listPets",
      "createPet",
      "getPet",
      "deletePet",
    ])
    expect(generated.skipped).toEqual([
      {
        operation: "POST /pets/{petId}/photo",
        reason: "it needs a file upload",
      },
      { operation: "GET /session", reason: "it needs a cookie" },
    ])
    expect(generated.title).toBe("Petstore")
    expect(generated.description).toBe("Pets for sale.")
  })

  it("builds the argument schema from parameters, references and the body", () => {
    expect(byName.listPets!.inputSchema).toEqual({
      type: "object",
      properties: {
        limit: { type: "integer", maximum: 100 },
        status: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    })
    // readOnly id is left out of what a request carries.
    expect(byName.createPet!.inputSchema).toMatchObject({
      required: ["body"],
      properties: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
      },
    })
    // The path item's own parameter applies to both of its operations.
    expect(byName.getPet!.inputSchema).toMatchObject({
      required: ["petId"],
      properties: { petId: { type: "integer" } },
    })
    expect(byName.deletePet!.operation.params).toHaveLength(1)
  })

  it("stores a call plan the executor can follow", () => {
    expect(byName.listPets!.operation).toEqual({
      v: 1,
      method: "GET",
      path: "/pets",
      params: [
        {
          arg: "limit",
          name: "limit",
          in: "query",
          required: false,
          style: "form",
          explode: true,
        },
        {
          arg: "status",
          name: "status",
          in: "query",
          required: false,
          style: "form",
          explode: true,
        },
      ],
      body: null,
      accept: "application/json, */*;q=0.8",
    })
    expect(byName.createPet!.operation.body).toEqual({
      arg: "body",
      contentType: "application/json",
      encoding: "json",
      required: true,
    })
  })

  it("annotates by method", () => {
    expect(byName.listPets!.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
      title: "List pets",
    })
    expect(byName.deletePet!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    })
    expect(byName.createPet!.annotations.destructiveHint).toBeUndefined()
    expect(byName.createPet!.annotations.idempotentHint).toBeUndefined()
  })

  it("describes the operation, ending with its method and path", () => {
    expect(byName.listPets!.description).toBe(
      "List pets\n\nGET /pets\nReturns: A list of pets",
    )
  })

  it("offers only GET operations when read-only", () => {
    const readOnly = generateTools(PETSTORE, { ...OPTIONS, readOnly: true })
    expect(readOnly.tools.map((tool) => tool.name)).toEqual([
      "listPets",
      "getPet",
    ])
  })
})

describe("tool names", () => {
  it("sanitizes operationIds, falls back to method and path, and de-duplicates", () => {
    const doc = spec({
      paths: {
        "/a": { get: { operationId: "get.the thing!" } },
        "/b/{id}": {
          get: {
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
        "/c": { get: { operationId: "dup" }, post: { operationId: "dup" } },
        "/": { get: {} },
      },
    })
    const names = generateTools(doc, OPTIONS).tools.map((tool) => tool.name)
    expect(names).toEqual([
      "get_the_thing",
      "get_b_by_id",
      "dup",
      "dup_2",
      "get_root",
    ])
  })

  it("keeps a long name within 64 characters, even with a suffix", () => {
    const long = "x".repeat(80)
    const doc = spec({
      paths: {
        "/a": { get: { operationId: long }, post: { operationId: long } },
      },
    })
    const names = generateTools(doc, OPTIONS).tools.map((tool) => tool.name)
    expect(names.map((name) => name.length)).toEqual([64, 64])
    expect(new Set(names).size).toBe(2)
  })
})

describe("unsupported features", () => {
  const one = (operation: Record<string, unknown>, options = OPTIONS) =>
    generateTools(
      spec({ paths: { "/x": { post: { operationId: "op", ...operation } } } }),
      options,
    )

  it("drops an optional cookie and a blocked header; skips a required cookie", () => {
    const optional = one({
      parameters: [
        { name: "sid", in: "cookie", schema: { type: "string" } },
        { name: "Host", in: "header", schema: { type: "string" } },
        { name: "X-Trace", in: "header", schema: { type: "string" } },
        { name: "X-Api-Key", in: "header", schema: { type: "string" } },
      ],
    })
    const plan = optional.tools[0]!.operation
    expect(plan.params.map((param) => param.name)).toEqual([
      "X-Trace",
      "X-Api-Key",
    ])

    // The endpoint's own credential header cannot be an argument either.
    const withAuth = one(
      { parameters: [{ name: "X-Api-Key", in: "header", schema: {} }] },
      { readOnly: false, blockedHeaders: ["x-api-key"] },
    )
    expect(withAuth.tools[0]!.operation.params).toEqual([])
  })

  it("drops an optional body it cannot encode, and skips a required one", () => {
    const optional = one({
      requestBody: { content: { "multipart/form-data": { schema: {} } } },
    })
    expect(optional.tools[0]!.operation.body).toBeNull()

    const required = one({
      requestBody: {
        required: true,
        content: { "application/octet-stream": { schema: {} } },
      },
    })
    expect(required.tools).toEqual([])
    expect(required.skipped[0]!.reason).toBe("it needs a file upload")
  })

  it("skips an operation with its own server, and one with an external reference", () => {
    const own = one({ servers: [{ url: "https://other.example.com" }] })
    expect(own.skipped[0]!.reason).toBe("it uses a server of its own")

    const external = one({
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "https://evil.example/schema.json" },
          },
        },
      },
    })
    expect(external.tools).toEqual([])
    expect(external.skipped[0]!.reason).toMatch(/another document/)
  })

  it("skips a path placeholder with no parameter", () => {
    const doc = spec({ paths: { "/x/{id}": { get: { operationId: "g" } } } })
    expect(generateTools(doc, OPTIONS).skipped[0]!.reason).toMatch(/\{id\}/)
  })

  it("prefers JSON bodies, then forms, then text", () => {
    const pick = (content: Record<string, unknown>) =>
      one({ requestBody: { required: true, content } }).tools[0]?.operation.body
    expect(
      pick({
        "text/plain": {},
        "application/x-www-form-urlencoded": { schema: { type: "object" } },
        "application/vnd.api+json": { schema: { type: "object" } },
      }),
    ).toMatchObject({
      encoding: "json",
      contentType: "application/vnd.api+json",
    })
    expect(
      pick({ "text/plain": {}, "application/x-www-form-urlencoded": {} }),
    ).toMatchObject({ encoding: "form" })
    expect(pick({ "text/plain": {} })).toMatchObject({ encoding: "text" })
  })

  it("names the body requestBody when a parameter is already called body", () => {
    const op = one({
      parameters: [{ name: "body", in: "query", schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      },
    }).tools[0]!
    expect(
      Object.keys((op.inputSchema as { properties: object }).properties),
    ).toEqual(["body", "requestBody"])
    expect(op.operation.body!.arg).toBe("requestBody")
  })

  it("refuses a schema with too many operations", () => {
    const paths = Object.fromEntries(
      Array.from({ length: 2001 }, (_, i) => [`/p${i}`, { get: {} }]),
    )
    expect(() => generateTools(spec({ paths }), OPTIONS)).toThrow(
      /more than 2000/,
    )
  })

  it("ignores a __proto__ path or method", () => {
    const doc = parseSpecText(
      '{"openapi":"3.0.0","paths":{"__proto__":{"get":{}},"/ok":{"get":{}}}}',
    )
    expect(generateTools(doc, OPTIONS).tools.map((tool) => tool.name)).toEqual([
      "get_ok",
    ])
  })
})

describe("what the schema says about credentials", () => {
  it("describes a header key, a bearer token and an unsupported query key", () => {
    const schemes = {
      components: {
        securitySchemes: {
          key: { type: "apiKey", in: "header", name: "X-API-Key" },
          bearer: { type: "http", scheme: "bearer" },
          query: { type: "apiKey", in: "query", name: "k" },
        },
      },
    }
    expect(
      generateTools(spec({ ...schemes, security: [{ key: [] }] }), OPTIONS)
        .security,
    ).toBe("a key in the X-API-Key header")
    expect(
      generateTools(spec({ ...schemes, security: [{ bearer: [] }] }), OPTIONS)
        .security,
    ).toBe("a bearer token")
    expect(
      generateTools(spec({ ...schemes, security: [{ query: [] }] }), OPTIONS)
        .security,
    ).toMatch(/query string, which PCP does not send/)
    expect(generateTools(spec(), OPTIONS).security).toBeNull()
  })
})

describe("resolveBaseUrl", () => {
  const base = {
    ownerBaseUrl: null,
    serverUrl: "https://pets.example.com/v1",
    serverUrlProblem: null,
    specUrl: null,
    fetchedFrom: null,
    hasSecret: false,
  }

  it("prefers the owner's address and tidies it", () => {
    expect(
      resolveBaseUrl({ ...base, ownerBaseUrl: "https://api.example.org/v2/" }),
    ).toBe("https://api.example.org/v2")
    expect(() =>
      resolveBaseUrl({ ...base, ownerBaseUrl: "https://u:p@x.test/" }),
    ).toThrow(/user name/)
    expect(() =>
      resolveBaseUrl({ ...base, ownerBaseUrl: "https://x.test/?a=1" }),
    ).toThrow(/query/)
    expect(() =>
      resolveBaseUrl({ ...base, ownerBaseUrl: "ftp://x.test" }),
    ).toThrow(/https/)
  })

  it("uses the schema's server, resolving a relative one against the download", () => {
    expect(resolveBaseUrl(base)).toBe("https://pets.example.com/v1")
    expect(
      resolveBaseUrl({
        ...base,
        serverUrl: "/api",
        specUrl: "https://docs.example.com/openapi.json",
        fetchedFrom: "https://docs.example.com/openapi.json",
      }),
    ).toBe("https://docs.example.com/api")
  })

  it("asks for an address when an uploaded schema gives only a relative one", () => {
    expect(() => resolveBaseUrl({ ...base, serverUrl: "/api" })).toThrow(
      /Enter the base URL/,
    )
    expect(() => resolveBaseUrl({ ...base, serverUrl: null })).toThrow(
      /does not say/,
    )
    expect(() =>
      resolveBaseUrl({
        ...base,
        serverUrl: null,
        serverUrlProblem: "A variable has no default.",
      }),
    ).toThrow(/no default/)
  })

  it("does not let a downloaded schema aim a secret at another origin", () => {
    const downloaded = {
      ...base,
      specUrl: "https://docs.example.com/openapi.json",
      fetchedFrom: "https://docs.example.com/openapi.json",
    }
    // No secret: fine. With one: the owner must type the address.
    expect(resolveBaseUrl(downloaded)).toBe("https://pets.example.com/v1")
    expect(() => resolveBaseUrl({ ...downloaded, hasSecret: true })).toThrow(
      /pets\.example\.com, not where it was downloaded from/,
    )
    expect(
      resolveBaseUrl({
        ...downloaded,
        hasSecret: true,
        ownerBaseUrl: "https://pets.example.com/v1",
      }),
    ).toBe("https://pets.example.com/v1")
    // Same origin is fine with a secret.
    expect(
      resolveBaseUrl({
        ...downloaded,
        hasSecret: true,
        serverUrl: "https://docs.example.com/api",
      }),
    ).toBe("https://docs.example.com/api")
  })
})

describe("server variables", () => {
  it("fills them with their defaults, and reports one without", () => {
    const filled = generateTools(
      spec({
        servers: [
          {
            url: "https://{region}.example.com/{base}",
            variables: { region: { default: "eu" }, base: { default: "v3" } },
          },
        ],
      }),
      OPTIONS,
    )
    expect(filled.serverUrl).toBe("https://eu.example.com/v3")

    const missing = generateTools(
      spec({ servers: [{ url: "https://{tenant}.example.com" }] }),
      OPTIONS,
    )
    expect(missing.serverUrl).toBeNull()
    expect(missing.serverUrlProblem).toMatch(/tenant/)
  })
})

describe("literal paths from a schema someone else wrote", () => {
  const skippedFor = (path: string) =>
    generateTools(
      spec({ paths: { [path]: { get: { operationId: "op" } } } }),
      OPTIONS,
    )

  it("skips the ones that mean something else to some servers", () => {
    for (const path of [
      "/a/../b",
      "/a/./b",
      "/..",
      "/a/%2e%2e/b",
      "/a/%2E/b",
      "/a%2fb",
      "/a%5Cb",
      "/a%3bb",
      "/a%00b",
      "/a;/..;/b",
      "/a\\b",
      "/a?b=1",
      "/a#b",
      "/a\u0001b",
    ]) {
      const result = skippedFor(path)
      expect(result.tools, path).toEqual([])
      expect(result.skipped[0]!.reason, path).toMatch(/its path has/)
    }
  })

  it("keeps ordinary paths, dots in names, and placeholders", () => {
    for (const path of [
      "/v1.0/pets",
      "/pets.json",
      "/a-b_c/~d",
      "/pets/{petId}.json",
    ]) {
      const doc = spec({
        paths: {
          [path]: {
            get: {
              operationId: "op",
              parameters: [
                {
                  name: "petId",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
            },
          },
        },
      })
      expect(generateTools(doc, OPTIONS).tools, path).toHaveLength(1)
    }
  })
})

describe("the budget for the whole schema", () => {
  it("stops reading references across operations, not only within one", () => {
    // Each operation inlines a schema of about 2,000 nodes, well inside the
    // per-operation budget; a thousand of them are not.
    const big = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 900 }, (_, i) => [`p${i}`, { type: "string" }]),
      ),
    }
    const paths = Object.fromEntries(
      Array.from({ length: 1500 }, (_, i) => [
        `/p${i}`,
        {
          post: {
            operationId: `op${i}`,
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Big" },
                },
              },
            },
          },
        },
      ]),
    )
    const started = Date.now()
    const result = generateTools(
      spec({ paths, components: { schemas: { Big: big } } }),
      OPTIONS,
    )

    expect(result.tools.length).toBeGreaterThan(100)
    expect(result.tools.length).toBeLessThan(1500)
    expect(result.skipped.at(-1)!.reason).toBe(
      "the schema is larger than PCP reads in full",
    )
    expect(Date.now() - started).toBeLessThan(8000)
  })
})
