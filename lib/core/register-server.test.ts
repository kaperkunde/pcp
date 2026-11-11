import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { serverNamed } from "./test-servers"

import { createApiToken, resolveApiToken } from "./api-tokens"
import type { VaultContext } from "./context"
import { decryptString } from "./crypto"
import { db } from "./db"
import { createEndpoint, storedSpec } from "./endpoints"
import { invalid, PcpError } from "./errors"
import {
  buildGatewayServer,
  buildInstructions,
  loadGatewayServers,
} from "./gateway"
import type { JmapProbe } from "./mail/probe"
import { decidePermission, getPermissionView } from "./permissions"
import { readServerNote } from "./personal-notes"
import { createSecret, writeManagedSecret } from "./secrets"
import { createServer, getServer, setToolDescription } from "./servers"
import { writeToolAccess } from "./tool-access"
import { ensureDefinition } from "./definition-rows"
import {
  parseServiceDefinition,
  serviceDefinitionHash,
} from "./services/definition"
import {
  serviceOfDefinition,
  writeServiceDefinition,
  type ServiceLaunchInput,
} from "./services/services"
import { createSshServer } from "./ssh/hosts"
import { serverCreateData } from "./server-meta"
import { writeServer } from "./server-meta"
import { scratchDatabase } from "./test-db"
import { setupVault } from "./vault"
import { secretNameWhere } from "./secret-meta"
import { TOKEN_NAME_SELECT, tokenName } from "./token-names"

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
/** What a name resolves to here; a name not listed does not resolve. */
let resolves: Record<string, string[]>

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
  resolves = {
    "mcp.linear.example": ["203.0.114.7"],
    "mail.example.com": ["203.0.114.8"],
    "smtp.example.com": ["203.0.114.9"],
    "mcp.home.example": ["192.168.1.30"],
    "mail.lan": ["10.0.0.5"],
    "caldav.icloud.com": ["17.248.1.1"],
    "radicale.lan": ["192.168.1.40"],
    "smtp.lan": ["fd00::25"],
  }
  probe = async (url) => ({
    checked: `A server answers at ${url} and asks for a sign-in (Basic).`,
    privateAddress: null,
  })
  await buildGatewayServer(scope, [], {
    probeJmap: async (url) => {
      probed.push(url)
      return probe(url)
    },
    lookupHost: async (host) => {
      const found = resolves[host]

      if (!found) {
        throw new Error(`getaddrinfo ENOTFOUND ${host}`)
      }

      return found
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
  it("names mail and calendar accounts in the instructions, with and without servers", () => {
    for (const told of [
      buildInstructions([]),
      buildInstructions([
        { slug: "mail", name: "Mail", description: "", tools: [] } as never,
      ]),
    ]) {
      expect(told).toContain("mail and calendar accounts")
      expect(told).toMatch(
        /mail account \(JMAP, or IMAP with SMTP\)|mail account over JMAP or IMAP/,
      )
      expect(told).toMatch(/calendar account (over CalDAV|\(CalDAV)/)
    }

    expect(
      buildInstructions([
        { slug: "mail", name: "Mail", description: "", tools: [] } as never,
      ]),
    ).toContain(
      "A mailbox is always a mail account and a calendar a calendar account, never an API written around their servers",
    )
  })

  it("describes the tool so a mailbox is a mail account and the authentication is a choice", async () => {
    const { tools } = await client.listTools()
    const tool = tools.find((entry) => entry.name === "register_server")!
    const properties = tool.inputSchema.properties as Record<
      string,
      { enum?: string[]; description?: string }
    >

    expect(tool.title).toBe(
      "Add a server, an API, a mail or a calendar account, or a service",
    )
    expect(tool.description).toContain(
      "A mailbox is always a mail account (jmap or imap), never an API you write around its mail server",
    )
    expect(tool.description).toContain("PCP finds out itself")
    expect(tool.description).toContain(
      "Calendars and reminders are always a calendar account (caldav), never an API",
    )
    expect(properties.kind?.enum).toEqual([
      "mcp",
      "api",
      "jmap",
      "imap",
      "caldav",
      "service",
    ])
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
    const asked = await register({
      kind: "jmap",
      name: "Home mail",
      url: "http://192.168.1.20:8080",
      auth_type: "oauth",
      oauth_scope: "urn:ietf:params:oauth:scope:mail",
    })
    // The owner's to read, not the assistant's: for a name it would say
    // what the owner's DNS holds.
    expect(asked.text).not.toMatch(/private or local/)

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
    // The owner is told the sign-in is not encrypted.
    expect(view.lines).toContainEqual(
      expect.stringMatching(
        /^Not encrypted: the session URL starts with http:/,
      ),
    )
  })

  it("refuses http:// to a public address or a name that is not private, before the owner is asked", async () => {
    for (const url of [
      "http://8.8.8.8",
      "http://mail.example.invalid:8080/.well-known/jmap",
    ]) {
      const asked = await register({
        kind: "jmap",
        name: "Mail",
        url,
        auth_type: "oauth",
        oauth_scope: "urn:ietf:params:oauth:scope:mail",
      })

      expect(asked.isError).toBe(true)
      expect(asked.text).toMatch(/unencrypted.*https:\/\//)
    }

    expect(probed).toEqual([])
    expect(await db().permissionRequest.count()).toBe(0)
  })

  it("does not flag an https session URL as unencrypted", async () => {
    await register({
      kind: "jmap",
      name: "Mail",
      url: "https://mail.example.com",
      auth_type: "oauth",
      oauth_scope: "urn:ietf:params:oauth:scope:mail",
    })

    expect(
      (await shown()).lines.some((line) => line.startsWith("Not encrypted")),
    ).toBe(false)
  })

  it("asks for an IMAP account with an SMTP server, read-only if it says so", async () => {
    await db().permissionRequest.deleteMany()
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

describe("proposing a calendar account", () => {
  it("asks for an iCloud account with the app-specific password typed in on PCP, and makes nothing yet", async () => {
    const asked = await register({
      kind: "caldav",
      name: "iCloud",
      url: "caldav.icloud.com",
      auth_type: "basic",
      username: "ada@icloud.com",
      secret: "iCloud app password",
    })

    expect(asked.isError).toBe(false)
    expect(asked.text).toContain("Not done yet")

    const view = await shown()
    expect(view.title).toBe("Add the calendar account iCloud?")
    expect(view.lines).toEqual(
      expect.arrayContaining([
        "CalDAV server: https://caldav.icloud.com/",
        "User name: ada@icloud.com",
        'Authentication: user name and password; the password is saved as a new secret "iCloud app password", and you enter it here when you agree',
        expect.stringMatching(/^Can change things: .*invite nobody/),
      ]),
    )
    expect(view.warning).toMatch(/to this calendar server/)
    expect(view.secretToEnter).toMatchObject({
      name: "iCloud app password",
      login: "ada@icloud.com",
    })
    expect(await db().mcpServer.count()).toBe(0)
    expect(await db().secret.count()).toBe(0)
  })

  it("says read-only, and flags a server on the owner's network to them alone", async () => {
    const asked = await register({
      kind: "caldav",
      name: "Radicale",
      url: "https://radicale.lan/ada/",
      auth_type: "basic",
      username: "ada",
      secret: "Radicale password",
      read_only: true,
    })

    const view = await shown()
    expect(view.lines).toEqual(
      expect.arrayContaining([
        "Read-only: only the tools that read calendars and reminders",
        "radicale.lan is, or resolves to, a private or local address. If you agree, PCP signs in there from your own network.",
      ]),
    )
    expect(asked.text).not.toContain("private")
  })

  it("is refused over http:// to a public address, or without a sign-in", async () => {
    expect(
      await register({
        kind: "caldav",
        name: "Cal",
        url: "http://caldav.icloud.com/",
        auth_type: "basic",
        username: "ada",
        secret: "pw",
      }),
    ).toMatchObject({
      isError: true,
      text: expect.stringMatching(/unencrypted/),
    })
    expect(
      await register({ kind: "caldav", name: "Cal", url: "caldav.icloud.com" }),
    ).toMatchObject({ isError: true, text: expect.stringMatching(/signs in/) })
    expect(await db().permissionRequest.count()).toBe(0)
  })
})

describe("an address on the owner's own network", () => {
  it("flags an MCP server's private address to the owner, and does not tell the assistant", async () => {
    for (const url of [
      "http://192.168.1.30:8080/mcp",
      "https://mcp.home.example/mcp",
      "http://[::1]:3000/mcp",
      "http://169.254.169.254/latest",
    ]) {
      // shown() reads the newest request; requests made in the same
      // millisecond would tie.
      await db().permissionRequest.deleteMany()
      const asked = await register({ name: "Linear", url })
      expect(asked.isError, url).toBe(false)
      // What a name resolves to is not the assistant's to learn: it could
      // map the owner's network with proposals.
      expect(asked.text, url).not.toMatch(/private or local/)

      const host = new URL(url).hostname.replace(/^\[|\]$/g, "")
      expect((await shown()).lines, url).toContainEqual(
        `${host} is, or resolves to, a private or local address. A server an assistant proposes reaches public addresses only: allow private addresses below as you agree, or later on its page.`,
      )
      expect((await shown()).offersPrivateAddresses, url).toBe(true)
    }
  })

  it("offers the owner no private addresses for a public server or a mail account", async () => {
    await register({ name: "Linear", url: "https://mcp.linear.example/mcp" })
    expect((await shown()).offersPrivateAddresses).toBe(false)

    await db().permissionRequest.deleteMany()
    await register({
      kind: "imap",
      name: "Home mail",
      url: "mail.lan",
      auth_type: "basic",
      username: "ada@example.com",
      secret: "Home mail password",
    })
    expect((await shown()).offersPrivateAddresses).toBe(false)
  })

  it("never takes public-only from the assistant", async () => {
    for (const extra of [
      { public_only: false },
      { allow_private: true },
      { private_addresses: true },
    ]) {
      const asked = await register({
        name: "Linear",
        url: "http://192.168.1.30:8080/mcp",
        ...extra,
      })
      expect(asked.isError, JSON.stringify(extra)).toBe(true)
    }
    expect(await db().permissionRequest.count()).toBe(0)
  })

  describe("approved", () => {
    const NO_SYNC = {
      callTool: async () => {
        throw new Error("no call runs here")
      },
      syncTools: async () => ({
        status: "error" as const,
        message: "It could not be reached.",
        toolCount: 0,
      }),
    }

    async function approve(allowPrivate?: boolean) {
      const row = await db().permissionRequest.findFirstOrThrow({
        orderBy: { createdAt: "desc" },
      })
      const result = await decidePermission(
        ctx,
        row.id,
        "allow_once",
        { publicUrl: PUBLIC_URL, allowPrivate },
        NO_SYNC,
      )
      const after = await db().permissionRequest.findUniqueOrThrow({
        where: { id: row.id },
      })
      const text = (result.content as Array<{ text?: string }>)
        .map((part) => part.text ?? "")
        .join("")

      return { server: await getServer(ctx, after.serverId!), text }
    }

    it("stays public-only unless the owner ticks Allow private addresses, and links its switch", async () => {
      await register({ name: "Home", url: "http://192.168.1.30:8080/mcp" })
      const left = await approve()
      expect(left.server.publicOnly).toBe(true)
      expect(left.text.trimEnd().split("\n").at(-1)).toBe(
        `[Allow private addresses for Home](${PUBLIC_URL}/servers/${left.server.id}#public-only)`,
      )

      await register({ name: "Home 2", url: "http://192.168.1.30:8080/mcp" })
      const allowed = await approve(true)
      expect(allowed.server.publicOnly).toBe(false)
      expect(allowed.text).not.toContain("#public-only")
    })

    it("ignores the tick on a request that was not flagged private", async () => {
      await register({ name: "Linear", url: "https://mcp.linear.example/mcp" })
      const { server, text } = await approve(true)

      expect(server.publicOnly).toBe(true)
      expect(text).not.toContain("#public-only")
    })

    it("makes an endpoint at a private address the same way", async () => {
      const local = JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Local" },
        servers: [{ url: "http://127.0.0.1:9/v1" }],
        paths: { "/pets": { get: { operationId: "listPets" } } },
      })

      await register({ name: "Local", openapi_schema: local })
      expect((await shown()).offersPrivateAddresses).toBe(true)
      const left = await approve()
      expect(left.server.publicOnly).toBe(true)
      expect(left.text).toContain("its calls are refused")
      expect(left.text).toContain(
        `(${PUBLIC_URL}/servers/${left.server.id}#public-only)`,
      )

      await register({ name: "Local 2", openapi_schema: local })
      const allowed = await approve(true)
      expect(allowed.server.publicOnly).toBe(false)
      expect(allowed.text).not.toContain("#public-only")
    })
  })

  it("does not flag a name that does not resolve", async () => {
    await register({ name: "Nowhere", url: "https://nowhere.example/mcp" })

    expect((await shown()).lines.join("\n")).not.toMatch(/private or local/)
  })

  it("flags the private IMAP and SMTP servers of a proposed mail account", async () => {
    const asked = await register({
      kind: "imap",
      name: "Home mail",
      url: "mail.lan",
      smtp_url: "smtp.lan",
      auth_type: "basic",
      username: "ada@example.com",
      secret: "Home mail password",
    })

    expect((await shown()).lines).toContainEqual(
      "mail.lan and smtp.lan are, or resolve to, private or local addresses. If you agree, PCP signs in there from your own network.",
    )
    expect(asked.text).not.toMatch(/private or local/)

    await db().permissionRequest.deleteMany()
    await register({
      kind: "imap",
      name: "Mixed mail",
      url: "mail.example.com",
      smtp_url: "smtp.lan",
      auth_type: "basic",
      username: "ada@example.com",
      secret: "Mixed mail password",
    })

    expect((await shown()).lines).toContainEqual(
      "smtp.lan is, or resolves to, a private or local address. If you agree, PCP signs in there from your own network.",
    )

    await register({
      kind: "imap",
      name: "Work mail",
      url: "mail.example.com",
      smtp_url: "smtp.example.com",
      auth_type: "basic",
      username: "ada@example.com",
      secret: "Work mail password",
    })

    expect((await shown()).lines.join("\n")).not.toMatch(/private or local/)
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
    expect(view.lines.join("\n")).not.toMatch(/private or local/)
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

describe("a secret the owner already has", () => {
  /** The gateway again, for a token that may or may not manage endpoints. */
  async function connectAs(manageEndpoints: boolean) {
    await client.close()
    const { token } = await createApiToken(ctx, {
      name: manageEndpoints ? "Manager" : "Helper",
      allowAllServers: true,
      serverIds: [],
      manageEndpoints,
    })
    const scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, [], {
      lookupHost: async () => ["203.0.114.7"],
    }).connect(serverSide)
    client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
  }

  async function linearKey() {
    const key = await createSecret(ctx, {
      name: "Linear API key",
      value: "lin_live_0123456789",
    })
    for (const [name, url] of [
      ["Linear", "https://mcp.linear.example/mcp"],
      ["Linear staging", "https://staging.linear.example/mcp"],
    ]) {
      await createServer(ctx, {
        name: name!,
        url: url!,
        authType: "header",
        authSecretId: key.id,
      })
    }
  }

  const proposal = {
    name: "Linear issues",
    openapi_schema: PETS,
    url: "https://api.example.com/v1",
    auth_type: "header",
    header_name: "X-API-Key",
    value_template: "{{secret}}",
    secret: "Linear API key",
  }
  const REUSED =
    'Reuses your secret "Linear API key", already used by Linear and Linear staging: you do not enter it again'

  it("tells the owner and a token that manages endpoints what already uses it", async () => {
    await linearKey()
    await connectAs(true)

    const asked = await register(proposal)

    expect(asked.isError).toBe(false)
    expect(asked.text).toContain(REUSED)
    expect(asked.text).not.toContain("They type")
    expect(asked.text).not.toContain("lin_live_0123456789")
    const view = await shown()
    expect(view.secretToEnter).toBeNull()
    expect(view.lines).toEqual(
      expect.arrayContaining([
        'Authentication: sends your secret "Linear API key" in the X-API-Key header',
        REUSED,
      ]),
    )
  })

  it("says so when nothing uses it yet", async () => {
    await createSecret(ctx, { name: "Linear API key", value: "lin_live_0" })
    await connectAs(true)

    expect((await register(proposal)).text).toContain(
      'Reuses your secret "Linear API key", not used by anything yet: you do not enter it again',
    )
  })

  it("shows what uses it to the owner alone when the token does not manage endpoints", async () => {
    await linearKey()
    await connectAs(false)

    const asked = await register(proposal)

    expect(asked.isError).toBe(false)
    expect(asked.text).not.toContain("Linear staging")
    expect((await shown()).lines).toContain(REUSED)
  })

  it("treats the name of a secret PCP manages as a new secret", async () => {
    await writeManagedSecret(ctx, {
      name: "Build box SSH key",
      description: "PCP's SSH key for Build box.",
      value: "-----BEGIN OPENSSH PRIVATE KEY-----",
      kind: "ssh_key",
    })
    await writeManagedSecret(ctx, {
      name: "Calendar sign-in",
      description: "OAuth tokens",
      value: "{}",
      kind: "oauth",
    })
    await connectAs(true)

    for (const name of ["Build box SSH key", "Calendar sign-in"]) {
      const asked = await register({ ...proposal, secret: name })

      expect(asked.isError).toBe(false)
      expect(asked.text).toContain(
        `They type the value of the secret "${name}" in there`,
      )
      expect(asked.text).not.toContain("Reuses your secret")
      const view = await shown()
      expect(view.secretToEnter?.name).toBe(name)
      expect(view.lines).toContain(
        `Authentication: sends a new secret, saved as "${name}", in the X-API-Key header; you enter its value here when you agree`,
      )
    }
  })
})

describe("another server of a definition", () => {
  const NO_SYNC = {
    callTool: async () => {
      throw new Error("no call runs here")
    },
    syncTools: async () => ({
      status: "ok" as const,
      message: "",
      toolCount: 0,
    }),
  }

  /** The owner's endpoint, with a secret, an edit and a tool's description. */
  async function ownerEndpoint() {
    const key = await createSecret(ctx, { name: "Gaaf key", value: "k-1" })
    const { id } = await createEndpoint(ctx, {
      name: "Coolify gaaf",
      description: "Coolify's API.",
      baseUrl: "https://gaaf.example.net/v1",
      specSource: "upload",
      specText: PETS,
      patches: [
        {
          op: "add",
          path: "/paths/~1pets/get/summary",
          value: "List the pets",
        },
      ],
      readOnly: false,
      authType: "header",
      authHeaderName: "Authorization",
      authValueTemplate: "Bearer {{secret}}",
      authSecretId: key.id,
    })
    await setToolDescription(ctx, id, "listPets", "Every pet, by name.")
    return getServer(ctx, id)
  }

  /** The gateway for a token that sees the servers made so far. */
  async function connectSeeing(serverIds?: string[], manageEndpoints = false) {
    await client.close()
    const { token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: serverIds === undefined,
      serverIds: serverIds ?? [],
      manageEndpoints,
    })
    const scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, await loadGatewayServers(scope), {
      lookupHost: async () => ["203.0.114.7"],
    }).connect(serverSide)
    client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
  }

  async function approve() {
    const row = await db().permissionRequest.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    })

    return decidePermission(
      ctx,
      row.id,
      "allow_once",
      { publicUrl: PUBLIC_URL },
      NO_SYNC,
    )
  }

  it("asks for an endpoint of the same definition at its own address, with the definition's schema, and makes nothing yet", async () => {
    const source = await ownerEndpoint()
    await connectSeeing()

    const asked = await register({
      name: "Coolify plek",
      definition: source.slug,
      url: "https://plek.example.net/v1",
      read_only: true,
      note: "The plek.je production host.",
    })

    expect(asked.isError).toBe(false)
    const view = await shown()
    expect(view.title).toBe("Add the API endpoint Coolify plek?")
    expect(view.lines).toEqual(
      expect.arrayContaining([
        "Address: https://plek.example.net/v1",
        `Another server of Coolify gaaf, beside ${source.slug}: it shares their description, schema, edits and tool descriptions, so a change to those changes every one of them`,
        "Its tools ask you first, for every token, as a new server's do",
        "Schema: the one they share",
        "Edits: 1 change to the schema, applied before the tools are made",
        "Read-only: only GET operations become tools",
        "Description: Coolify's API.",
        "Your note on it, which every assistant that sees it reads as yours:\nThe plek.je production host.",
      ]),
    )
    // Nothing exists yet, and no copy of the schema waits on the request.
    expect(await db().mcpServer.count({ where: { kind: "openapi" } })).toBe(1)
    const row = await db().permissionRequest.findFirstOrThrow()
    const args = JSON.parse(
      decryptString(
        ctx.dek,
        Buffer.from(row.argsCiphertext),
        `permission_request:${row.id}`,
      ),
    ) as { endpoint: { spec: string } }
    expect(args.endpoint.spec).toBe("")
  })

  it("makes it on approval from the definition's schema, edits and descriptions, public-only, with the note and no levels", async () => {
    const source = await ownerEndpoint()
    await writeToolAccess(
      (await createApiToken(ctx, { name: "Other", allowAllServers: true })).id,
      source.id,
      "listPets",
      "allowed",
    )
    await connectSeeing()
    await register({
      name: "Coolify plek",
      definition: source.slug,
      url: "https://plek.example.net/v1",
      note: "The plek.je production host.",
    })

    const done = await approve()

    expect(done.isError).not.toBe(true)
    const made = await serverNamed(ctx, "Coolify plek")
    expect(made).toMatchObject({
      definitionId: source.definitionId,
      description: "Coolify's API.",
      url: "https://plek.example.net/v1",
      publicOnly: true,
      authType: "none",
      authSecretId: null,
    })
    const [mine, theirs] = await Promise.all([
      storedSpec(ctx, made.id),
      storedSpec(ctx, source.id),
    ])
    expect(mine!.hash).toBe(theirs!.hash)
    expect(mine!.patches).toEqual(theirs!.patches)
    expect(
      made.tools.find((tool) => tool.name === "listPets")?.descriptionOverride,
    ).toBe("Every pet, by name.")
    expect(readServerNote(ctx, made)).toBe("The plek.je production host.")
    // The source's levels stay the source's.
    expect(
      await db().apiTokenToolAccess.count({ where: { serverId: made.id } }),
    ).toBe(0)
  })

  it("makes nothing when the definition changed after the owner was asked", async () => {
    const source = await ownerEndpoint()
    await connectSeeing()
    await register({
      name: "Coolify plek",
      definition: source.slug,
      url: "https://plek.example.net/v1",
    })
    await setToolDescription(ctx, source.id, "listPets", "Something else.")

    const done = await approve()

    expect(JSON.stringify(done)).toMatch(/has changed since this was asked/)
    expect(await db().mcpServer.count({ where: { kind: "openapi" } })).toBe(1)
  })

  it("asks for an MCP server of the same definition, and makes it on approval", async () => {
    const { id } = await createServer(ctx, {
      name: "Linear",
      url: "https://mcp.linear.example/mcp",
      description: "Issues and projects.",
      authType: "none",
    })
    const source = await getServer(ctx, id)
    await connectSeeing()

    const asked = await register({
      name: "Linear staging",
      definition: "linear",
      url: "https://staging.linear.example/mcp",
    })

    expect(asked.isError).toBe(false)
    expect((await shown()).lines).toEqual(
      expect.arrayContaining([
        "Another server of Linear, beside linear: it shares their description and tool descriptions, so a change to those changes every one of them",
        "Description: Issues and projects.",
      ]),
    )
    await approve()
    const made = await serverNamed(ctx, "Linear staging")
    expect(made).toMatchObject({
      definitionId: source.definitionId,
      description: "Issues and projects.",
      publicOnly: true,
    })
  })

  it("is refused for a definition the token does not see, a kind that is not its, or a note that does not fit", async () => {
    const source = await ownerEndpoint()
    const { id: other } = await createServer(ctx, {
      name: "Linear",
      url: "https://mcp.linear.example/mcp",
      authType: "none",
    })
    await connectSeeing([other])

    const hidden = await register({
      name: "Coolify plek",
      definition: source.slug,
      url: "https://plek.example.net/v1",
    })
    expect(hidden).toMatchObject({
      isError: true,
      text: expect.stringMatching(
        /No MCP server, API endpoint or service called coolify-gaaf that this token sees, .*Those it sees: linear\./,
      ),
    })

    await connectSeeing()
    expect(
      await register({
        name: "Coolify plek",
        kind: "mcp",
        definition: source.slug,
        url: "https://plek.example.net/v1",
      }),
    ).toMatchObject({
      isError: true,
      text: expect.stringMatching(/is an API endpoint: its kind is api/),
    })
    expect(
      await register({
        name: "Coolify plek",
        definition: source.slug,
        url: "https://plek.example.net/v1",
        openapi_schema: PETS,
      }),
    ).toMatchObject({
      isError: true,
      text: expect.stringMatching(
        /the schema and its edits are the definition's/,
      ),
    })

    for (const note of ["Two\nlines", "x".repeat(301), "Hidden​thing"]) {
      expect(
        (
          await register({
            name: "Coolify plek",
            definition: source.slug,
            url: "https://plek.example.net/v1",
            note,
          })
        ).isError,
      ).toBe(true)
    }
    expect(await db().permissionRequest.count()).toBe(0)
  })

  it("lets update_endpoint propose the note and detach, each in a call of its own", async () => {
    const source = await ownerEndpoint()
    await createEndpoint(ctx, {
      name: "Coolify plek",
      baseUrl: "https://plek.example.net/v1",
      specSource: "upload",
      specText: PETS,
      readOnly: false,
      authType: "none",
      definitionId: source.definitionId,
    })
    await connectSeeing(undefined, true)
    const update = async (args: Record<string, unknown>) => {
      const result = await client.callTool({
        name: "update_endpoint",
        arguments: args,
      })
      return {
        isError: result.isError === true,
        text: (result.content as Array<{ text?: string }>)
          .map((part) => part.text ?? "")
          .join(""),
      }
    }

    expect(
      await update({ endpoint: source.slug, note: "Gaaf.", detach: true }),
    ).toMatchObject({
      isError: true,
      text: expect.stringContaining(
        "note and detach each go in a call of their own",
      ),
    })
    expect(
      await update({ endpoint: source.slug, note: "Gaaf.", name: "Other" }),
    ).toMatchObject({
      isError: true,
      text: expect.stringContaining("note goes in a call of its own"),
    })
    expect(await db().permissionRequest.count()).toBe(0)

    expect(
      (await update({ endpoint: source.slug, note: "The gaaf host." })).text,
    ).toContain("Not done yet")
    expect((await shown()).title).toBe(
      "Save this as your note on Coolify gaaf?",
    )

    expect(
      (await update({ endpoint: source.slug, detach: true })).text,
    ).toContain("Not done yet")
    const detach = await shown()
    expect(detach.kind).toBe("endpoint_change")
    expect(detach.title).toBe("Detach Coolify gaaf?")
    expect(detach.lines).toContain(
      "Shares its description, schema, edits and tool descriptions with: coolify-plek",
    )
    // Nothing was written by asking.
    expect(readServerNote(ctx, await getServer(ctx, source.id))).toBeNull()
    expect((await getServer(ctx, source.id)).definitionId).toBe(
      source.definitionId,
    )
  })

  it("puts a note on any new server, for the owner to read whole", async () => {
    await register({
      name: "Linear",
      url: "https://mcp.linear.example/mcp",
      note: "The team's tracker.",
    })

    expect((await shown()).lines).toContain(
      "Your note on it, which every assistant that sees it reads as yours:\nThe team's tracker.",
    )
  })
})

describe("proposing a service", () => {
  const IMAGE = `ghcr.io/docling-project/docling-serve-cpu@sha256:${"c".repeat(64)}`
  const DEFINITION = {
    image: IMAGE,
    source: "ghcr.io/docling-project/docling-serve-cpu:latest",
    ports: [{ container: 5001 }],
    env: [
      { name: "DOCLING_SERVE_API_KEY", required: true },
      { name: "DOCLING_SERVE_ENABLE_UI", value: "false" },
    ],
    volumes: [{ name: "cache", path: "/opt/cache" }],
    health: { kind: "http", port: 5001, path: "/health" },
    registers: {
      kind: "openapi",
      port: 5001,
      specPath: "/openapi.json",
      auth: {
        env: "DOCLING_SERVE_API_KEY",
        header: "X-Api-Key",
        template: "{{secret}}",
      },
    },
  }
  let launched: ServiceLaunchInput[]

  /** The owner's SSH server, its host key pinned (as rows: nothing connects). */
  async function sshServer(name = "Build box", pinned = true) {
    const { id } = await createSshServer(ctx, {
      name,
      host: "build.ada-home.net",
      port: 22,
      username: "deploy",
    })

    if (pinned) {
      await writeServer(ctx, id, {
        sshHostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake",
      })
    }

    return getServer(ctx, id)
  }

  async function connectSeeing(serverIds?: string[]) {
    await client.close()
    const { token } = await createApiToken(ctx, {
      name: "Claude",
      allowAllServers: serverIds === undefined,
      serverIds: serverIds ?? [],
    })
    const scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await buildGatewayServer(scope, await loadGatewayServers(scope), {
      lookupHost: async () => ["203.0.114.7"],
    }).connect(serverSide)
    client = new Client({ name: "test", version: "1.0.0" })
    await client.connect(clientSide)
  }

  /** What launchService makes, as rows: the service, on its definition. */
  const executor = {
    callTool: async () => {
      throw new Error("no call runs here")
    },
    syncTools: async () => ({
      status: "ok" as const,
      message: "",
      toolCount: 0,
    }),
    launchService: async (
      launchCtx: VaultContext,
      input: ServiceLaunchInput,
    ) => {
      launched.push(input)
      const id = `svc-${launched.length}`
      const definition = input.definitionId
        ? (await serviceOfDefinition(launchCtx, input.definitionId)).definition
        : parseServiceDefinition(input.definition)

      await db().mcpServer.create({
        data: serverCreateData(ctx, {
          id,
          vaultId: launchCtx.vaultId,
          kind: "service",
          name: `${input.name} service`,
          slug: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-service`,
          description: input.description ?? "",
          url: "pcp:service",
          definitionId: input.definitionId ?? null,
          serviceSpec: {
            create: {
              plainDefinition: JSON.stringify(definition),
              hash: serviceDefinitionHash(ctx, definition),
              hostId: input.hostId,
              engine: "docker",
              containerName: `pcp-${id}`,
              env: JSON.stringify(input.env),
            },
          },
        }),
      })
      await ensureDefinition(ctx, id)

      return {
        id,
        registeredId: null,
        registeredKind: null,
        message: `${input.name} is running.`,
      }
    },
  }

  async function approve(secretValue?: string) {
    const row = await db().permissionRequest.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    })

    return decidePermission(
      ctx,
      row.id,
      "allow_once",
      { publicUrl: PUBLIC_URL, ...(secretValue ? { secretValue } : {}) },
      executor,
    )
  }

  beforeEach(() => {
    launched = []
  })

  it("asks to launch one, showing everything it runs, and launches nothing yet", async () => {
    const host = await sshServer()
    await connectSeeing()

    const asked = await register({
      name: "Docling",
      kind: "service",
      description: "Documents to Markdown.",
      service: DEFINITION,
      ssh_server: host.slug,
      publish_ports: [{ container: 5001, host: 8001 }],
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
      note: "On the build box.",
    })

    expect(asked.isError).toBe(false)
    expect(asked.text).toContain('the value of the secret "Docling key"')
    const view = await shown()
    expect(view.kind).toBe("service_change")
    expect(view.title).toBe("Launch the service Docling on Build box?")
    expect(view.lines).toEqual(
      expect.arrayContaining([
        "Runs on your SSH server Build box (build.ada-home.net), with the Docker or Podman there",
        `Image: ${IMAGE}`,
        "Updates from: ghcr.io/docling-project/docling-serve-cpu:latest, when you update it on its page",
        "Published on 127.0.0.1: 8001 → 5001 (the SSH server's own loopback: PCP reaches it through the SSH connection)",
        'Variable DOCLING_SERVE_API_KEY: a new secret, saved as "Docling key", which you enter here when you agree',
        "Variable DOCLING_SERVE_ENABLE_UI: its fixed value, false",
        "Named volumes (never a folder of the server): cache at /opt/cache",
        "Health check: GET /health on port 5001",
        "PCP adds an API endpoint from /openapi.json on port 5001, sending DOCLING_SERVE_API_KEY's secret in X-Api-Key",
        "Your note on it, which every assistant that sees it reads as yours:\nOn the build box.",
      ]),
    )
    expect(view.warning).toMatch(/Only agree if you trust the image/)
    expect(view.full?.[0]?.text).toContain(IMAGE)
    expect(view.secretToEnter).toMatchObject({
      name: "Docling key",
      exists: false,
    })
    expect(view.decisions.map((decision) => decision.label)).toEqual([
      "Launch it",
      "Not now",
    ])
    expect(await db().mcpServer.count({ where: { kind: "service" } })).toBe(0)
  })

  it("shows a publish address on the SSH server's network as reaching the service", async () => {
    const host = await sshServer()
    await connectSeeing()

    await register({
      name: "Docling",
      service: DEFINITION,
      ssh_server: host.slug,
      publish_address: "0.0.0.0",
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
    })

    expect((await shown()).lines).toContain(
      "Published on 0.0.0.0: 5001 → 5001 (every address of the SSH server: anything on its network reaches it)",
    )
  })

  it("launches exactly what was shown on approval, with the secret the owner typed", async () => {
    const host = await sshServer()
    await connectSeeing()
    await register({
      name: "Docling",
      service: DEFINITION,
      ssh_server: host.slug,
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
    })

    const done = await approve("dk-typed-by-the-owner")

    expect(done.isError).not.toBe(true)
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "Docling key"),
    })
    expect(launched).toEqual([
      expect.objectContaining({
        name: "Docling",
        hostId: host.id,
        // The SSH server's own loopback unless the assistant names another.
        publish: {
          address: "127.0.0.1",
          ports: [{ container: 5001, host: 5001 }],
        },
        env: { DOCLING_SERVE_API_KEY: secret.id },
        definition: expect.objectContaining({ image: IMAGE }),
      }),
    ])
    expect(JSON.stringify(done)).toContain(
      'The service is \\"docling-service\\"',
    )
    expect(JSON.stringify(done)).not.toContain("dk-typed-by-the-owner")
  })

  it("keeps the secret the owner typed when the launch fails, and says so", async () => {
    const host = await sshServer()
    await connectSeeing()
    await register({
      name: "Docling",
      service: DEFINITION,
      ssh_server: host.slug,
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
    })
    const launch = executor.launchService
    executor.launchService = async () => {
      throw new PcpError(
        "upstream",
        "Build box did not start pcp-docling: port is already allocated",
      )
    }

    try {
      const done = await approve("dk-typed-by-the-owner")

      expect(done.isError).toBe(true)
      expect(JSON.stringify(done)).toContain("port is already allocated")
      expect(JSON.stringify(done)).toContain(
        'The secret you entered is kept in PCP as \\"Docling key\\"',
      )
      expect(
        await db().secret.count({ where: secretNameWhere(ctx, "Docling key") }),
      ).toBe(1)
    } finally {
      executor.launchService = launch
    }
  })

  it("reuses a secret the owner stored, by its name", async () => {
    const host = await sshServer()
    const key = await createSecret(ctx, { name: "Docling key", value: "k" })
    await connectSeeing()
    await register({
      name: "Docling",
      service: DEFINITION,
      ssh_server: host.slug,
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
    })

    expect((await shown()).lines).toContain(
      'Variable DOCLING_SERVE_API_KEY: your secret "Docling key"',
    )
    await approve()
    expect(launched[0]!.env).toEqual({ DOCLING_SERVE_API_KEY: key.id })
  })

  it("shows the header an MCP server it registers sends, and needs that variable's secret named", async () => {
    const host = await sshServer()
    await connectSeeing()
    const mcp = {
      ...DEFINITION,
      env: [{ name: "MCP_TOKEN" }],
      registers: {
        kind: "mcp",
        port: 5001,
        path: "/mcp",
        auth: {
          env: "MCP_TOKEN",
          header: "Authorization",
          template: "Bearer {{secret}}",
        },
      },
    }

    expect(
      (
        await register({
          name: "Docs MCP",
          service: mcp,
          ssh_server: host.slug,
        })
      ).text,
    ).toMatch(
      /The MCP server sends MCP_TOKEN's secret in Authorization: name it in env_secrets/,
    )
    expect(await db().permissionRequest.count()).toBe(0)

    await register({
      name: "Docs MCP",
      service: mcp,
      ssh_server: host.slug,
      env_secrets: [{ name: "MCP_TOKEN", secret: "Docs MCP token" }],
    })
    expect((await shown()).lines).toContain(
      "PCP adds an MCP server at /mcp on port 5001, sending MCP_TOKEN's secret in Authorization",
    )

    await approve("mcp-token-typed-by-the-owner")
    const secret = await db().secret.findFirstOrThrow({
      where: secretNameWhere(ctx, "Docs MCP token"),
    })
    expect(launched[0]!.env).toEqual({ MCP_TOKEN: secret.id })
    expect(launched[0]!.definition).toMatchObject({ registers: mcp.registers })
  })

  it("is refused before the owner is asked when it cannot run as proposed", async () => {
    const host = await sshServer()
    const unpinned = await sshServer("Spare box", false)
    await connectSeeing()
    const propose = (change: Record<string, unknown>) =>
      register({
        name: "Docling",
        service: DEFINITION,
        ssh_server: host.slug,
        env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
        ...change,
      })

    expect(
      (await propose({ service: { ...DEFINITION, image: "docling:latest" } }))
        .text,
    ).toMatch(/pinned by digest/)
    const unpinned_ = Object.fromEntries(
      Object.entries(DEFINITION).filter(
        ([key]) => key !== "image" && key !== "source",
      ),
    )
    expect(
      (
        await propose({
          service: {
            ...unpinned_,
            build: {
              repository: "kaperkunde/docling",
              commit: "a".repeat(40),
              containerfile: "Containerfile",
            },
          },
        })
      ).text,
    ).toMatch(
      /built from a repository on the SSH server, which only the owner sets up/,
    )
    expect((await propose({ ssh_server: "nowhere" })).text).toMatch(
      /No SSH server called nowhere that this token sees/,
    )
    expect((await propose({ ssh_server: unpinned.slug })).text).toMatch(
      /has not pinned Spare box's host key/,
    )
    expect((await propose({ publish_address: "box; id" })).text).toMatch(
      /IP address/,
    )
    expect((await propose({ env_secrets: [] })).text).toMatch(
      /needs DOCLING_SERVE_API_KEY/,
    )
    expect(
      (
        await propose({
          env_secrets: [
            { name: "DOCLING_SERVE_API_KEY", secret: "Docling key" },
            { name: "DOCLING_SERVE_ENABLE_UI", secret: "Another new one" },
          ],
        })
      ).text,
    ).toMatch(/Only one new secret/)
    expect(
      (await propose({ env_secrets: [{ name: "NOPE", secret: "x" }] })).text,
    ).toMatch(/no variable called NOPE/)
    expect(
      (await propose({ publish_ports: [{ container: 9, host: 9 }] })).text,
    ).toMatch(/does not publish/)
    expect((await propose({ url: "https://x.example" })).text).toMatch(
      /takes none of url/,
    )
    expect(await db().permissionRequest.count()).toBe(0)
  })

  it("does not reach an SSH server the token does not see", async () => {
    const host = await sshServer()
    const other = await createServer(ctx, {
      name: "Linear",
      url: "https://mcp.linear.example/mcp",
      authType: "none",
    })
    await connectSeeing([other.id])

    const asked = await register({
      name: "Docling",
      service: DEFINITION,
      ssh_server: host.slug,
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
    })

    expect(asked.isError).toBe(true)
    expect(asked.text).toMatch(/that this token sees/)
  })

  it("launches another of a service definition it sees, only while that is as shown", async () => {
    const host = await sshServer()
    await createSecret(ctx, { name: "Docling key", value: "k" })
    await connectSeeing()
    await register({
      name: "Docling",
      service: DEFINITION,
      ssh_server: host.slug,
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
    })
    await approve()
    const first = await getServer(ctx, "svc-1")
    await connectSeeing()

    expect(
      (
        await register({
          name: "Docling two",
          definition: first.slug,
          service: DEFINITION,
          ssh_server: host.slug,
        })
      ).text,
    ).toMatch(/leave service out/)

    const asked = await register({
      name: "Docling two",
      definition: first.slug,
      ssh_server: host.slug,
      publish_ports: [{ container: 5001, host: 5002 }],
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
    })
    expect(asked.isError).toBe(false)
    expect((await shown()).lines).toEqual(
      expect.arrayContaining([
        `Another service of Docling service, beside ${first.slug}: it shares their definition, so a change to it changes every one of them`,
      ]),
    )

    await approve()
    expect(launched[1]).toMatchObject({
      name: "Docling two",
      definitionId: first.definitionId,
    })
    expect(launched[1]!.definition).toBeUndefined()

    // Asked again, then the definition changes: nothing is launched.
    await register({
      name: "Docling three",
      definition: first.slug,
      ssh_server: host.slug,
      publish_ports: [{ container: 5001, host: 5003 }],
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
    })
    await writeServiceDefinition(ctx, first.id, {
      ...parseServiceDefinition(DEFINITION),
      image: `ghcr.io/docling-project/docling-serve-cpu@sha256:${"d".repeat(64)}`,
    })
    expect(JSON.stringify(await approve())).toMatch(/has changed since/)
    expect(launched).toHaveLength(2)
  })

  it("shows a files folder it names, and the tools that come with it", async () => {
    const host = await sshServer()
    await connectSeeing()

    const asked = await register({
      name: "Docling",
      kind: "service",
      service: {
        ...DEFINITION,
        files: { volume: "cache", path: "/opt/cache/in" },
      },
      ssh_server: host.slug,
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
    })

    expect(asked.isError).toBe(false)
    const view = await shown()
    expect(view.lines).toEqual(
      expect.arrayContaining([
        "Files folder: /opt/cache/in, in its volume cache: its put_file copies a file an assistant has into it, and get_file copies one out",
        "Its tools (status, logs, start, stop, restart, put_file, get_file) and what it adds ask you first, for every token, as a new server's do",
      ]),
    )
    expect(view.full?.[0]?.text).toContain('"files"')

    const outside = await register({
      name: "Docling two",
      kind: "service",
      service: { ...DEFINITION, files: { volume: "data", path: "/data" } },
      ssh_server: host.slug,
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
    })
    expect(outside.isError).toBe(true)
    expect(outside.text).toMatch(/not one of the service's volumes/)
  })

  it("takes tool_access for what it registers, by name, and refuses it for a service that registers nothing", async () => {
    const host = await sshServer()
    await connectSeeing()

    const asked = await register({
      name: "Docling",
      service: DEFINITION,
      ssh_server: host.slug,
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
      tool_access: [{ tools: ["convert_*"], access: "allowed", tier: "read" }],
    })

    expect(asked.isError).toBe(false)
    const view = await shown()
    expect(view.proposedAccess).toEqual({
      tools: null,
      rules: [{ pattern: "convert_*", access: "allowed", tier: "read" }],
      tokenName: "Claude",
    })
    expect(view.lines).toContain(
      "Its tools (status, logs, start, stop, restart) and what it adds ask you first, for every token, as a new server's do, except where you set a level below for what it adds",
    )

    const none = await register({
      name: "Plain",
      service: { ...DEFINITION, registers: { kind: "none" } },
      ssh_server: host.slug,
      env_secrets: [{ name: "DOCLING_SERVE_API_KEY", secret: "Docling key" }],
      tool_access: [{ access: "allowed" }],
    })

    expect(none.isError).toBe(true)
    expect(none.text).toMatch(/this one registers nothing/)
  })
})

describe("levels and tiers proposed with it (tool_access)", () => {
  const NO_SYNC = {
    callTool: async () => {
      throw new Error("no call runs here")
    },
    syncTools: async () => ({
      status: "ok" as const,
      message: "",
      toolCount: 0,
    }),
  }
  const ZOO = JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Zoo" },
    servers: [{ url: "https://api.example.com/v1" }],
    paths: {
      "/pets": {
        get: { operationId: "listPets" },
        post: { operationId: "addPet" },
      },
      "/pets/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        delete: { operationId: "deletePet" },
      },
    },
  })

  async function tokenId() {
    const rows = await db().apiToken.findMany({ select: TOKEN_NAME_SELECT })
    return rows.find((row) => tokenName(ctx, row) === "Claude")!.id
  }

  async function decide(access?: unknown) {
    const row = await db().permissionRequest.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    })

    return decidePermission(
      ctx,
      row.id,
      "allow_once",
      { publicUrl: PUBLIC_URL, ...(access !== undefined ? { access } : {}) },
      NO_SYNC,
    )
  }

  async function levels(serverId: string) {
    return (
      await db().apiTokenToolAccess.findMany({
        where: { tokenId: await tokenId(), serverId },
        orderBy: { toolName: "asc" },
      })
    ).map((row) => [row.toolName, row.access])
  }

  it("shows an API's proposal per tool, filled in, and says whose levels they are", async () => {
    const asked = await register({
      name: "Zoo",
      openapi_schema: ZOO,
      tool_access: [
        { tools: ["list*"], access: "allowed", tier: "read" },
        { tools: ["deletePet"], access: "blocked" },
      ],
    })

    expect(asked.isError).toBe(false)
    const view = await shown()
    expect(view.proposedAccess).toEqual({
      tools: [
        { name: "listPets", title: null },
        { name: "addPet", title: null },
        { name: "deletePet", title: null },
      ],
      rules: [
        { pattern: "listPets", access: "allowed", tier: "read" },
        { pattern: "deletePet", access: "blocked" },
      ],
      tokenName: "Claude",
    })
    expect(view.lines.join("\n")).toContain(
      'The assistant proposes levels for 2 tools: 1 to Allowed, 1 to Blocked; tiers for 1 tool: 1 to Read. They are filled in below: the levels are for the token "Claude" only',
    )
    // Nothing exists, and no level is written, before the owner agrees.
    expect(await db().mcpServer.count({ where: { kind: "openapi" } })).toBe(0)
    expect(await db().apiTokenToolAccess.count()).toBe(0)
  })

  it("writes on the yes only what the owner left on the page: levels for the token, tiers on the definition", async () => {
    await register({
      name: "Zoo",
      openapi_schema: ZOO,
      tool_access: [{ access: "allowed" }],
    })

    const done = await decide([
      { pattern: "listPets", access: "allowed", tier: "read" },
      { pattern: "addPet", access: "ask" },
    ])

    expect(done.isError).not.toBe(true)
    const server = await db().mcpServer.findFirstOrThrow({
      where: { kind: "openapi" },
    })
    expect(await levels(server.id)).toEqual([["listPets", "allowed"]])
    expect(
      await db().toolTier.findMany({
        where: { definitionId: server.definitionId },
        select: { toolName: true, tier: true },
      }),
    ).toEqual([{ toolName: "listPets", tier: "read" }])
    expect(JSON.stringify(done)).toContain(
      "The owner set this token's level for 2 tools",
    )
  })

  it("writes nothing when the yes carries no levels, as before", async () => {
    await register({
      name: "Zoo",
      openapi_schema: ZOO,
      tool_access: [{ access: "allowed" }],
    })

    const done = await decide()

    expect(done.isError).not.toBe(true)
    expect(await db().apiTokenToolAccess.count()).toBe(0)
    expect(JSON.stringify(done)).toContain(
      "They ask the owner the first time they are used",
    )
  })

  it("refuses an owner's level for a tool the request does not have, and leaves it open", async () => {
    await register({
      name: "Zoo",
      openapi_schema: ZOO,
      tool_access: [{ access: "allowed" }],
    })

    const done = await decide([{ pattern: "dropTables", access: "allowed" }])

    expect(done.isError).toBe(true)
    expect(JSON.stringify(done)).toMatch(/not one of its tools/)
    expect(await db().mcpServer.count({ where: { kind: "openapi" } })).toBe(0)
    expect((await shown()).status).toBe("pending")
  })

  it("refuses a name the API does not have before the owner is asked", async () => {
    const asked = await register({
      name: "Zoo",
      openapi_schema: ZOO,
      tool_access: [{ tools: ["feedPets"], access: "allowed" }],
    })

    expect(asked.isError).toBe(true)
    expect(asked.text).toMatch(/The API Zoo has no tool matching "feedPets"/)
    expect(await db().permissionRequest.count()).toBe(0)
  })

  it("takes a mail account's fixed tools by name, as the account will have them", async () => {
    const asked = await register({
      name: "Personal mail",
      kind: "imap",
      url: "mail.example.com",
      auth_type: "basic",
      username: "ada@example.com",
      secret: "Mail password",
      read_only: true,
      tool_access: [{ tools: ["search_emails", "get_*"], access: "allowed" }],
    })

    expect(asked.isError).toBe(false)
    const view = await shown()
    expect(view.proposedAccess?.tools?.map((tool) => tool.name)).not.toContain(
      "send_email",
    )
    expect(view.proposedAccess?.rules.map((rule) => rule.pattern)).toEqual(
      expect.arrayContaining(["search_emails", "get_email"]),
    )

    const sending = await register({
      name: "Personal mail",
      kind: "imap",
      url: "mail.example.com",
      auth_type: "basic",
      username: "ada@example.com",
      secret: "Mail password",
      read_only: true,
      tool_access: [{ tools: ["send_email"], access: "allowed" }],
    })

    expect(sending.isError).toBe(true)
    expect(sending.text).toMatch(/no tool matching "send_email"/)
  })

  it("keeps an MCP server's names as patterns, saved with the yes and applied once its tools are read", async () => {
    const asked = await register({
      name: "Linear",
      url: "https://mcp.linear.example/mcp",
      tool_access: [{ tools: ["search_*"], access: "allowed", tier: "read" }],
    })

    expect(asked.isError).toBe(false)
    const view = await shown()
    expect(view.proposedAccess).toEqual({
      tools: null,
      rules: [{ pattern: "search_*", access: "allowed", tier: "read" }],
      tokenName: "Claude",
    })
    expect(view.lines.join("\n")).toContain(
      "The assistant proposes levels and tiers by tool name, as its tools are not known until PCP first reads them: search_* → Allowed, Read.",
    )

    const done = await decide([
      { pattern: "search_*", access: "allowed" },
      { pattern: "get_issue", tier: "read" },
    ])

    expect(done.isError).not.toBe(true)
    expect(JSON.stringify(done)).toContain(
      "they apply once, to the tools PCP first reads from it",
    )
    const server = await db().mcpServer.findFirstOrThrow({
      where: { kind: "mcp" },
    })
    expect(JSON.parse(server.pendingAccess!)).toEqual({
      tokenId: await tokenId(),
      rules: [
        { pattern: "search_*", access: "allowed" },
        { pattern: "get_issue", tier: "read" },
      ],
    })
  })
})
