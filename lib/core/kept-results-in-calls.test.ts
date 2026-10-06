import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { createEndpoint } from "./endpoints"
import { json, startTestApi, type TestApi } from "./openapi/test-api"
import { runCall } from "./permissions"
import { getServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { keepBytes, keepResult } from "./tool-results"
import { setupVault } from "./vault"

// A kept result named in a call's arguments reaches the upstream as what it
// stands for: through runCall, an API endpoint and a real request.

const PUBLIC = { publicUrl: "http://localhost:3000" }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9])

let cleanup: () => Promise<void>
let api: TestApi
let ctx: VaultContext
let tokenId: string

function schema(origin: string) {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Pets" },
    servers: [{ url: `${origin}/api` }],
    paths: {
      "/pets": {
        post: {
          operationId: "createPet",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    photo: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  })
}

async function pets() {
  const { id } = await createEndpoint(ctx, {
    name: "Petstore",
    specSource: "upload",
    specText: schema(api.origin),
    readOnly: false,
    authType: "none",
  })

  return getServer(ctx, id)
}

async function keptText(text: string, forToken = tokenId) {
  return (
    await keepResult(ctx, {
      tokenId: forToken,
      serverId: null,
      toolName: "get_email",
      text,
      mediaType: "text/plain",
    })
  ).id
}

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  ;({ id: tokenId } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
  }))
  api = await startTestApi((_, res) => json(res, 200, { ok: true }))
})

afterEach(async () => {
  await api.close()
  await cleanup()
})

describe("a handle in an endpoint call's arguments", () => {
  it("is sent as the kept text, or the file's bytes as base64", async () => {
    const server = await pets()
    const text = await keptText("Rex, a very good dog")
    const file = (
      await keepBytes(ctx, {
        tokenId,
        serverId: null,
        toolName: "get_attachment",
        bytes: PNG,
        mediaType: "image/png",
        name: "rex.png",
      })
    ).id

    const answer = await runCall(
      ctx,
      server,
      "createPet",
      {
        body: { name: { $result: text }, photo: { $result: file } },
      },
      { ...PUBLIC, tokenId },
    )

    expect(answer.isError).toBeUndefined()
    expect(JSON.parse(api.requests[0]!.body)).toEqual({
      name: "Rex, a very good dog",
      photo: PNG.toString("base64"),
    })
  })

  it("is refused by name before anything is sent when the token has no such result", async () => {
    const server = await pets()
    const { id: other } = await createApiToken(ctx, {
      name: "Other",
      allowAllServers: true,
      serverIds: [],
    })
    const theirs = await keptText("not yours", other)

    for (const id of ["nope", theirs]) {
      await expect(
        runCall(
          ctx,
          server,
          "createPet",
          { body: { name: { $result: id } } },
          {
            ...PUBLIC,
            tokenId,
          },
        ),
      ).rejects.toThrow(new RegExp(`No kept result "${id}" for this token`))
    }

    expect(api.requests).toEqual([])
  })

  it("leaves an API's own $result property alone", async () => {
    const server = await pets()

    await runCall(
      ctx,
      server,
      "createPet",
      { body: { name: { $result: "x", other: 1 } } },
      { ...PUBLIC, tokenId },
    )

    expect(JSON.parse(api.requests[0]!.body)).toEqual({
      name: { $result: "x", other: 1 },
    })
  })
})

describe("an upload to an endpoint", () => {
  function uploadSchema(origin: string) {
    return JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Files" },
      servers: [{ url: `${origin}/api` }],
      paths: {
        "/documents": {
          put: {
            operationId: "putDocument",
            requestBody: {
              required: true,
              content: {
                "application/pdf": {
                  schema: { type: "string", format: "binary" },
                },
              },
            },
          },
        },
        "/photos": {
          post: {
            operationId: "addPhoto",
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    properties: {
                      caption: { type: "string" },
                      photo: { type: "string", format: "binary" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })
  }

  async function files() {
    const { id } = await createEndpoint(ctx, {
      name: "Files",
      specSource: "upload",
      specText: uploadSchema(api.origin),
      readOnly: false,
      authType: "none",
    })

    return getServer(ctx, id)
  }

  async function keptFile(bytes: Buffer, mediaType: string, name: string) {
    return (
      await keepBytes(ctx, {
        tokenId,
        serverId: null,
        toolName: "get_attachment",
        bytes,
        mediaType,
        name,
      })
    ).id
  }

  it("sends a kept file as the body, as its bytes", async () => {
    const server = await files()
    const pdf = Buffer.from("%PDF-1.7 \u0000\u00ff binary")
    const id = await keptFile(pdf, "application/pdf", "plan.pdf")

    const answer = await runCall(
      ctx,
      server,
      "putDocument",
      { body: { $result: id } },
      { ...PUBLIC, tokenId },
    )

    expect(answer.isError).toBeUndefined()
    expect(api.requests[0]).toMatchObject({
      method: "PUT",
      url: "/api/documents",
    })
    expect(api.requests[0]!.headers["content-type"]).toBe("application/pdf")
    expect(api.requests[0]!.bytes.equals(pdf)).toBe(true)
  })

  it("sends a kept file in multipart form data, under its name, beside a text a handle stands for", async () => {
    const server = await files()
    const id = await keptFile(PNG, "image/png", "rex.png")
    const caption = await keptText("Rex in the garden")

    await runCall(
      ctx,
      server,
      "addPhoto",
      { body: { caption: { $result: caption }, photo: { $result: id } } },
      { ...PUBLIC, tokenId },
    )

    const request = api.requests[0]!
    const body = request.bytes

    expect(request.headers["content-type"]).toMatch(
      /^multipart\/form-data; boundary=/,
    )
    expect(request.body).toContain(
      'name="caption"\r\n\r\nRex in the garden\r\n',
    )
    expect(request.body).toContain(
      'name="photo"; filename="rex.png"\r\nContent-Type: image/png\r\n\r\n',
    )
    expect(body.includes(PNG)).toBe(true)
  })

  it("refuses a file argument that is not a handle, or one the token has not got, sending nothing", async () => {
    const server = await files()

    await expect(
      runCall(
        ctx,
        server,
        "putDocument",
        { body: "%PDF" },
        {
          ...PUBLIC,
          tokenId,
        },
      ),
    ).rejects.toThrow(/is a file: pass a result PCP kept for you/)
    await expect(
      runCall(
        ctx,
        server,
        "addPhoto",
        { body: { photo: { $result: "gone" } } },
        { ...PUBLIC, tokenId },
      ),
    ).rejects.toThrow(/No kept result "gone" for this token/)
    expect(api.requests).toEqual([])
  })
})
