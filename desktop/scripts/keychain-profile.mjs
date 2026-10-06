// The provisioning profile that lets the Mac app keep its Touch ID key in a
// keychain item macOS opens only for a fingerprint (native/keychain). That
// item lives in the data-protection keychain, which needs the
// keychain-access-groups entitlement, and a Developer ID app may carry that
// entitlement only with a profile that grants it. dist.mjs embeds the
// profile and signs the app (not its helpers) with the entitlement.
//
// A profile that does not match the app is refused here, before anything is
// signed: macOS kills at launch an app whose entitlements its profile does
// not grant, and that is not a release to find out about from the owner.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const DAY_MS = 24 * 60 * 60 * 1000
const TEAM_ID = /^[A-Z0-9]{10}$/

/**
 * A property list as XML (what `security cms -D` prints for a profile) as a
 * plain value: dicts, arrays, strings, integers, reals, booleans, dates as
 * ISO strings, data as base64 strings. Only what a profile holds.
 *
 * @param {string} xml
 * @returns {unknown}
 */
export function parsePlist(xml) {
  const tokens = [
    ...xml.matchAll(
      /<(\/?)([a-z]+)(?:\s[^>]*?)?(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g,
    ),
  ]
  let at = 0
  // The text between the token just read and the next one.
  const textAfter = (index) =>
    xml.slice(
      tokens[index].index + tokens[index][0].length,
      tokens[index + 1]?.index ?? xml.length,
    )

  function value() {
    while (at < tokens.length && !tokens[at][2]) at++ // comments, <?xml ?>
    const [, closing, name, empty] = tokens[at] ?? []
    if (!name || closing) throw new Error("The property list is cut short.")
    const start = at++

    if (empty) {
      if (name === "true") return true
      if (name === "false") return false
      if (name === "dict") return {}
      if (name === "array") return []
      if (name === "string" || name === "data") return ""
      throw new Error(`Unexpected <${name}/> in the property list.`)
    }

    if (name === "plist") {
      const inner = value()
      expectClose("plist")
      return inner
    }

    if (name === "dict") {
      const dict = {}
      while (tokens[at] && !(tokens[at][1] && tokens[at][2] === "dict")) {
        if (tokens[at][2] !== "key" || tokens[at][1]) {
          throw new Error("A key was expected in the property list's dict.")
        }
        const key = unescape(textAfter(at))
        at++
        expectClose("key")
        dict[key] = value()
      }
      expectClose("dict")
      return dict
    }

    if (name === "array") {
      const array = []
      while (tokens[at] && !(tokens[at][1] && tokens[at][2] === "array")) {
        array.push(value())
      }
      expectClose("array")
      return array
    }

    const text = unescape(textAfter(start))
    expectClose(name)
    switch (name) {
      case "string":
      case "date":
        return text
      case "data":
        return text.replace(/\s+/g, "")
      case "integer":
        return Number.parseInt(text, 10)
      case "real":
        return Number.parseFloat(text)
      default:
        throw new Error(`Unexpected <${name}> in the property list.`)
    }
  }

  function expectClose(name) {
    const token = tokens[at]
    if (!token || !token[1] || token[2] !== name) {
      throw new Error(`</${name}> was expected in the property list.`)
    }
    at++
  }

  return value()
}

function unescape(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * The profile's team, once the profile is one this app may be signed with:
 * a Developer ID profile, for this app, granting its keychain group, and
 * good for more than a year. Throws with what to fix otherwise.
 *
 * @param {any} profile the parsed profile
 * @param {{ appId: string, team?: string, now?: number }} options
 * @returns {string}
 */
export function checkProfile(profile, { appId, team, now = Date.now() }) {
  const profileTeam = Array.isArray(profile?.TeamIdentifier)
    ? profile.TeamIdentifier[0]
    : undefined
  if (typeof profileTeam !== "string" || !TEAM_ID.test(profileTeam)) {
    throw new Error("The provisioning profile names no team.")
  }
  if (team && team !== profileTeam) {
    throw new Error(
      `The provisioning profile is for team ${profileTeam}, but APPLE_TEAM_ID is ${team}.`,
    )
  }
  if (profile.ProvisionsAllDevices !== true) {
    throw new Error(
      "The provisioning profile is limited to certain Macs. Make a Developer ID profile instead (Profiles → Distribution → Developer ID).",
    )
  }

  const entitlements = profile.Entitlements ?? {}
  const wanted = `${profileTeam}.${appId}`
  const granted =
    entitlements["com.apple.application-identifier"] ??
    entitlements["application-identifier"]
  if (granted !== wanted) {
    throw new Error(
      `The provisioning profile is for ${granted ?? "no app"}, not ${wanted}.`,
    )
  }
  const groups = entitlements["keychain-access-groups"]
  if (
    !Array.isArray(groups) ||
    !groups.some((group) => group === wanted || group === `${profileTeam}.*`)
  ) {
    throw new Error(
      `The provisioning profile does not grant the keychain group ${wanted}.`,
    )
  }

  const expires = Date.parse(profile.ExpirationDate)
  if (!(expires > now + 365 * DAY_MS)) {
    throw new Error(
      `The provisioning profile expires ${profile.ExpirationDate ?? "at no stated time"}; make a new one. An app whose profile has expired does not start.`,
    )
  }

  return profileTeam
}

/**
 * The app's entitlements with the keychain group added: the base file's
 * keys, then the app's identifier, its team and its one keychain group.
 * Only the app itself is signed with these; its helpers keep the base file,
 * since a helper with an entitlement the profile does not cover is killed.
 *
 * @param {string} baseXml entitlements.mac.plist
 * @param {string} team
 * @param {string} appId
 */
export function keychainEntitlements(baseXml, team, appId) {
  if (!TEAM_ID.test(team)) {
    throw new Error(`"${team}" is not a team identifier.`)
  }
  if (!/^[A-Za-z0-9.-]+$/.test(appId)) {
    throw new Error(`"${appId}" is not an app identifier.`)
  }
  const end = baseXml.lastIndexOf("</dict>")
  if (end === -1) {
    throw new Error("The base entitlements have no <dict>.")
  }

  const added = [
    "    <key>com.apple.application-identifier</key>",
    `    <string>${team}.${appId}</string>`,
    "    <key>com.apple.developer.team-identifier</key>",
    `    <string>${team}</string>`,
    "    <key>keychain-access-groups</key>",
    "    <array>",
    `      <string>${team}.${appId}</string>`,
    "    </array>",
    "  ",
  ].join("\n")

  return `${baseXml.slice(0, end).trimEnd()}\n${added}${baseXml.slice(end)}`
}

/**
 * Writes the profile and the entitlements beside entitlements.mac.plist,
 * for electron-builder: the paths it takes, relative to the desktop folder,
 * and the team. macOS only (`security` reads the profile's signed envelope).
 *
 * @param {{ desktopDir: string, profileBase64: string, appId: string, team?: string }} options
 */
export function prepareKeychainSigning({
  desktopDir,
  profileBase64,
  appId,
  team,
}) {
  const profileFile = path.join("build", "embedded.provisionprofile")
  const entitlementsFile = path.join("build", "entitlements.keychain.plist")

  const bytes = Buffer.from(profileBase64.trim(), "base64")
  if (bytes.length === 0) {
    throw new Error("MAC_PROVISIONING_PROFILE is not a base64 profile.")
  }
  writeFileSync(path.join(desktopDir, profileFile), bytes)

  const xml = execFileSync(
    "security",
    ["cms", "-D", "-i", path.join(desktopDir, profileFile)],
    { encoding: "utf8" },
  )
  const profileTeam = checkProfile(parsePlist(xml), { appId, team })

  const base = readFileSync(
    path.join(desktopDir, "build", "entitlements.mac.plist"),
    "utf8",
  )
  writeFileSync(
    path.join(desktopDir, entitlementsFile),
    keychainEntitlements(base, profileTeam, appId),
  )

  return {
    profile: profileFile,
    entitlements: entitlementsFile,
    team: profileTeam,
  }
}
