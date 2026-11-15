import { describe, expect, it } from "vitest"

import {
  CLIENT_PROFILE_IDS,
  CLIENT_PROFILES,
  clientProfile,
  isClientProfileId,
  matchProfile,
} from "./profiles"

describe("client profiles", () => {
  it("are data: one entry per id, each with its date or none, generic last", () => {
    expect(CLIENT_PROFILES.map((profile) => profile.id)).toEqual([
      ...CLIENT_PROFILE_IDS,
    ])
    expect(CLIENT_PROFILES.at(-1)!.id).toBe("generic")

    for (const profile of CLIENT_PROFILES) {
      expect(profile.label, profile.id).toBeTruthy()
      expect(profile.notes, profile.id).toBeTruthy()
      expect(profile.linkStyle, profile.id).toBe("markdown")
      if (profile.observed !== null) {
        expect(profile.observed, profile.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    }
  })

  it("mirror the instructions for Claude's apps, not for Claude Code", () => {
    expect(clientProfile("claude-ai").mirrorInstructions).toBe(true)
    expect(clientProfile("claude-code").mirrorInstructions).toBe(false)
    expect(clientProfile("generic").mirrorInstructions).toBe(false)
  })

  it("are found by the client's name, a label header, the user agent or the sign-in name", () => {
    expect(matchProfile({ clientName: "claude-ai" }).id).toBe("claude-ai")
    expect(matchProfile({ clientName: "claude-code" }).id).toBe("claude-code")
    expect(matchProfile({ clientName: "openai-mcp" }).id).toBe("chatgpt")
    expect(
      matchProfile({ headers: { "x-anthropic-client": "claude-ai" } }).id,
    ).toBe("claude-ai")
    expect(matchProfile({ userAgent: "Claude-User" }).id).toBe("claude-ai")
    expect(matchProfile({ userAgent: "claude-code/2.1.0" }).id).toBe(
      "claude-code",
    )
    expect(matchProfile({ oauthClientName: "ChatGPT" }).id).toBe("chatgpt")
    expect(matchProfile({ oauthClientName: "Claude" }).id).toBe("claude-ai")
  })

  it("take the client's own name over weaker signals, and generic for nothing known", () => {
    expect(
      matchProfile({ clientName: "claude-code", userAgent: "Claude-User" }).id,
    ).toBe("claude-code")
    expect(
      matchProfile({
        userAgent: "claude-code/2.1.0",
        oauthClientName: "Claude",
      }).id,
    ).toBe("claude-code")
    expect(matchProfile({}).id).toBe("generic")
    expect(matchProfile({ clientName: "some-app", userAgent: "curl" }).id).toBe(
      "generic",
    )
  })

  it("fall back to generic for an id PCP no longer has", () => {
    expect(clientProfile("retired-app").id).toBe("generic")
    expect(clientProfile(null).id).toBe("generic")
    expect(isClientProfileId("claude-ai")).toBe(true)
    expect(isClientProfileId("retired-app")).toBe(false)
  })
})
