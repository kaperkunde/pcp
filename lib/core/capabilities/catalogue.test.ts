import { randomUUID } from "node:crypto"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import { chromiumExecutable } from "../browser/executable"
import type { VaultContext } from "../context"
import { db } from "../db"
import { writeEmbeddingsConfig } from "../embeddings/config"
import {
  buildGatewayServer,
  loadGatewayServers,
  SET_UP_RULE,
  STANDING_LEAD,
  type GatewayScope,
} from "../gateway"
import { canonicalJson } from "../permission-rules"
import { createServer } from "../servers"
import { sealedServiceOwn } from "../services/own-values"
import { sealedServiceDefinition } from "../spec-rows"
import { scratchDatabase } from "../test-db"
import { writeToolAccess } from "../tool-access"
import { setupVault } from "../vault"
import {
  CATALOGUE,
  CATALOGUE_IDS,
  catalogueNamed,
  entriesOfImages,
  imageName,
  LIMITED_TOKEN_NOTE,
  pluginEntry,
} from "./catalogue"
import { setUpEntries } from "./catalogue-state"
import { itemOffers } from "./setup"
import { CAPABILITIES } from "./list"

// The catalogue (#163): what PCP can set up when the owner asks for it in a
// conversation, named by search while the token has not got it.

vi.mock("../browser/executable", () => ({
  chromiumExecutable: vi.fn(async () => null),
}))

const PUBLIC_URL = "https://pcp.example"
const DIGEST = `sha256:${"a".repeat(64)}`

describe("the catalogue", () => {
  it("has every entry once, each saying what it does and takes", () => {
    expect(CATALOGUE.map((entry) => entry.id)).toEqual([...CATALOGUE_IDS])

    for (const entry of CATALOGUE) {
      expect(entry.title, entry.id).not.toBe("")
      expect(entry.does, entry.id).toMatch(/\.$/)
      expect(entry.takes, entry.id).toMatch(/\.$/)
      expect(entry.how, entry.id).toMatch(/\.$/)
      expect(entry.page, entry.id).toMatch(/^\/[a-z]/)
      expect(entry.queryWords.length, entry.id).toBeGreaterThan(0)

      if (entry.kind === "builtin") {
        expect(
          (entry.serverKinds?.length ?? 0) > 0 || entry.account !== undefined,
          entry.id,
        ).toBe(true)
      } else {
        expect(entry.item, entry.id).not.toBeUndefined()
        expect(
          (entry.images?.length ?? 0) > 0 ||
            entry.setting !== undefined ||
            entry.item?.kind === "endpoint",
          entry.id,
        ).toBe(true)
      }
    }
  })

  it("names the owner's first sentences", () => {
    const named = (query: string) =>
      catalogueNamed(query).map((entry) => entry.id)

    expect(named("I'd like to add my Gmail")).toEqual(["mail"])
    expect(named("Can you connect to my printer?")).toEqual(["ssh"])
    expect(
      named(
        "I'd like to set up an SSH connection to my server so I can host things",
      ),
    ).toEqual(["ssh"])
    expect(named("transcribe this voice memo")).toEqual(["whisper"])
    expect(named("go out through my VPN")).toEqual(["vpn_exit"])
    expect(named("make a picture for the blog post")).toEqual(["images"])
    expect(named("what is the weather")).toEqual([])
  })

  it("has a page for each common item: its capability's, or /plugins/<id>", () => {
    for (const entry of CATALOGUE.filter((e) => e.kind === "common_item")) {
      if (entry.capability) {
        expect(entry.page).toBe(`/plugins/${entry.capability}`)
        expect(
          CAPABILITIES.find((cap) => cap.id === entry.capability)?.items,
        ).toContain(entry.item)
      } else {
        expect(entry.page).toBe(`/plugins/${entry.id}`)
        expect(pluginEntry(entry.id)).toBe(entry)
      }
    }

    // The capabilities keep their own page.
    expect(pluginEntry("pdf_edit")?.id).toBe("pdf")
    expect(pluginEntry("mail")).toBeNull()
  })

  it("launches a common item from its page, never retyped into register_server", () => {
    for (const entry of CATALOGUE.filter((e) => e.item)) {
      expect(entry.how, entry.id).not.toContain("register_server")
      expect(entry.how, entry.id).toMatch(/link to its page/)
    }
  })

  it("never offers an assistant to propose an exit or an SSH server", () => {
    for (const id of ["vpn_exit", "ssh", "google"]) {
      const entry = CATALOGUE.find((e) => e.id === id)!
      expect(entry.ownerOnly, id).toBe(true)
      expect(entry.how, id).toMatch(/^Only the owner/)
    }
  })

  it("says once that Whisper has no common item yet, in its how", () => {
    const whisper = CATALOGUE.find((entry) => entry.id === "whisper")!
    expect(whisper.takes).not.toMatch(/common item/i)
    expect(whisper.how).toContain("PCP's common items have none yet")
  })
})

