import { describe, expect, it } from "vitest"

import { generateTools } from "./generate"
import { lintDocument } from "./lint"
import { applyPatches } from "./patch"
import { checkDocument, parseSpecText } from "./parse"

const doc = parseSpecText(
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Invoices" },
    servers: [{ url: "https://pay.example.com" }],
    components: {
      parameters: {
        status: {
          name: "status",
          in: "query",
          schema: { type: "string" },
          example: "?status=archived,deleted",
        },
        client_id: {
          name: "client_id",
          in: "query",
          schema: { type: "string" },
          example: "?client_id={client_id}",
        },
        "X-Requested-With": {
          name: "X-Requested-With",
          in: "header",
          required: true,
          schema: { type: "string" },
          example: "XMLHttpRequest",
        },
        "X-API-PASSWORD": {
          name: "X-API-PASSWORD",
          in: "header",
          required: true,
          schema: { type: "string" },
          example: "supersecretpassword",
        },
        "X-Api-Token": {
          name: "X-Api-Token",
          in: "header",
          required: true,
          schema: { type: "string" },
          example: "TOKEN",
        },
      },
    },
    paths: {
      "/api/v1/invoices": {
        get: {
          operationId: "getInvoices",
          parameters: [
            { $ref: "#/components/parameters/status" },
            { $ref: "#/components/parameters/client_id" },
            { $ref: "#/components/parameters/X-Requested-With" },
            {
              name: "created_at",
              in: "query",
              schema: { type: "integer" },
              example: "?created_at=yesterday",
            },
            {
              name: "per_page",
              in: "query",
              schema: { type: "integer" },
              example: "twenty",
            },
            {
              name: "page",
              in: "query",
              schema: { type: "integer" },
              example: 1,
            },
          ],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/api/v1/ping": {
        get: {
          operationId: "ping",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  }),
)

describe("lintDocument", () => {
  const { problems, more } = lintDocument(doc, {
    blockedHeaders: ["X-Api-Token"],
  })

  it("finds examples an assistant would copy wrongly, with the edits that fix them", () => {
    expect(more).toBe(0)
    // A query-string example is not one: the generator reads the value. Nor
    // is a password header's placeholder a value PCP should send.
    expect(problems.map((problem) => [problem.at, problem.fix])).toEqual([
      [
        "/components/parameters/X-Requested-With",
        [
          {
            op: "replace",
            path: "/components/parameters/X-Requested-With/schema",
            value: {
              type: "string",
              enum: ["XMLHttpRequest"],
              default: "XMLHttpRequest",
            },
          },
        ],
      ],
      [
        "/paths/~1api~1v1~1invoices/get/parameters/3/example",
        [
          {
            op: "remove",
            path: "/paths/~1api~1v1~1invoices/get/parameters/3/example",
          },
        ],
      ],
      [
        "/paths/~1api~1v1~1invoices/get/parameters/4/example",
        [
          {
            op: "remove",
            path: "/paths/~1api~1v1~1invoices/get/parameters/4/example",
          },
        ],
      ],
      ["/paths", undefined],
    ])
    expect(problems.at(-1)!.problem).toMatch(/^1 GET operation does not/)
  })

  it("leaves a schema with nothing to say about once its fixes are applied", () => {
    const fixed = checkDocument(
      applyPatches(
        doc,
        problems.flatMap((problem) => problem.fix ?? []),
      ),
    )

    expect(
      lintDocument(fixed, { blockedHeaders: ["X-Api-Token"] }).problems.map(
        (problem) => problem.at,
      ),
    ).toEqual(["/paths"])

    // And the header is now sent by PCP rather than asked for.
    const [invoices] = generateTools(fixed, {
      readOnly: false,
      blockedHeaders: ["X-Api-Token"],
    }).tools
    const properties = invoices!.inputSchema.properties as Record<
      string,
      { examples?: unknown[] }
    >
    expect(Object.keys(properties)).toEqual([
      "status",
      "client_id",
      "created_at",
      "per_page",
      "page",
    ])
    // The query-string examples, as the values an assistant passes.
    expect(properties.status!.examples).toEqual(["archived,deleted"])
    expect(properties.client_id!.examples).toBeUndefined()
  })
})
