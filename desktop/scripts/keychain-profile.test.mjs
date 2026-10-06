import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  checkProfile,
  keychainEntitlements,
  parsePlist,
} from "./keychain-profile.mjs"

const APP_ID = "com.kaperkunde.pcp"
const TEAM = "ABCDE12345"
const NOW = Date.parse("2026-10-05T00:00:00Z")

// What `security cms -D` prints for a Developer ID profile, cut down.
function profileXml({
  team = TEAM,
  appIdentifier = `${TEAM}.${APP_ID}`,
  groups = [`${TEAM}.*`],
  allDevices = true,
  expires = "2044-10-05T00:00:00Z",
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AppIDName</key>
	<string>PCP &amp; friends</string>
	<key>CreationDate</key>
	<date>2026-10-05T00:00:00Z</date>
	<key>DeveloperCertificates</key>
	<array>
		<data>
		MIIFwzCCBKugAwIBAgIIQ0FGRQ==
		</data>
	</array>
	<key>Entitlements</key>
	<dict>
		<key>com.apple.application-identifier</key>
		<string>${appIdentifier}</string>
		<key>keychain-access-groups</key>
		<array>
${groups.map((group) => `			<string>${group}</string>`).join("\n")}
		</array>
		<key>com.apple.developer.team-identifier</key>
		<string>${team}</string>
	</dict>
	<key>ExpirationDate</key>
	<date>${expires}</date>
	<key>Name</key>
	<string>PCP Developer ID</string>
	${allDevices ? "<key>ProvisionsAllDevices</key>\n\t<true/>" : ""}
	<key>TeamIdentifier</key>
	<array>
		<string>${team}</string>
	</array>
	<key>TimeToLive</key>
	<integer>6574</integer>
	<key>Version</key>
	<integer>1</integer>
</dict>
</plist>`
}

describe("parsePlist", () => {
  it("reads a profile's property list", () => {
    const profile = parsePlist(profileXml())
    expect(profile).toMatchObject({
      AppIDName: "PCP & friends",
      CreationDate: "2026-10-05T00:00:00Z",
      DeveloperCertificates: ["MIIFwzCCBKugAwIBAgIIQ0FGRQ=="],
      Entitlements: {
        "com.apple.application-identifier": `${TEAM}.${APP_ID}`,
        "keychain-access-groups": [`${TEAM}.*`],
      },
      ProvisionsAllDevices: true,
      TeamIdentifier: [TEAM],
      TimeToLive: 6574,
    })
  })

  it("refuses one cut short or malformed", () => {
    expect(() => parsePlist("<plist><dict><key>a</key>")).toThrow()
    expect(() => parsePlist("<plist><dict><string>a</string></dict>")).toThrow(
      /key was expected/,
    )
    expect(() => parsePlist("<plist><dict></array></plist>")).toThrow()
  })
})

describe("checkProfile", () => {
  const check = (options, team) =>
    checkProfile(parsePlist(profileXml(options)), {
      appId: APP_ID,
      team,
      now: NOW,
    })

  it("takes a Developer ID profile for the app and its keychain group", () => {
    expect(check()).toBe(TEAM)
    expect(check({}, TEAM)).toBe(TEAM)
    expect(check({ groups: [`${TEAM}.${APP_ID}`] })).toBe(TEAM)
  })

  it("refuses one that would make an app macOS kills at launch", () => {
    expect(() => check({}, "ZZZZZ99999")).toThrow(/APPLE_TEAM_ID/)
    expect(() => check({ allDevices: false })).toThrow(/Developer ID/)
    expect(() => check({ appIdentifier: `${TEAM}.com.example.other` })).toThrow(
      /not ABCDE12345\.com\.kaperkunde\.pcp/,
    )
    expect(() => check({ groups: [`${TEAM}.com.example.other`] })).toThrow(
      /keychain group/,
    )
    expect(() => check({ groups: [] })).toThrow(/keychain group/)
    expect(() => check({ expires: "2027-06-01T00:00:00Z" })).toThrow(
      /expires 2027-06-01/,
    )
    expect(() => check({ team: "not a team" })).toThrow(/no team/)
  })
})

describe("keychainEntitlements", () => {
  const base = readFileSync(
    path.join(import.meta.dirname, "..", "build", "entitlements.mac.plist"),
    "utf8",
  )

  it("adds the app's identifier, team and keychain group to the base file", () => {
    const entitlements = parsePlist(keychainEntitlements(base, TEAM, APP_ID))
    expect(entitlements).toEqual({
      ...parsePlist(base),
      "com.apple.application-identifier": `${TEAM}.${APP_ID}`,
      "com.apple.developer.team-identifier": TEAM,
      "keychain-access-groups": [`${TEAM}.${APP_ID}`],
    })
    // The base file's own entitlements are still there.
    expect(entitlements["com.apple.security.cs.allow-jit"]).toBe(true)
  })

  it("refuses a team or app identifier that is not one", () => {
    expect(() => keychainEntitlements(base, "<evil/>", APP_ID)).toThrow()
    expect(() => keychainEntitlements(base, TEAM, "com.<x>")).toThrow()
    expect(() => keychainEntitlements("<plist/>", TEAM, APP_ID)).toThrow()
  })
})
