import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { CallToolResult } from "@modelcontextprotocol/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createApiToken, resolveApiToken } from "../api-tokens"
import { chromiumExecutable } from "../browser/executable"
import type { VaultContext } from "../context"
import { db } from "../db"
import {
  buildGatewayServer,
  loadGatewayServers,
  SET_UP_RULE,
  STANDING_LEAD,
  type GatewayScope,
} from "../gateway"
import { createServer } from "../servers"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import {
  CATALOGUE,
  CATALOGUE_IDS,
  catalogueNamed,
  entrySources,
  pluginEntry,
} from "./catalogue"
import { setUpEntries } from "./catalogue-state"
import { CAPABILITIES } from "./list"
import { vaultServices } from "./setup"

// The catalogue (#163): what PCP can set up when the owner asks for it in a
// conversation, named by search while the vault has not set it up.

vi.mock("../browser/executable", () => ({
  chromiumExecutable: vi.fn(async () => null),
}))

vi.mock("./setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup")>()),
  vaultServices: vi.fn(async () => []),
}))

const PUBLIC_URL = "https://pcp.example"

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
        expect(entry.serverKinds?.length, entry.id).toBeGreaterThan(0)
      } else {
        expect(entry.item, entry.id).not.toBeUndefined()
        expect(entrySources(entry).length, entry.id).toBeGreaterThan(0)
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

  it("never offers an assistant to propose an exit", () => {
    const vpn = CATALOGUE.find((entry) => entry.id === "vpn_exit")!
    expect(vpn.how).not.toContain("register_server")
    const ssh = CATALOGUE.find((entry) => entry.id === "ssh")!
    expect(ssh.how).toContain("Only the owner")
  })
})

let cleanup: () => Promise<void>
let ctx: VaultContext
let scope: GatewayScope

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({ name: "Ada", password: "correct horse battery" })
  const { token } = await createApiToken(ctx, {
    name: "Claude",
    allowAllServers: true,
  })
  scope = { ...(await resolveApiToken(token))!, publicUrl: PUBLIC_URL }
  vi.mocked(vaultServices).mockResolvedValue([])
  vi.mocked(chromiumExecutable).mockResolvedValue(null)
})

afterEach(async () => {
  await cleanup()
})

/** A server of this kind in the vault, as the owner would have added it. */
async function serverOfKind(kind: string): Promise<void> {
  const { id } = await createServer(ctx, {
    name: `A ${kind}`,
    url: `https://${kind}.example.com/mcp`,
    authType: "none",
  })
  await db().mcpServer.update({ where: { id }, data: { kind } })
}

async function search(args: Record<string, unknown>): Promise<string> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await buildGatewayServer(scope, await loadGatewayServers(scope)).connect(
    serverSide,
  )
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

describe("what the vault has set up", () => {
  it("is read from its servers, services and settings", async () => {
    expect([...(await setUpEntries(ctx))]).toEqual([])

    await serverOfKind("imap")
    await serverOfKind("ssh")
    vi.mocked(vaultServices).mockResolvedValue([
      {
        id: "s1",
        name: "PDF",
        image: "ghcr.io/kaperkunde/pdf-mcp-server@sha256:abc",
      },
      { id: "s2", name: "Speech", image: "ghcr.io/someone/whisper-asr:1" },
    ])

    expect([...(await setUpEntries(ctx))].sort()).toEqual([
      "mail",
      "pdf",
      "ssh",
      "whisper",
    ])
  })

  it("counts the browser only once Chromium is on this machine", async () => {
    await serverOfKind("browser")
    expect((await setUpEntries(ctx)).has("browser")).toBe(false)

    vi.mocked(chromiumExecutable).mockResolvedValue("/usr/bin/chromium")
    expect((await setUpEntries(ctx)).has("browser")).toBe(true)
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
  })

  it("says nothing of what the vault has set up", async () => {
    await serverOfKind("ssh")

    const text = await search({ query: "Can you connect to my printer?" })

    expect(text).not.toContain("can set up:")
  })

  it("leaves a capability's entry to its own not installed line", async () => {
    const text = await search({ query: "fill in a pdf form" })

    expect(text).toContain("not installed: Edit PDFs (pcp edit_pdf)")
    expect(text).not.toContain("can set up: PDF tools")
  })

  it("names a common item with its own page", async () => {
    const text = await search({ query: "my claude code sessions" })

    expect(text).toContain("can set up: Claude Code sessions")
    expect(text).toContain("services/claude-sessions.yaml")
    expect(text).toContain(`(${PUBLIC_URL}/plugins/claude_sessions)`)
  })

  it("is not narrowed to one server's tools or a kind", async () => {
    const text = await search({ query: "gmail", kind: "memory" })

    expect(text).not.toContain("can set up:")
  })

  it("lists what is not set up yet once, in the standing rules", async () => {
    await serverOfKind("caldav")

    const text = await search({})
    const line = text
      .split("\n")
      .find((row) => row.startsWith("What PCP can set up"))!

    expect(line).toContain("The browser, PDF tools")
    expect(line).toContain("A mail account")
    expect(line).not.toContain("A calendar account")
    expect(text).toContain(STANDING_LEAD)
    expect(text).toContain(SET_UP_RULE)
  })
})
