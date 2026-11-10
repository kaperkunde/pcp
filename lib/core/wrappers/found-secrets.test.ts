import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import { grantSecretUse } from "../browser-secrets"
import type { callBrowserTool } from "../browser/call"
import { createBrowserServer } from "../browser/server"
import type { VaultContext } from "../context"
import { db } from "../db"
import { createEndpoint } from "../endpoints"
import {
  buildGatewayServer,
  loadGatewayServers,
  type GatewayScope,
} from "../gateway"
import { json, startTestApi, type TestApi } from "../openapi/test-api"
import { decidePermission, getPermissionView } from "../permissions"
import { readRepo, serializeItem } from "../repos/documents"
import { wrapperInput } from "../repos/apply"
import { localItem } from "../repos/local"
import { reviewInVault } from "../repos/found-review"
import { createSecret, updateSecret } from "../secrets"
import { scratchDatabase } from "../test-db"
import { withCallHandle } from "../test-handles"
import { writeToolAccess } from "../tool-access"
import { setupVault } from "../vault"
import { saveWrapperByOwner } from "./admin"
import { readDefinition } from "./definition"

// A browser flow's secrets follow the owner's approval of the flow (#120):
// a secret its program types into pages by name as written is found there
// and shown on the request, its place made only on the owner's yes; typing
// it still passes the browser's own gate (the secret's sites, the token's
// allowance, or the owner's secret_use answer). A call whose secret has no
// place is refused with the place to propose. The browser itself is a
// stand-in here: it asks for the value as the real one does at the moment
// of typing (browser/call.ts), and records what it got.

const browser = vi.hoisted(() => ({
  typed: [] as string[],
  calls: 0,
}))

const SITE = "https://digid.example"

vi.mock("../browser/call", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../browser/call")>()

  return {
    ...actual,
    async callBrowserTool(
      _ctx: unknown,
      _server: unknown,
      _tool: string,
      _args: unknown,
      options: Parameters<typeof callBrowserTool>[4],
    ): Promise<CallToolResult> {
      browser.calls += 1

      if (options.secret) {
        browser.typed.push(
          await options.secret.value({
            tabId: "t1",
            origin: SITE,
            url: `${SITE}/login`,
            title: "Sign in",
            field: "e1",
            call: { tab: "t1", ref: "e1" },
          }),
        )
      }

      return { content: [{ type: "text", text: "Typed into e1." }] }
    },
  }
})

const PUBLIC_URL = "http://localhost:3000"
const PASSWORD = "hunter2-digid"

let cleanup: () => Promise<void>
let ctx: VaultContext
let api: TestApi
let scope: GatewayScope
let client: Client | null = null

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
  browser.typed = []
  browser.calls = 0
  api = await startTestApi((req, res) => json(res, 200, { got: req.url }))
  const { id: endpointId } = await createEndpoint(ctx, {
    name: "Things",
    specSource: "upload",
    specText: JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Things", version: "1" },
      servers: [{ url: api.origin }],
      paths: {
        "/echo": {
          get: {
            operationId: "echo",
            summary: "Says back what it was sent",
            parameters: [
              {
                name: "key",
                in: "query",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    }),
    readOnly: false,
    authType: "none",
  })
  await createBrowserServer(ctx)
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
    serverIds: [],
    manageWrappers: true,
  })
  scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  await writeToolAccess(scope.tokenId, endpointId, "echo", "allowed")
})

afterEach(async () => {
  await client?.close()
  client = null
  await api.close()
  await cleanup()
})

async function call(name: string, args: Record<string, unknown>) {
  await client?.close()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
    serverSide,
  )
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  const result = await client.callTool({
    name,
    arguments: name.startsWith("call_tool_")
      ? await withCallHandle(client, args)
      : args,
  })

  return {
    isError: result.isError === true,
    text: (result.content as Array<{ text?: string }>)
      .map((part) => part.text ?? "")
      .join(""),
  }
}

async function newestRequest() {
  return db().permissionRequest.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  })
}

async function definitionOf(serverId: string) {
  return readDefinition(
    (await db().wrapperSpec.findUniqueOrThrow({ where: { serverId } }))
      .definition,
  )
}