describe("an image's name", () => {
  it("is the repository's last part, without tag or digest", () => {
    expect(imageName(`ghcr.io/kaperkunde/pdf-mcp-server@${DIGEST}`)).toBe(
      "pdf-mcp-server",
    )
    expect(imageName("ghcr.io/docling-project/docling-serve-cpu:latest")).toBe(
      "docling-serve-cpu",
    )
    expect(imageName(`docker.io/qmcgaw/gluetun@${DIGEST}`)).toBe("gluetun")
    expect(imageName("localhost:5000/team/Whisper:1")).toBe("whisper")
    expect(imageName("gluetun")).toBe("gluetun")
  })

  it("matches an entry's images whole, never a part of one", () => {
    const ids = (images: string[]) =>
      entriesOfImages(images).map((entry) => entry.id)

    // PCP's common items, as they stand in kaperkunde/pcp-gg-common.
    expect(
      ids([
        `ghcr.io/kaperkunde/pdf-mcp-server@${DIGEST}`,
        `ghcr.io/docling-project/docling-serve-cpu@${DIGEST}`,
        "ghcr.io/kaperkunde/claude-sessions-mcp:latest",
        `docker.io/qmcgaw/gluetun@${DIGEST}`,
        `ghcr.io/kaperkunde/bunq-mcp@${DIGEST}`,
        "docker.io/onerahmet/openai-whisper-asr-webservice:latest",
      ]),
    ).toEqual([
      "pdf",
      "documents",
      "claude_sessions",
      "vpn_exit",
      "bunq",
      "whisper",
    ])

    // Neighbours with a name of their own are not those items.
    expect(
      ids([
        "docker.io/qdm12/gluetun-webui:latest",
        "ghcr.io/someone/whisper-ui:1",
        "ghcr.io/someone/my-pdf-mcp-server-fork:2",
        "ghcr.io/kaperkunde/pdf-mcp-server-extras:1",
      ]),
    ).toEqual([])
  })
})

let cleanup: () => Promise<void>
let ctx: VaultContext
let scope: GatewayScope

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
  scope = await tokenScope({ allowAllServers: true })
  vi.mocked(chromiumExecutable).mockResolvedValue(null)
})

afterEach(async () => {
  await cleanup()
})

async function tokenScope(
  reach: { allowAllServers: true } | { serverIds: string[] },
): Promise<GatewayScope> {
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: "allowAllServers" in reach,
    serverIds: "serverIds" in reach ? reach.serverIds : [],
  })
  return { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
}

/** A server of this kind in the vault, as the owner would have added it. */
async function serverOfKind(kind: string): Promise<string> {
  const { id } = await createServer(ctx, {
    name: `A ${kind} ${randomUUID().slice(0, 6)}`,
    url: `https://${kind}.example.com/mcp`,
    authType: "none",
  })
  await db().mcpServer.update({ where: { id }, data: { kind } })
  return id
}

/** A service running this image, as a launch stores it (its spec sealed). */
async function serviceOf(image: string): Promise<string> {
  const id = await serverOfKind("service")
  const definition = {
    image,
    ports: [{ container: 8000 }],
    registers: { kind: "none" },
  }

  await db().serviceSpec.create({
    data: {
      serverId: id,
      ...sealedServiceDefinition(
        ctx,
        id,
        JSON.stringify(definition),
        canonicalJson(definition),
      ),
      engine: "docker",
      ...sealedServiceOwn(ctx, id, {
        containerName: `pcp-${id.slice(0, 8)}`,
        publish: "{}",
        values: "{}",
      }),
    },
  })

  return id
}

/**
 * The Claude Code sessions service, launched: its definition declares a
 * sign-in (services/signin.ts) and registers an MCP server with one tool.
 * Ids of the service and of the server it registered.
 */
