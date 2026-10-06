import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createApiToken, resolveApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid } from "./errors"
import { buildGatewayServer, buildInstructions } from "./gateway"
import type { JmapProbe } from "./mail/probe"
import { getPermissionView } from "./permissions"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"

// register_server as an assistant meets it: through the gateway's MCP
// interface, with its arguments checked and the request the owner is shown.
// What follows an approval is permissions.test.ts's.

const PUBLIC_URL = "http://localhost:3000"

let cleanup: () => Promise<void>
let ctx: VaultContext
let client: Client
/** What the look at a JMAP address finds; the address it was asked about. */
let probe: (url: string) => Promise<JmapProbe>
let probed: string[]

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

  probed = []
  probe = async (url) => ({
    checked: `A server answers at ${url} and asks for a sign-in (Basic).`,
    privateAddress: null,
  })
  await buildGatewayServer(scope, [], {
    probeJmap: async (url) => {
      probed.push(url)
      return probe(url)
    },
  }).connect(serverSide)
  client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
})

afterEach(async () => {
  await client.close()
  await cleanup()
})

async function register(args: Record<string, unknown>) {
  const result = await client.callTool({
    name: "register_server",
    arguments: args,
  })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("")

  return { isError: result.isError === true, text }
}

/** What the owner is shown for the newest request. */
async function shown() {
  const row = await db().permissionRequest.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  })
  const view = await getPermissionView(ctx, row.id, { publicUrl: PUBLIC_URL })

  return view!
}

const PETS = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Pets" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: { "/pets": { get: { operationId: "listPets" } } },
})

describe("what an assistant is told", () => {
  it("names mail accounts in the instructions, with and without servers", () => {
    for (const told of [
      buildInstructions([]),
      buildInstructions([
        { slug: "mail", name: "Mail", description: "", tools: [] } as never,
      ]),
    ]) {
      expect(told).toContain("mail accounts")
      expect(told).toMatch(
        /mail account \(JMAP, or IMAP with SMTP\)|mail account over JMAP or IMAP/,
      )
    }

    expect(
      buildInstructions([
        { slug: "mail", name: "Mail", description: "", tools: [] } as never,
      ]),
    ).toContain("never an API written around its mail server")
  })

  it("describes the tool so a mailbox is a mail account and the authentication is a choice", async () => {
    const { tools } = await client.listTools()
    const tool = tools.find((entry) => entry.name === "register_server")!
    const properties = tool.inputSchema.properties as Record<
      string,
      { enum?: string[]; description?: string }
    >

    expect(tool.title).toBe("Add a server, an API or a mail account")
    expect(tool.description).toContain(
      "A mailbox is always a mail account (jmap or imap), never an API you write around its mail server",
    )
    expect(tool.description).toContain("PCP finds out itself")
    expect(properties.kind?.enum).toEqual(["mcp", "api", "jmap", "imap"])
    expect(properties.auth_type?.enum).toEqual([
      "none",
      "header",
      "basic",
      "oauth",
    ])
    for (const name of ["username", "smtp_url", "mail_from"]) {
      expect(properties[name]?.description).toBeTruthy()
    }
    expect(properties.client_id?.description).toContain(
      "PCP finds out on its own whether it can register",
    )
  })
})

