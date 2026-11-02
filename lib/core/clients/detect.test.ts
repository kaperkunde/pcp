import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createApiToken,
  getApiToken,
  resolveApiToken,
  setTokenClientProfile,
  type ResolvedToken,
} from "../api-tokens"
import { requestClient } from "../client-hello"
import type { VaultContext } from "../context"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import {
  CLIENT_SEEN_INTERVAL_MS,
  detectClient,
  noteClientSeen,
  parseClientSeen,
} from "./detect"
import { takeMemoryReminder } from "./sessions"

let cleanup: () => Promise<void>
let ctx: VaultContext

beforeEach(async () => {
  ;({ cleanup } = await scratchDatabase())
  ctx = await setupVault({
    name: "Ada",
    password: "correct horse battery staple",
  })
})

afterEach(async () => {
  await cleanup()
})

async function token(): Promise<{ id: string; resolved: ResolvedToken }> {
  const { id, token: value } = await createApiToken(ctx, {
    name: "Phone",
    allowAllServers: true,
  })
  return { id, resolved: (await resolveApiToken(value))! }
}

function initialize(name: string, version = "1.0"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name, version },
    },
  })
}

const LATER_CALL = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "search", arguments: { query: "mail" } },
})

describe("detectClient", () => {
  it("knows the app from its initialize, and remembers it for the requests after", async () => {
    const { resolved } = await token()

    const hello = detectClient(
      resolved,
      requestClient(initialize("claude-ai", "0.1.0"), new Headers()),
    )
    expect(hello).toMatchObject({
      name: "claude-ai",
      version: "0.1.0",
      chosen: false,
    })
    expect(hello.profile.id).toBe("claude-ai")

    // An older protocol's later request names no client.
    const later = detectClient(
      resolved,
      requestClient(LATER_CALL, new Headers()),
    )
    expect(later.profile.id).toBe("claude-ai")
    expect(later.sessionKey).toBe(hello.sessionKey)
  })

  it("knows the app from a 2026-07-28 request's _meta", async () => {
    const { resolved } = await token()
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search",
        _meta: {
          "io.modelcontextprotocol/clientInfo": {
            name: "claude-code",
            version: "2.1",
          },
        },
      },
    })

    expect(
      detectClient(resolved, requestClient(call, new Headers())).profile.id,
    ).toBe("claude-code")
  })

  it("knows the app from its headers when nothing names it", async () => {
    const { resolved } = await token()

    expect(
      detectClient(
        resolved,
        requestClient(
          LATER_CALL,
          new Headers({ "X-Anthropic-Client": "claude-ai" }),
        ),
      ).profile.id,
    ).toBe("claude-ai")
    expect(
      detectClient(resolved, requestClient(LATER_CALL, new Headers())).profile
        .id,
    ).toBe("generic")
  })

  it("answers with the owner's choice over what it detects", async () => {
    const { id, resolved } = await token()
    await setTokenClientProfile(ctx, id, "claude-code")
    const chosen = (await getApiToken(ctx, id))!

    expect(chosen.clientProfile).toBe("claude-code")

    const detected = detectClient(
      { ...resolved, clientProfile: chosen.clientProfile },
      requestClient(initialize("claude-ai"), new Headers()),
    )
    expect(detected.profile.id).toBe("claude-code")
    expect(detected.detected.id).toBe("claude-ai")
    expect(detected.chosen).toBe(true)

    await setTokenClientProfile(ctx, id, null)
    expect((await getApiToken(ctx, id))!.clientProfile).toBeNull()
    await expect(setTokenClientProfile(ctx, id, "netscape")).rejects.toThrow(
      /not a client profile/,
    )
  })

  it("starts the session over on an initialize", async () => {
    const { resolved } = await token()
    const first = detectClient(
      resolved,
      requestClient(initialize("claude-ai"), new Headers()),
    )

    expect(takeMemoryReminder(first.sessionKey)).toBe(true)
    expect(takeMemoryReminder(first.sessionKey)).toBe(false)

    detectClient(
      resolved,
      requestClient(initialize("claude-ai"), new Headers()),
    )
    expect(takeMemoryReminder(first.sessionKey)).toBe(true)
  })
})

describe("noteClientSeen", () => {
  it("keeps the client last seen on the token, without writing it again needlessly", async () => {
    const { id, resolved } = await token()
    const detected = detectClient(
      resolved,
      requestClient(
        initialize("claude-ai", "0.1.0"),
        new Headers({ Authorization: "Bearer pcp_secret" }),
      ),
    )
    const now = new Date("2026-11-02T12:00:00Z")

    expect(await noteClientSeen(resolved, detected, now)).toBe(true)

    const seen = (await getApiToken(ctx, id))!.clientSeen
    expect(seen).toEqual({
      name: "claude-ai",
      version: "0.1.0",
      profile: "claude-ai",
      at: now.toISOString(),
    })

    // The same client a minute later: nothing to write.
    expect(
      await noteClientSeen(
        { tokenId: id, clientSeen: seen },
        detected,
        new Date(now.getTime() + 60_000),
      ),
    ).toBe(false)
    // A while later, or another version: written again.
    expect(
      await noteClientSeen(
        { tokenId: id, clientSeen: seen },
        detected,
        new Date(now.getTime() + CLIENT_SEEN_INTERVAL_MS + 1),
      ),
    ).toBe(true)
    expect(
      await noteClientSeen(
        { tokenId: id, clientSeen: seen },
        { ...detected, version: "0.2.0" },
        new Date(now.getTime() + 60_000),
      ),
    ).toBe(true)

    // The token as the gateway resolves it carries it, for detection after
    // a restart.
    const stored = (await getApiToken(ctx, id))!.clientSeen
    expect(JSON.stringify(stored)).not.toContain("pcp_secret")
  })

  it("reads only what it wrote", () => {
    expect(parseClientSeen(null)).toBeNull()
    expect(parseClientSeen("not json")).toBeNull()
    expect(parseClientSeen('{"profile":"netscape","at":"x"}')).toBeNull()
    expect(
      parseClientSeen(
        JSON.stringify({ name: "a".repeat(500), profile: "generic", at: "t" }),
      )?.name,
    ).toHaveLength(200)
  })
})
