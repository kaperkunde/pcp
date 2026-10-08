import { describe, expect, it } from "vitest"

import { PCP_PERMISSIONS, permissionAllowed, webUrl } from "./window-policy.mjs"

describe("webUrl", () => {
  it("is http and https addresses, written out whole", () => {
    expect(webUrl("https://github.com/kaperkunde/pcp#readme")).toBe(
      "https://github.com/kaperkunde/pcp#readme",
    )
    expect(webUrl("http://127.0.0.1:3000/settings")).toBe(
      "http://127.0.0.1:3000/settings",
    )
    expect(webUrl("HTTPS://Accounts.Google.com/o/oauth2/auth?x=1")).toBe(
      "https://accounts.google.com/o/oauth2/auth?x=1",
    )
    expect(webUrl("  https://example.com")).toBe("https://example.com/")
  })

  it("is nothing for a scheme the system would hand to another program", () => {
    for (const url of [
      "smb://attacker.example/share/run.exe",
      "file:///C:/Windows/System32/calc.exe",
      "file://attacker.example/share/run.exe",
      "search-ms:query=x&crumb=location:\\\\attacker.example\\share",
      "ms-msdt:/id PCWDiagnostic",
      "ms-settings:",
      "mailto:someone@example.com",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:http://127.0.0.1:3000/0b6e7a1c",
      "vscode://file/etc/passwd",
      "about:blank",
      "chrome://settings",
      "ftp://example.com/",
      "\\\\attacker.example\\share\\run.exe",
      "not a url",
      "",
      undefined,
      null,
      42,
    ]) {
      expect(webUrl(url), String(url)).toBeNull()
    }
  })
})

describe("permissionAllowed", () => {
  const PORT = 3000
  const pcp = (permission, url = "http://127.0.0.1:3000/secrets", more = {}) =>
    permissionAllowed({ permission, url, ...more }, PORT)

  it("grants PCP's own page what it uses", () => {
    expect(pcp("clipboard-sanitized-write")).toBe(true)
    // The check handler is given the origin, not the page.
    expect(pcp("clipboard-sanitized-write", "http://127.0.0.1:3000")).toBe(true)
    expect(
      permissionAllowed({ permission: "clipboard-sanitized-write" }, PORT),
    ).toBe(false)
    expect(
      pcp("clipboard-sanitized-write", "http://127.0.0.1:3000/", {
        isMainFrame: true,
      }),
    ).toBe(true)
  })

  it("grants PCP's own page nothing else", () => {
    for (const permission of [
      "clipboard-read",
      "deprecated-sync-clipboard-read",
      "notifications",
      "media",
      "display-capture",
      "geolocation",
      "openExternal",
      "fullscreen",
      "pointerLock",
      "keyboardLock",
      "hid",
      "serial",
      "usb",
      "fileSystem",
      "storage-access",
      "top-level-storage-access",
      "window-management",
      "unknown",
    ]) {
      expect(pcp(permission), permission).toBe(false)
    }
  })

  it("grants nothing to another site, a sign-in page included", () => {
    for (const url of [
      "https://accounts.google.com/signin",
      "https://github.com/login/oauth/authorize",
      "https://127.0.0.1:3000/",
      "http://127.0.0.1:3001/",
      "http://localhost:3000/",
      "http://[::1]:3000/",
      "http://127.0.0.1.example.com:3000/",
      "about:blank",
      "null",
    ]) {
      for (const permission of PCP_PERMISSIONS) {
        expect(pcp(permission, url), `${permission} ${url}`).toBe(false)
      }
      expect(pcp("openExternal", url), url).toBe(false)
      expect(pcp("clipboard-read", url), url).toBe(false)
    }
  })

  it("grants nothing to a frame inside PCP's page", () => {
    expect(
      pcp("clipboard-sanitized-write", "http://127.0.0.1:3000/", {
        isMainFrame: false,
      }),
    ).toBe(false)
  })
})
