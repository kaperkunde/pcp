import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { buildGatewayServer, type GatewayScope } from "./gateway"
import { newId } from "./ids"
import { MAX_LISTED_SECRETS, secretUses } from "./secret-uses"
import { createSecret, writeManagedSecret } from "./secrets"
import { createServer } from "./servers"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// list_secrets as an assistant meets it: only for a token that may manage
// endpoints, with every secret's name and what uses it, never a value.

const PUBLIC_URL = "http://localhost:3000"
const LINEAR_VALUE = "lin_live_0123456789abcdef"
const SPARE_VALUE = "spare-value-fedcba9876543210"
const SSH_VALUE = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n"

let cleanup: () => Promise<void>
let ctx: VaultContext
let client: Client | null = null

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
})

afterEach(async () => {
  await client?.close()
  client = null
  await cleanup()
})

async function connect(manageEndpoints: boolean): Promise<Client> {
  const { token } = await createApiToken(ctx, {
    name: manageEndpoints ? "Manager" : "Claude",
    allowAllServers: true,
    serverIds: [],
    manageEndpoints,
  })
  const scope: GatewayScope = {
    ...(await resolveApiToken(token))!,
    publicUrl: PUBLIC_URL,
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, []).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  return client
}

async function listSecrets(args: Record<string, unknown> = {}) {
  const result = await client!.callTool({
    name: "list_secrets",
    arguments: args,
  })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return { isError: result.isError === true, text }
}

/** A wrapper whose definition has a place for `secretId`. */
async function wrapperBinding(secretId: string, serverId: string) {
  const id = newId()
  const definition = {
    version: 1,
    tools: [],
    secrets: [
      {
        secret: "Linear key",
        secretId,
        serverId,
        tool: "search",
        argument: "/key",
        template: "{{secret}}",
        url: "https://linear.example.com/mcp",
      },
    ],
  }

  await db().mcpServer.create({
    data: {
      id,
      vaultId: ctx.vaultId,
      kind: "wrapper",
      name: "Linear lookup",
      slug: "linear-lookup",
      url: "pcp:wrapper",
      wrapperSpec: {
        create: { definition: JSON.stringify(definition), hash: "x" },
      },
    },
  })
}

describe("list_secrets", () => {
  it("is offered only to a token that may manage endpoints, and says it only reads", async () => {
    const without = await (await connect(false)).listTools()
    expect(without.tools.map((tool) => tool.name)).not.toContain("list_secrets")
    await client!.close()

    const { tools } = await (await connect(true)).listTools()
    const tool = tools.find((each) => each.name === "list_secrets")
    expect(tool?.annotations?.readOnlyHint).toBe(true)

    const register = tools.find((each) => each.name === "register_server")
    expect(register?.description).toContain("list_secrets gives the names")
  })

  it("names every secret and what uses it, wrappers included, and never a value", async () => {
    const linear = await createSecret(ctx, {
      name: "Linear key",
      value: LINEAR_VALUE,
      description: "Linear's API key",
    })
    await createSecret(ctx, { name: "Spare key", value: SPARE_VALUE })
    await writeManagedSecret(ctx, {
      name: "Build box SSH key",
      description: "PCP's SSH key for Build box.",
      value: SSH_VALUE,
      kind: "ssh_key",
    })
    const { id: serverId } = await createServer(ctx, {
      name: "Linear",
      url: "https://linear.example.com/mcp",
      authType: "header",
      authSecretId: linear.id,
    })
    await wrapperBinding(linear.id, serverId)

    await connect(true)
    const listed = await listSecrets()

    expect(listed.isError).toBe(false)
    for (const value of [LINEAR_VALUE, SPARE_VALUE, SSH_VALUE, "AAAA"]) {
      expect(listed.text).not.toContain(value)
    }
    expect(listed.text).not.toMatch(
      /createdAt|updatedAt|lastUsedAt|\d{4}-\d\d-\d\dT/,
    )

    const { secrets } = JSON.parse(listed.text) as {
      secrets: Array<Record<string, unknown>>
    }
    expect(secrets).toEqual([
      {
        name: "Linear key",
        description: "Linear's API key",
        kind: "text",
        reusable: true,
        usedBy: [
          { name: "Linear", slug: "linear", kind: "server" },
          { name: "Linear lookup", slug: "linear-lookup", kind: "wrapper" },
        ],
      },
      {
        name: "Spare key",
        description: "",
        kind: "text",
        reusable: true,
        usedBy: [],
      },
      {
        name: "Build box SSH key",
        description: "PCP's SSH key for Build box.",
        kind: "SSH key (PCP's own, for an SSH server)",
        reusable: false,
        usedBy: [],
      },
    ])

    // query narrows by name or description, ignoring case.
    const narrowed = JSON.parse((await listSecrets({ query: "LINEAR'S" })).text)
    expect(narrowed.secrets.map((each: { name: string }) => each.name)).toEqual(
      ["Linear key"],
    )
    expect((await listSecrets({ query: "x".repeat(101) })).isError).toBe(true)
  })

  it("lists a bounded number and says how many more there are", async () => {
    for (let n = 0; n < MAX_LISTED_SECRETS + 3; n++) {
      await createSecret(ctx, {
        name: `Key ${String(n).padStart(3, "0")}`,
        value: `value-${n}`,
      })
    }

    await connect(true)
    const listed = JSON.parse((await listSecrets()).text)

    expect(listed.secrets).toHaveLength(MAX_LISTED_SECRETS)
    expect(listed.more).toContain("3 more")
  })
})

describe("secretUses", () => {
  it("covers headers, further headers, OAuth clients and wrappers, each server once", async () => {
    const key = await createSecret(ctx, { name: "Key", value: "k" })
    const second = await createSecret(ctx, { name: "Second", value: "s" })
    const client = await createSecret(ctx, { name: "Client", value: "c" })
    const { id: tools } = await createServer(ctx, {
      name: "Tools",
      url: "https://tools.example.com/mcp",
      authType: "header",
      authSecretId: key.id,
      authHeaderName: "X-API-Key",
      authValueTemplate: "{{secret}}",
      authExtraHeaders: [{ secretId: second.id, headerName: "X-Secret" }],
    })
    await createServer(ctx, {
      name: "Calendar",
      url: "https://calendar.example.com/mcp",
      authType: "oauth",
      oauthClientId: "pcp",
      oauthClientSecretId: client.id,
    })
    await wrapperBinding(key.id, tools)

    const uses = await secretUses(ctx)

    expect(uses.get(key.id)?.map((use) => use.name)).toEqual([
      "Linear lookup",
      "Tools",
    ])
    expect(uses.get(second.id)?.map((use) => use.name)).toEqual(["Tools"])
    expect(uses.get(client.id)?.map((use) => use.name)).toEqual(["Calendar"])
    expect([...(await secretUses(ctx, [second.id])).keys()]).toEqual([
      second.id,
    ])
  })
})
