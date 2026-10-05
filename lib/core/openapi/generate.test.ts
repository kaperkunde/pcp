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

  it("does not say the summary or the method and path twice", () => {
    const { tools } = generateTools(
      spec({
        paths: {
          "/invoices": {
            get: {
              operationId: "getInvoices",
              summary: "List invoices",
              description:
                "## GET /api/v1/invoices\n\n## GET /invoices\n\nLists invoices, filtered.",
            },
            post: {
              operationId: "createInvoice",
              summary: "Create an invoice",
              description: "Create an invoice. The body is the invoice.",
            },
          },
        },
      }),
      OPTIONS,
    )

    expect(tools.map((tool) => tool.description)).toEqual([
      // Another path's heading stays: it is not this one.
      "List invoices\n\n## GET /api/v1/invoices\n\nLists invoices, filtered.\n\nGET /invoices",
      "Create an invoice. The body is the invoice.\n\nPOST /invoices",
    ])
  })

  it("outlines what a successful call answers", () => {
    expect(byName.listPets!.output).toBe("[any]")
    expect(byName.deletePet!.output).toBeNull()

    const { tools } = generateTools(
      spec({
        components: {
          schemas: {
            Invoice: {
              allOf: [
                { $ref: "#/components/schemas/Base" },
                {
                  type: "object",
                  properties: {
                    number: { type: "string" },
                    status: { type: "string", enum: ["draft", "paid"] },
                    lines: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Line" },
                    },
                  },
                },
              ],
            },
            Base: { type: "object", properties: { id: { type: "string" } } },
            Line: {
              type: "object",
              properties: {
                cost: { type: "number" },
                // Text the API encodes is marked as such.
                image: { type: "string", format: "byte" },
                // A reference back into itself stops.
                parent: { $ref: "#/components/schemas/Line" },
              },
            },
          },
        },
        paths: {
          "/invoices": {
            get: {
              operationId: "getInvoices",
              responses: {
                "401": { description: "no" },
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          data: {
                            type: "array",
                            items: { $ref: "#/components/schemas/Invoice" },
                          },
                          meta: { $ref: "#/components/schemas/Missing" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      OPTIONS,
    )

    expect(tools[0]!.output).toBe(
      '{data: [{id: string, number: string, status: "draft" | "paid", lines: [{cost: number, image: string (base64), parent: {…}}]}], meta: {…}}',
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

  it("sends a parameter that can take one value itself, instead of asking for it", () => {
    const { tools } = one({
      parameters: [
        // Required, one value: PCP sends it.
        {
          name: "X-Requested-With",
          in: "header",
          required: true,
          schema: { type: "string", enum: ["XMLHttpRequest"] },
        },
        // Optional, defaulting to its one value: PCP sends it.
        {
          name: "format",
          in: "query",
          schema: { type: "string", const: "json", default: "json" },
        },
        // Optional without a default: leaving it out may mean something.
        {
          name: "only",
          in: "query",
          schema: { type: "string", enum: ["mine"] },
        },
        // A value that cannot be sent as a header stays an argument.
        {
          name: "X-Odd",
          in: "header",
          required: true,
          schema: { type: "string", enum: ["a\nb"] },
        },
      ],
    })
    const tool = tools[0]!

    expect(Object.keys(tool.inputSchema.properties as object)).toEqual([
      "only",
      "X-Odd",
    ])
    expect(tool.inputSchema.required).toEqual(["X-Odd"])
    expect(
      tool.operation.params
        .filter((param) => param.value !== undefined)
        .map((param) => [param.name, param.value]),
    ).toEqual([
      ["format", "json"],
      ["X-Requested-With", "XMLHttpRequest"],
    ])
  })

  it("drops an optional body it cannot encode, and skips a required one", () => {
    const optional = one({
      requestBody: { content: { "multipart/form-data": { schema: {} } } },
    })
    expect(optional.tools[0]!.operation.body).toBeNull()

    // multipart that names no file field: nothing PCP can upload.
    const required = one({
      requestBody: {
        required: true,
        content: { "multipart/form-data": { schema: { type: "object" } } },
      },
    })
    expect(required.tools).toEqual([])
    expect(required.skipped[0]!.reason).toBe("it needs a file upload")
  })

  it("takes a binary body as one kept file", () => {
    const { tools } = one({
      requestBody: {
        required: true,
        content: {
          "application/pdf": { schema: { type: "string", format: "binary" } },
        },
      },
    })

    expect(tools[0]!.operation.body).toEqual({
      arg: "body",
      contentType: "application/pdf",
      encoding: "binary",
      required: true,
    })
    expect(
      (tools[0]!.inputSchema.properties as Record<string, unknown>).body,
    ).toMatchObject({
      type: "object",
      required: ["$result"],
      additionalProperties: false,
    })
  })

  it("takes multipart with file fields, a file or a list, beside its other fields", () => {
    const { tools } = one({
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["photo"],
              properties: {
                caption: { type: "string" },
                photo: { type: "string", format: "binary" },
                extras: {
                  type: "array",
                  items: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
      },
    })
    const body = (tools[0]!.inputSchema.properties as Record<string, unknown>)
      .body as {
      properties: Record<string, { type?: string; required?: string[] }>
      required: string[]
    }

    expect(tools[0]!.operation.body).toMatchObject({
      contentType: "multipart/form-data",
      encoding: "multipart",
      files: [
        { name: "photo", many: false },
        { name: "extras", many: true },
      ],
    })
    expect(body.required).toEqual(["photo"])
    expect(body.properties.caption).toEqual({ type: "string" })
    expect(body.properties.photo!.required).toEqual(["$result"])
    expect(body.properties.extras!.type).toBe("array")
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

  it("names every header of a requirement that combines several keys", () => {
    const schemes = {
      components: {
        securitySchemes: {
          key: { type: "apiKey", in: "header", name: "X-API-Key" },
          secret: { type: "apiKey", in: "header", name: "X-Secret-API-Key" },
          bearer: { type: "http", scheme: "bearer" },
        },
      },
    }
    const both = generateTools(
      spec({ ...schemes, security: [{ key: [], secret: [] }] }),
      OPTIONS,
    )

    expect(both.security).toBe(
      "a key in the X-API-Key header and a key in the X-Secret-API-Key header",
    )
    expect(both.securityHeaders).toEqual(["X-API-Key", "X-Secret-API-Key"])
    expect(
      generateTools(spec({ ...schemes, security: [{ bearer: [] }] }), OPTIONS)
        .securityHeaders,
    ).toEqual([])
    expect(generateTools(spec(), OPTIONS).securityHeaders).toEqual([])
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

  it("does not let a file aim a secret at the address it names", () => {
    const file = { ...base, specUrl: null, fetchedFrom: null, hasSecret: true }

    // A file has no origin to compare with, so the owner has to say.
    expect(() => resolveBaseUrl(file)).toThrow(
      /pets\.example\.com as its server\. To send your secret there, enter the base URL/,
    )
    expect(
      resolveBaseUrl({ ...file, ownerBaseUrl: "https://pets.example.com/v1" }),
    ).toBe("https://pets.example.com/v1")
    // Without a secret nothing of the owner's is at stake.
    expect(resolveBaseUrl({ ...file, hasSecret: false })).toBe(
      "https://pets.example.com/v1",
    )
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

describe("a schema written to be expensive to read", () => {
  const FAST = 2000

  function timed<T>(run: () => T): { result: T; ms: number } {
    const started = Date.now()
    const result = run()
    return { result, ms: Date.now() - started }
  }

  it("skips a path too long to read, before any pattern runs on it", () => {
    const path = `/${"{".repeat(60_000)}`
    const { result, ms } = timed(() =>
      generateTools(spec({ paths: { [path]: { get: {} } } }), OPTIONS),
    )

    expect(result.tools).toEqual([])
    expect(result.skipped[0]!.reason).toMatch(/longer than PCP reads/)
    // 2 seconds for 50 KB of braces, 8 for 100 KB, before the cap.
    expect(ms).toBeLessThan(FAST)
  })

  it("cuts an operationId before it is tidied, and still names the tool", () => {
    const operationId = `a${"-".repeat(160_000)}b`
    const { result, ms } = timed(() =>
      generateTools(
        spec({ paths: { "/a": { get: { operationId } } } }),
        OPTIONS,
      ),
    )

    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]!.name.length).toBeLessThanOrEqual(64)
    expect(ms).toBeLessThan(FAST)
  })

  it("does not expand a server address made of braces", () => {
    const { result, ms } = timed(() =>
      generateTools(
        spec({ servers: [{ url: `https://x${"{".repeat(80_000)}` }] }),
        OPTIONS,
      ),
    )

    expect(result.serverUrl).toBeNull()
    expect(result.serverUrlProblem).toMatch(/too long/)
    expect(ms).toBeLessThan(FAST)
  })

  it("does not copy a huge shared parameter, or a huge summary, into every tool", () => {
    // About 4.5 MB of schema: one 900 KB description and example shared by
    // 600 operations through a $ref, and one operation with 900 KB of
    // summary, description and tag. Copied into each tool, that is gigabytes.
    const huge = "x".repeat(900_000)
    const paths = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [
        `/p${i}`,
        {
          get: {
            operationId: `op${i}`,
            ...(i === 0
              ? { summary: huge, description: huge, tags: [huge] }
              : {}),
            parameters: [{ $ref: "#/components/parameters/Big" }],
          },
        },
      ]),
    )
    const { result, ms } = timed(() =>
      generateTools(
        spec({
          paths,
          components: {
            parameters: {
              Big: {
                name: "q",
                in: "query",
                description: huge,
                example: huge,
                schema: { type: "string" },
              },
            },
          },
        }),
        OPTIONS,
      ),
    )

    expect(result.tools).toHaveLength(600)
    for (const tool of result.tools.slice(0, 3)) {
      expect(tool.description.length).toBeLessThanOrEqual(2000)
      const parameter = (tool.inputSchema as { properties: { q: object } })
        .properties.q as { description: string; examples?: unknown }
      expect(parameter.description.length).toBeLessThanOrEqual(1000)
      expect(parameter.examples).toBeUndefined()
    }
    expect(ms).toBeLessThan(FAST * 2)
  })

  it("skips an operation whose request schema carries more text than PCP passes on", () => {
    const doc = spec({
      paths: {
        "/a": {
          post: {
            operationId: "big",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "string", description: "d".repeat(100_000) },
                },
              },
            },
          },
        },
      },
    })
    const result = generateTools(doc, OPTIONS)

    expect(result.tools).toEqual([])
    expect(result.skipped[0]!.reason).toMatch(/expands to more than PCP reads/)
  })

  it("skips an operation with too many parameters, and one with a huge parameter name", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      name: `p${i}`,
      in: "query",
      schema: { type: "string" },
    }))
    const long = [{ name: "n".repeat(300), in: "query", schema: {} }]
    const result = generateTools(
      spec({
        paths: {
          "/many": { get: { operationId: "many", parameters: many } },
          "/long": { get: { operationId: "long", parameters: long } },
        },
      }),
      OPTIONS,
    )

    expect(result.tools).toEqual([])
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      "it has more than 200 parameters",
      "a parameter's name is too long",
    ])
  })

  it("does not take a media type that cannot be sent as a header", () => {
    const doc = spec({
      paths: {
        "/a": {
          post: {
            operationId: "post",
            requestBody: {
              required: true,
              content: {
                "application/json; x=\r\nX-Evil: 1": {
                  schema: { type: "object" },
                },
              },
            },
            responses: {
              "200": {
                description: "ok",
                content: { "application/json;\nX-Evil: 1": { schema: {} } },
              },
            },
          },
          get: {
            operationId: "get",
            responses: {
              "200": {
                description: "ok",
                content: { "application/json;\nX-Evil: 1": { schema: {} } },
              },
            },
          },
        },
      },
    })
    const result = generateTools(doc, OPTIONS)
    const get = result.tools.find((tool) => tool.name === "get")!

    // The required body had no usable type; the answer type is ignored.
    expect(result.tools.map((tool) => tool.name)).toEqual(["get"])
    expect(get.operation.accept).toBe("application/json, */*;q=0.8")
  })
})

describe("what one endpoint's tools may add up to", () => {
  it("stops storing tools past the limit, and says so", () => {
    // Each operation takes a 700-property request body: about 15 KB of tool
    // schema. 300 of them are 4.6 MB, past the 4 MB an endpoint may hold.
    const mid = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 700 }, (_, i) => [`p${i}`, { type: "string" }]),
      ),
    }
    const paths = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [
        `/p${i}`,
        {
          post: {
            operationId: `op${i}`,
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Mid" },
                },
              },
            },
          },
        },
      ]),
    )
    const result = generateTools(
      spec({ paths, components: { schemas: { Mid: mid } } }),
      OPTIONS,
    )

    expect(result.tools.length).toBeGreaterThan(150)
    expect(result.tools.length).toBeLessThan(300)
    expect(result.skipped.at(-1)!.reason).toBe(
      "the tools are larger than PCP stores for one endpoint",
    )
    const bytes = result.tools.reduce(
      (sum, tool) => sum + JSON.stringify(tool.inputSchema).length,
      0,
    )
    expect(bytes).toBeLessThanOrEqual(4_000_000)
  })
})