async function signingService({
  signin = true,
}: { signin?: boolean } = {}): Promise<{
  serviceId: string
  serverId: string
  slug: string
}> {
  const serviceId = await serverOfKind("service")
  const name = `sessions ${randomUUID().slice(0, 6)}`
  const { id: serverId } = await createServer(ctx, {
    name,
    url: "https://sessions.example.com/mcp",
    authType: "none",
  })
  await db().mcpTool.create({
    data: {
      id: randomUUID(),
      serverId,
      plainName: "list_sessions",
      plainDescription: "List the cloud coding sessions on the account.",
      plainInputSchema: JSON.stringify({
        type: "object",
        properties: {},
        additionalProperties: false,
      }),
      annotations: JSON.stringify({ readOnlyHint: true }),
    },
  })
  const definition = {
    image: `ghcr.io/kaperkunde/claude-sessions-mcp@${DIGEST}`,
    ports: [{ container: 8080 }],
    registers: { kind: "mcp", port: 8080, path: "/mcp" },
    ...(signin
      ? {
          signin: {
            style: "paste_code",
            status: { tool: "login_status", signed_in: "signed_in" },
            start: { tool: "login_start", url: "url" },
            finish: { tool: "login_finish", argument: "code" },
          },
        }
      : {}),
  }

  await db().serviceSpec.create({
    data: {
      serverId: serviceId,
      registeredId: serverId,
      ...sealedServiceDefinition(
        ctx,
        serviceId,
        JSON.stringify(definition),
        canonicalJson(definition),
      ),
      engine: "docker",
      ...sealedServiceOwn(ctx, serviceId, {
        containerName: `pcp-${serviceId.slice(0, 8)}`,
        publish: "{}",
        values: "{}",
      }),
    },
  })

  const slug = (await loadGatewayServers(scope)).find(
    (server) => server.id === serverId,
  )!.slug

  return { serviceId, serverId, slug }
}

/** What the token behind `scope` has, as search works it out. */
async function tokenHas(
  hasProvider: () => Promise<boolean> = async () => false,
) {
  return setUpEntries(ctx, await loadGatewayServers(scope), hasProvider)
}

async function search(
  args: Record<string, unknown>,
  as: GatewayScope = scope,
): Promise<string> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(as, await loadGatewayServers(as)).connect(serverSide)
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(clientSide)
  const result = (await client.callTool({
    name: "search",
    arguments: args,
  })) as CallToolResult
  await client.close()

  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

describe("what a token has", () => {
  it("is read from the servers and services it reaches", async () => {
    expect([...(await tokenHas())]).toEqual([])

    await serverOfKind("imap")
    await serverOfKind("ssh")
    await serviceOf(`ghcr.io/kaperkunde/pdf-mcp-server@${DIGEST}`)
    await serviceOf(
      `docker.io/onerahmet/openai-whisper-asr-webservice@${DIGEST}`,
    )
    await serviceOf(`docker.io/qdm12/gluetun-webui@${DIGEST}`)

    expect([...(await tokenHas())].sort()).toEqual([
      "mail",
      "pdf",
      "ssh",
      "whisper",
    ])
  })

  it("leaves out what the token does not reach", async () => {
    const mail = await serverOfKind("imap")
    await serviceOf(`ghcr.io/kaperkunde/pdf-mcp-server@${DIGEST}`)
    const ssh = await serverOfKind("ssh")

    scope = await tokenScope({ serverIds: [ssh] })
    expect([...(await tokenHas())]).toEqual(["ssh"])

    scope = await tokenScope({ serverIds: [mail] })
    expect([...(await tokenHas())]).toEqual(["mail"])
  })

  it("has a capability's entry when a provider of it is among its tools", async () => {
    const has = await tokenHas(async () => true)
    expect(has.has("pdf")).toBe(true)
    expect(has.has("documents")).toBe(true)
    expect(has.has("claude_sessions")).toBe(false)
  })

  it("offers Voyage 4 nano for search by meaning, and Text Embeddings Inference after it", () => {
    const entry = CATALOGUE.find((item) => item.id === "embeddings")
    expect(entry?.item?.name).toBe("voyage-4-nano")
    expect(entry?.alternatives?.map((item) => item.name)).toEqual([
      "text-embeddings-inference",
    ])
  })

  it("has search by meaning only when the owner chose a provider", async () => {
    await serviceOf(`ghcr.io/huggingface/text-embeddings-inference@${DIGEST}`)
    expect((await tokenHas()).has("embeddings")).toBe(false)

    await writeEmbeddingsConfig(ctx, {
      provider: "openai",
      url: "https://embeddings.example/v1",
      model: "small",
      secretId: null,
      embed: { tools: true, skills: false, memories: false },
    })
    expect((await tokenHas()).has("embeddings")).toBe(true)
  })

  it("has Google when a server bound to the owner's Google sign-in is among its tools", async () => {
    const other = await serverOfKind("mcp")
    const account = await db().oAuthAccount.create({
      data: {
        id: "google-account",
        vaultId: ctx.vaultId,
        provider: "google",
        meta: new Uint8Array([1]),
      },
    })

    expect((await tokenHas()).has("google")).toBe(false)

    const google = await serverOfKind("mcp")
    await db().mcpServer.update({
      where: { id: google },
      data: { authType: "google", accountId: account.id },
    })
    expect((await tokenHas()).has("google")).toBe(true)

    // Not for a token that does not reach one: nothing is learnt of the rest.
    scope = await tokenScope({ serverIds: [other] })
    expect((await tokenHas()).has("google")).toBe(false)
  })

  it("has the browser only once Chromium is on this machine", async () => {
    await serverOfKind("browser")
    expect((await tokenHas()).has("browser")).toBe(false)

    vi.mocked(chromiumExecutable).mockResolvedValue("/usr/bin/chromium")
    expect((await tokenHas()).has("browser")).toBe(true)
  })
})