/** A flow that signs in: the login name, then the password, both by name. */
const SIGN_IN = {
  name: "sign_in",
  description: "Signs in to DigiD.",
  input_schema: { type: "object", properties: {} },
  program: `
    // { $secret: "In a comment" } is not typed.
    await pcp.call("browser", "type", { tab: "t1", ref: "e1", text: { $secret: "DigiD password", part: "username" } })
    await pcp.call("browser", "type", { tab: "t1", ref: "e2", text: {"$secret": 'DigiD password'} })
    if (args.which) await pcp.call("browser", "type", { tab: "t1", ref: "e3", text: { $secret: args.which } })
    if (args.later) await pcp.call("browser", "type", { tab: "t1", ref: "e3", text: { $secret: "Not held" } })
    return "signed in"
  `,
  calls: ["browser/type"],
}

async function digidSecret() {
  const { id } = await createSecret(ctx, {
    name: "DigiD password",
    value: PASSWORD,
  })
  await updateSecret(ctx, id, { loginName: "ada@example.com" })
  return id
}

async function proposeAndApprove(tools = [SIGN_IN]) {
  const asked = await call("create_wrapper", {
    name: "DigiD",
    description: "Signs in to DigiD.",
    tools,
  })
  expect(asked.text).toContain("Not done yet")
  const row = await newestRequest()
  const view = (await getPermissionView(ctx, row.id, {
    publicUrl: PUBLIC_URL,
  }))!
  const decided = await decidePermission(ctx, row.id, "allow_once", {
    publicUrl: PUBLIC_URL,
  })
  expect(decided.isError).not.toBe(true)
  const wrapper = await db().mcpServer.findFirstOrThrow({
    where: { kind: "wrapper" },
  })
  await writeToolAccess(scope.tokenId, wrapper.id, "sign_in", "allowed")
  return { view, wrapper }
}