describe("proposing a mail account", () => {
  it("asks for a JMAP account from the server's address, with the password typed in on PCP", async () => {
    const asked = await register({
      kind: "jmap",
      name: "Personal mail",
      url: "https://mail.example.com",
      auth_type: "basic",
      username: "ada@example.com",
      secret: "Personal mail app password",
    })

    expect(asked.isError).toBe(false)
    expect(asked.text).toContain("Not done yet")
    expect(asked.text).toContain(
      'They type the password for ada@example.com in there, and it is saved as the secret "Personal mail app password"',
    )

    const view = await shown()
    expect(view.title).toBe("Add the mail account Personal mail?")
    expect(view.lines).toEqual(
      expect.arrayContaining([
        "Protocol: JMAP",
        // The address of the server alone was completed to the session.
        "Session URL: https://mail.example.com/.well-known/jmap",
        "User name: ada@example.com",
        'Authentication: user name and password; the password is saved as a new secret "Personal mail app password", and you enter it here when you agree',
      ]),
    )
    expect(view.secretToEnter).toMatchObject({
      name: "Personal mail app password",
      login: "ada@example.com",
    })
    // What was looked at is the session, and the owner is told what answered.
    expect(probed).toEqual(["https://mail.example.com/.well-known/jmap"])
    expect(view.lines).toContain(
      "Checked: A server answers at https://mail.example.com/.well-known/jmap and asks for a sign-in (Basic).",
    )
    // Nothing exists, and no secret was stored, until the owner agrees.
    expect(await db().mcpServer.count()).toBe(0)
    expect(await db().secret.count()).toBe(0)
  })

  it("refuses a JMAP address that is not one before the owner is asked", async () => {
    probe = async () => {
      throw invalid(
        "https://mail.example.com/.well-known/jmap answered HTTP 404. The session URL is usually https://<server>/.well-known/jmap.",
      )
    }

    const asked = await register({
      kind: "jmap",
      name: "Mail",
      url: "https://mail.example.com",
      auth_type: "oauth",
    })

    expect(asked.isError).toBe(true)
    expect(asked.text).toMatch(/answered HTTP 404/)
    expect(await db().permissionRequest.count()).toBe(0)
  })

  it("does not look at an address on a private network, and the owner is told", async () => {
    probe = async () => ({
      checked: null,
      privateAddress:
        "192.168.1.20 is, or resolves to, a private or local address, so PCP did not look at it from here.",
    })
    await register({
      kind: "jmap",
      name: "Home mail",
      url: "http://192.168.1.20:8080",
      auth_type: "oauth",
      oauth_scope: "urn:ietf:params:oauth:scope:mail",
    })

    const view = await shown()
    expect(view.lines).toEqual(
      expect.arrayContaining([
        "Session URL: http://192.168.1.20:8080/.well-known/jmap",
        expect.stringMatching(
          /192\.168\.1\.20 is, or resolves to, a private or local address.*from your own network/,
        ),
      ]),
    )
    expect(view.lines.some((line) => line.startsWith("Checked:"))).toBe(false)
  })

  it("asks for an IMAP account with an SMTP server, read-only if it says so", async () => {
    await register({
      kind: "imap",
      name: "Work mail",
      url: "mail.example.com",
      smtp_url: "smtp.example.com",
      auth_type: "basic",
      username: "ada@example.com",
      secret: "Work mail password",
      read_only: true,
      description: "Ada's work mail.",
    })

    const view = await shown()
    expect(view.title).toBe("Add the mail account Work mail?")
    expect(view.lines).toEqual(
      expect.arrayContaining([
        "Protocol: IMAP, sending through SMTP",
        "IMAP server: imaps://mail.example.com:993",
        "SMTP server: smtps://smtp.example.com:465",
        "Read-only: only the tools that read mail",
        "Description: Ada's work mail.",
      ]),
    )
  })

  it("uses a password the owner stored, by its name, and does not ask for one", async () => {
    const { createSecret } = await import("./secrets")
    await createSecret(ctx, { name: "Mail password", value: "app-password" })

    const asked = await register({
      kind: "jmap",
      name: "Mail",
      url: "https://mail.example.com",
      auth_type: "basic",
      username: "ada@example.com",
      secret: "Mail password",
    })

    expect(asked.text).not.toContain("They type")
    const view = await shown()
    expect(view.secretToEnter).toBeNull()
    expect(view.lines).toContain(
      'Authentication: user name and your secret "Mail password" as the password',
    )
  })

  it("is refused, with what to pass instead, when the arguments do not fit", async () => {
    const jmap = { kind: "jmap", name: "Mail", url: "https://mail.example.com" }

    // A mailbox that does not say how it signs in.
    expect(await register(jmap)).toMatchObject({
      isError: true,
      text: expect.stringMatching(
        /A mail account signs in: pass auth_type basic/,
      ),
    })
    // An OpenAPI wrapper is not how a mailbox is added.
    expect(
      await register({
        ...jmap,
        auth_type: "basic",
        username: "ada",
        secret: "pw",
        openapi_schema: PETS,
      }),
    ).toMatchObject({
      isError: true,
      text: expect.stringMatching(
        /are for kind api; a JMAP mail account takes none/,
      ),
    })
    // A password needs its user name and a secret to hold it.
    expect(
      await register({ ...jmap, auth_type: "basic", secret: "pw" }),
    ).toMatchObject({
      isError: true,
      text: expect.stringMatching(/needs the user name in username/),
    })
    expect(
      await register({ ...jmap, auth_type: "basic", username: "ada" }),
    ).toMatchObject({
      isError: true,
      text: expect.stringMatching(
        /needs the name of the secret that holds the password/,
      ),
    })
    // Sending through SMTP from a user name that is not an address.
    expect(
      await register({
        kind: "imap",
        name: "Mail",
        url: "mail.example.com",
        smtp_url: "smtp.example.com",
        auth_type: "basic",
        username: "ada",
        secret: "pw",
      }),
    ).toMatchObject({
      isError: true,
      text: expect.stringMatching(/Pass mail_from/),
    })
    // An address the owner's own form would refuse.
    expect(
      await register({
        ...jmap,
        url: "https://ada:secret@mail.example.com",
        auth_type: "oauth",
      }),
    ).toMatchObject({
      isError: true,
      text: expect.stringMatching(/user name or password/),
    })
    expect(
      await register({
        ...jmap,
        auth_type: "basic",
        username: "ada:x",
        secret: "pw",
      }),
    ).toMatchObject({ isError: true, text: expect.stringMatching(/colon/) })
    expect(
      await register({
        ...jmap,
        auth_type: "basic",
        username: "ada",
        secret: "not allowed!",
      }),
    ).toMatchObject({
      isError: true,
      text: expect.stringMatching(/The secret's name:/),
    })

    expect(await db().permissionRequest.count()).toBe(0)
  })
})

describe("what register_server has always taken", () => {
  it("asks for an MCP server by its address", async () => {
    const asked = await register({
      name: "Linear",
      url: "https://mcp.linear.example/mcp",
      auth_type: "header",
      secret: "Linear API key",
    })

    expect(asked.isError).toBe(false)
    const view = await shown()
    expect(view.title).toBe("Add the server Linear?")
    expect(view.lines).toContain("Address: https://mcp.linear.example/mcp")
  })

  it("asks for an API from its OpenAPI document, with a user name and password if it takes Basic", async () => {
    const asked = await register({
      name: "Pets",
      openapi_schema: PETS,
      url: "https://api.example.com/v1",
      auth_type: "basic",
      username: "ada",
      secret: "Pets password",
    })

    expect(asked.isError).toBe(false)
    expect(asked.text).toContain("They type the password for ada in there")
    const view = await shown()
    expect(view.title).toBe("Add the API endpoint Pets?")
    expect(view.lines).toContain(
      'Authentication: sends a new secret, saved as "Pets password", as the password for ada (HTTP Basic); you enter its value here when you agree',
    )
  })

  it("keeps saying what an MCP server needs, and where a mailbox goes", async () => {
    expect(await register({ name: "Nothing" })).toMatchObject({
      isError: true,
      text: expect.stringMatching(
        /needs its address in url.*kind jmap or imap/,
      ),
    })
    expect(
      await register({
        name: "Linear",
        url: "https://mcp.linear.example/mcp",
        auth_type: "basic",
        username: "ada",
        secret: "pw",
      }),
    ).toMatchObject({
      isError: true,
      text: expect.stringMatching(
        /MCP server sends a secret in a header or signs in with OAuth/,
      ),
    })
  })
})