describe("an entry's page", () => {
  it("links the sign-in page of a service it runs that signs in", async () => {
    const item = pluginEntry("claude_sessions")!.item!
    const { serviceId, serverId } = await signingService()

    expect((await itemOffers(ctx, [item])).running).toEqual([
      expect.objectContaining({ id: serviceId, signIn: serverId }),
    ])
  })

  it("links none for a service that declares no sign-in", async () => {
    const item = pluginEntry("claude_sessions")!.item!
    const { serviceId } = await signingService({ signin: false })

    expect((await itemOffers(ctx, [item])).running).toEqual([
      expect.objectContaining({ id: serviceId, signIn: null }),
    ])
  })
})

describe("search", () => {
  it("says what PCP can set up for what the owner asked, with its page", async () => {
    const text = await search({ query: "I'd like to add my Gmail" })

    expect(text).toContain(
      "can set up: A mail account — Reads, searches, files, drafts and sends mail",
    )
    expect(text).toContain("It takes: The mail server's address")
    expect(text).toContain("register_server (kind imap")
    expect(text).toContain(
      `[Add a mail account in PCP](${PUBLIC_URL}/servers/mail/new)`,
    )
    // A token that reaches every server is not told to ask for access.
    expect(text).not.toContain(LIMITED_TOKEN_NOTE)
  })

  it("sends the owner to the Google page for Google, which only they set up", async () => {
    const text = await search({ query: "connect my Google Drive" })

    expect(text).toContain("can set up: Google Workspace")
    expect(text).toContain("Only the owner sets it up")
    expect(text).not.toContain("register_server (kind")
    expect(text).toContain(
      `[Connect Google in PCP](${PUBLIC_URL}/servers/google)`,
    )
    // Gmail alone still means a mail account, as before.
    expect(await search({ query: "I'd like to add my Gmail" })).not.toContain(
      "can set up: Google Workspace",
    )
  })

  it("tells a limited token the owner may have it, out of its reach", async () => {
    // The vault has a mail account; this token reaches only the SSH server.
    await serverOfKind("imap")
    const ssh = await serverOfKind("ssh")
    const limited = await tokenScope({ serverIds: [ssh] })

    const text = await search({ query: "I'd like to add my Gmail" }, limited)

    expect(text).toContain("can set up: A mail account")
    expect(text).toContain(LIMITED_TOKEN_NOTE)

    // The same words whether or not the vault has one: nothing is learnt.
    await db().mcpServer.deleteMany({ where: { kind: "imap" } })
    expect(await search({ query: "I'd like to add my Gmail" }, limited)).toBe(
      text,
    )
  })

  it("says nothing of what the token has", async () => {
    await serverOfKind("ssh")

    const text = await search({ query: "Can you connect to my printer?" })

    expect(text).not.toContain("can set up:")
  })

  it("leaves a capability's entry to its own not installed line", async () => {
    const text = await search({ query: "fill in a pdf form" })

    expect(text).toContain("not installed: Edit PDFs (pcp edit_pdf)")
    expect(text).not.toContain("can set up: PDF tools")
  })

  it("offers no common item for a capability another server provides", async () => {
    // A converter of the owner's own, not Docling, as Docling's API takes files.
    const { id } = await createServer(ctx, {
      name: "converter",
      url: "https://converter.example.com/mcp",
      authType: "none",
    })
    await db().mcpTool.create({
      data: {
        id: randomUUID(),
        serverId: id,
        plainName: "convert_file",
        plainDescription: "Convert documents from files to Markdown.",
        plainInputSchema: JSON.stringify({
          type: "object",
          properties: {
            files: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  $result: { type: "string" },
                  name: { type: "string" },
                  type: { type: "string" },
                },
                required: ["$result"],
                additionalProperties: false,
              },
            },
          },
          required: ["files"],
          additionalProperties: false,
        }),
        annotations: JSON.stringify({
          readOnlyHint: false,
          destructiveHint: false,
        }),
      },
    })
    await writeToolAccess(ctx, scope.tokenId, id, "convert_file", "allowed")

    const text = await search({ query: "turn this docx into text, docling" })

    expect(text).not.toContain("not installed: Convert documents")
    expect(text).not.toContain("can set up: Document conversion")
  })

  it("names a common item with its own page, launched there", async () => {
    const text = await search({ query: "my claude code sessions" })

    expect(text).toContain("can set up: Claude Code sessions")
    expect(text).toContain("launch it on their SSH server in one click")
    expect(text).not.toContain("register_server")
    expect(text).toContain(`(${PUBLIC_URL}/plugins/claude_sessions)`)
  })

  it("points to connect_account for a service that signs in, set up or hit", async () => {
    const { slug } = await signingService()
    const line = `Sign-in on ${slug}: connect_account says whether it is signed in, and hands the owner the sign-in page when not.`

    // Set up is not signed in: the entry the owner named says so.
    const named = await search({ query: "my claude code sessions" })
    expect(named).not.toContain("can set up: Claude Code sessions")
    expect(named).toContain(line)

    // A hit on one of its tools, whatever the words.
    const hit = await search({ query: "list sessions" })
    expect(hit).toContain(`tool ${slug}/list_sessions`)
    expect(hit).toContain(line)

    // Nothing named and nothing hit: no line.
    expect(await search({ query: "send an email" })).not.toContain(
      "connect_account",
    )
  })

  it("says nothing of a sign-in for a service that declares none", async () => {
    await signingService({ signin: false })

    const text = await search({ query: "my claude code sessions" })
    expect(text).not.toContain("can set up: Claude Code sessions")
    expect(text).not.toContain("connect_account")
  })

  it("says nothing of a sign-in to a token that reaches neither server", async () => {
    await signingService()
    const ssh = await serverOfKind("ssh")
    const limited = await tokenScope({ serverIds: [ssh] })

    const text = await search({ query: "my claude code sessions" }, limited)
    expect(text).toContain("can set up: Claude Code sessions")
    expect(text).not.toContain("connect_account")
  })

  it("is not narrowed to one server's tools or a kind", async () => {
    const text = await search({ query: "gmail", kind: "memory" })

    expect(text).not.toContain("can set up:")
  })

  it("lists what the token has not got once, in the standing rules", async () => {
    await serverOfKind("caldav")

    const text = await search({})
    const line = text
      .split("\n")
      .find((row) => row.startsWith("What PCP can set up"))!

    expect(line).toContain("The browser, PDF tools")
    expect(line).toContain("A mail account")
    expect(line).not.toContain("A calendar account")
    expect(line).not.toContain("some may be set up already")
    expect(text).toContain(STANDING_LEAD)
    expect(text).toContain(SET_UP_RULE)
  })

  it("lists them per token, and a limited token hears it may lack access", async () => {
    const caldav = await serverOfKind("caldav")
    const ssh = await serverOfKind("ssh")
    const limited = await tokenScope({ serverIds: [ssh] })

    const line = (await search({}, limited))
      .split("\n")
      .find((row) => row.startsWith("What PCP can set up"))!

    expect(caldav).not.toBe(ssh)
    expect(line).toContain("A calendar account")
    expect(line).not.toContain("An SSH server")
    expect(line).toContain("some may be set up already")
  })
})