describe("a secret a flow types into pages by name", () => {
  it("is found in the program, shown on the request, and given its place only on the owner's yes", async () => {
    const secretId = await digidSecret()

    const asked = await call("create_wrapper", {
      name: "DigiD",
      description: "Signs in to DigiD.",
      tools: [SIGN_IN],
    })
    expect(asked.text).toContain("Not done yet")
    expect(await db().mcpServer.count({ where: { kind: "wrapper" } })).toBe(0)

    const row = await newestRequest()
    const view = (await getPermissionView(ctx, row.id, {
      publicUrl: PUBLIC_URL,
    }))!
    expect(view.wrapper!.secrets).toEqual([
      expect.objectContaining({
        secret: "DigiD password",
        tool: "browser/type",
        argument: "/text",
        isNew: false,
        found: { parts: ["username", "password"] },
      }),
    ])
    expect(view.warning).toContain(
      'Found in the programs: they type your secret "DigiD password" (its login name and password) into pages with browser/type',
    )
    // Neither a name it works out, one in a comment, nor one PCP lacks.
    expect(view.warning).not.toContain("In a comment")
    expect(view.warning).not.toContain("Not held")

    expect(
      (
        await decidePermission(ctx, row.id, "decline", {
          publicUrl: PUBLIC_URL,
        })
      ).isError,
    ).not.toBe(true)
    expect(await db().mcpServer.count({ where: { kind: "wrapper" } })).toBe(0)

    const { wrapper } = await proposeAndApprove()
    expect((await definitionOf(wrapper.id)).secrets).toEqual([
      {
        secret: "DigiD password",
        secretId,
        serverId: expect.any(String),
        tool: "type",
        argument: "/text",
        template: "{{secret}}",
        url: expect.any(String),
        found: true,
        parts: ["username", "password"],
      },
    ])

    // get_wrapper names it apart from the places given by name.
    const read = await call("get_wrapper", { wrapper: "digid" })
    expect(JSON.parse(read.text)).toMatchObject({
      secrets: [],
      found_secrets: [
        { secret: "DigiD password", parts: ["username", "password"] },
      ],
    })
  })

  it("is typed only through the browser's own gate: the owner is asked at a site it is not bound to", async () => {
    const secretId = await digidSecret()
    await proposeAndApprove()

    const first = await call("call_tool_destructive", {
      server: "digid",
      tool: "sign_in",
      arguments: {},
    })
    expect(first.text).toContain("needs the owner first")
    expect(browser.typed).toEqual([])
    const asked = await newestRequest()
    expect(asked.kind).toBe("secret_use")

    // Once the owner allows it there for the token, it is typed, login name
    // and password, and the value is kept out of the answer.
    await grantSecretUse(ctx, {
      tokenId: scope.tokenId,
      secretId,
      origin: SITE,
      level: "always",
    })
    const second = await call("call_tool_destructive", {
      server: "digid",
      tool: "sign_in",
      arguments: {},
      rerun: true,
      reason: "The owner allowed the secret at the site.",
    })
    expect(second.isError, second.text).toBe(false)
    expect(second.text).toContain("signed in")
    expect(browser.typed).toEqual(["ada@example.com", PASSWORD])
    expect(second.text).not.toContain(PASSWORD)
  })

  it("is refused with the place to propose when PCP did not find it, and found by the next change", async () => {
    // The flow is approved before PCP holds the secret: nothing is found.
    const { wrapper } = await proposeAndApprove()
    expect((await definitionOf(wrapper.id)).secrets).toEqual([])
    await digidSecret()

    const refused = await call("call_tool_destructive", {
      server: "digid",
      tool: "sign_in",
      arguments: {},
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain(
      'The owner has not allowed the secret "DigiD password" in browser/type at /text for the wrapper digid',
    )
    expect(refused.text).toContain(
      'Fix it with update_wrapper: add {"secret":"DigiD password","tool":"browser/type","argument":"/text"} to secrets',
    )
    expect(refused.text).toContain("needs no entry once PCP holds it")
    expect(browser.calls).toBe(0)

    // Any change finds it, and shows it.
    const changed = await call("update_wrapper", {
      wrapper: "digid",
      description: "Signs in to DigiD, both parts.",
    })
    expect(changed.text).toContain("Not done yet")
    const row = await newestRequest()
    const view = (await getPermissionView(ctx, row.id, {
      publicUrl: PUBLIC_URL,
    }))!
    expect(view.wrapper!.secrets).toEqual([
      expect.objectContaining({
        secret: "DigiD password",
        found: expect.any(Object),
      }),
    ])
    expect((await definitionOf(wrapper.id)).secrets).toEqual([])
    await decidePermission(ctx, row.id, "allow_once", { publicUrl: PUBLIC_URL })
    expect((await definitionOf(wrapper.id)).secrets).toEqual([
      expect.objectContaining({ secret: "DigiD password", found: true }),
    ])
  })

  it("is never found for a tool other than the browser's type: that needs a place given by name", async () => {
    await createSecret(ctx, { name: "Things key", value: "sk-0123456789" })
    const { wrapper } = await proposeAndApprove([
      {
        name: "sign_in",
        description: "Looks a thing up with the key.",
        input_schema: { type: "object", properties: {} },
        program:
          'return await pcp.call("things", "echo", { key: { $secret: "Things key" } })',
        calls: ["things/echo"],
      },
    ])
    expect((await definitionOf(wrapper.id)).secrets).toEqual([])

    const refused = await call("call_tool_destructive", {
      server: "digid",
      tool: "sign_in",
      arguments: {},
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain(
      'add {"secret":"Things key","tool":"things/echo","argument":"/key"} to secrets',
    )
    expect(refused.text).not.toContain("needs no entry")
    expect(api.requests).toHaveLength(0)
  })

  it("takes several secrets at one place, each once", async () => {
    await createSecret(ctx, { name: "Bank user", value: "ada" })
    await createSecret(ctx, { name: "Bank password", value: "hunter2-bank" })
    const tool = {
      ...SIGN_IN,
      program:
        'const which = args.which; await pcp.call("browser", "type", { tab: "t1", ref: "e1", text: { $secret: which } }); return "ok"',
    }
    const place = (secret: string) => ({
      secret,
      tool: "browser/type",
      argument: "/text",
    })

    const twice = await call("create_wrapper", {
      name: "Bank",
      description: "Signs in to the bank.",
      tools: [tool],
      secrets: [place("Bank user"), place("Bank user")],
    })
    expect(twice.isError).toBe(true)
    expect(twice.text).toContain(
      'The secret "Bank user" goes to browser/type at /text twice.',
    )

    const both = await call("create_wrapper", {
      name: "Bank",
      description: "Signs in to the bank.",
      tools: [tool],
      secrets: [place("Bank user"), place("Bank password")],
    })
    expect(both.text).toContain("Not done yet")
    const row = await newestRequest()
    await decidePermission(ctx, row.id, "allow_once", { publicUrl: PUBLIC_URL })
    const wrapper = await db().mcpServer.findFirstOrThrow({
      where: { kind: "wrapper" },
    })
    expect(
      (await definitionOf(wrapper.id)).secrets.map((binding) => [
        binding.secret,
        binding.argument,
        binding.found,
      ]),
    ).toEqual([
      ["Bank user", "/text", undefined],
      ["Bank password", "/text", undefined],
    ])
  })

  it("stays out of a repository document, which finds it again where applied, and is flagged on review", async () => {
    await digidSecret()
    const { wrapper } = await proposeAndApprove()

    const { document } = await localItem(ctx, "flow", wrapper.id)
    expect(document.kind).toBe("flow")
    const files = serializeItem(document)
    expect(Object.values(files).join("\n")).not.toMatch(/found/)
    const [read] = (await readRepo(files)).items
    expect(read).toEqual(document)
    expect(read!.kind === "flow" && read!.secrets).toEqual([])

    // Applied as a document is, its place is found again.
    const input = wrapperInput(read as Parameters<typeof wrapperInput>[0])
    const copy = await saveWrapperByOwner(ctx, null, {
      ...input,
      name: "DigiD again",
    })
    expect((await definitionOf(copy.id)).secrets).toEqual([
      expect.objectContaining({ secret: "DigiD password", found: true }),
    ])

    // The owner's review of an incoming document as a new item says what
    // it would type; onto the wrapper that has the place already, nothing.
    const review = await reviewInVault(ctx, null, read!, null)
    expect(review.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "secret_binding",
          message: expect.stringContaining(
            'would type your secret "DigiD password" (its login name and password) into pages',
          ),
        }),
      ]),
    )
    expect(review.textOnly).toBe(false)
    const changedText = { ...read!, description: "Signs in, quicker." }
    expect(
      (await reviewInVault(ctx, read!, changedText, wrapper.id)).flags,
    ).toEqual([])
  })

  it("flags on a repository's review a place the wrapper does not have yet, even when only text changes", async () => {
    // Approved before PCP held the secret: no place.
    const { wrapper } = await proposeAndApprove()
    const { document } = await localItem(ctx, "flow", wrapper.id)
    await digidSecret()

    const textOnly = { ...document, description: "Signs in, quicker." }
    const review = await reviewInVault(ctx, document, textOnly, wrapper.id)
    expect(review.flags).toEqual([
      expect.objectContaining({
        kind: "secret_binding",
        message: expect.stringContaining('"DigiD password"'),
      }),
    ])
    expect(review.textOnly).toBe(false)
    // Nothing changes at all: nothing to apply, so nothing flagged.
    expect(
      (await reviewInVault(ctx, document, document, wrapper.id)).same,
    ).toBe(true)
  })

  it("names on the owner's own save the places it found that the wrapper did not have", async () => {
    const { wrapper } = await proposeAndApprove()
    await digidSecret()
    const { document } = await localItem(ctx, "flow", wrapper.id)
    const input = wrapperInput(document as Parameters<typeof wrapperInput>[0])

    const saved = await saveWrapperByOwner(ctx, wrapper.id, input)
    expect(saved.found).toEqual([
      { secret: "DigiD password", parts: ["username", "password"] },
    ])
    expect((await saveWrapperByOwner(ctx, wrapper.id, input)).found).toEqual([])
  })

  it("keeps a found place to what the program names: a part typed another way is refused", async () => {
    const secretId = await digidSecret()
    await grantSecretUse(ctx, {
      tokenId: scope.tokenId,
      secretId,
      origin: SITE,
      level: "always",
    })
    const { wrapper } = await proposeAndApprove([
      {
        ...SIGN_IN,
        program: `
          await pcp.call("browser", "type", { tab: "t1", ref: "e1", text: { $secret: "DigiD password", part: "username" } })
          const key = "pa" + "rt"
          await pcp.call("browser", "type", { tab: "t1", ref: "e2", text: { $secret: "DigiD password", [key]: "password" } })
          return "signed in"
        `,
      },
    ])
    expect((await definitionOf(wrapper.id)).secrets).toEqual([
      expect.objectContaining({
        secret: "DigiD password",
        found: true,
        parts: ["username"],
      }),
    ])

    const refused = await call("call_tool_destructive", {
      server: "digid",
      tool: "sign_in",
      arguments: {},
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain(
      'only its login name of the secret "DigiD password"',
    )
    expect(browser.typed).toEqual(["ada@example.com"])
    expect(refused.text).not.toContain(PASSWORD)
  })
})
