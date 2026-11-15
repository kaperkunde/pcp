import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { VaultContext } from "../context"
import { scratchDatabase } from "../test-db"
import { setupVault } from "../vault"
import { chromiumExecutable } from "./executable"
import { contextOptions, launchOptions } from "./launch"
import { MAX_IMPORT_BYTES, MAX_IMPORT_COOKIES } from "./limits"
import {
  loadProfile,
  profileSummary,
  writeProfile,
  type StorageState,
} from "./profile"
import {
  importSignIns,
  mergeSignIns,
  parseSignIns,
  previewSignInImport,
} from "./sign-in-import"

// The owner's import of a sign-in made elsewhere: read from the three
// shapes, checked as Chromium takes a cookie, PCP's own site and this
// machine left out, merged per site, written only as previewed.

const NOW = Date.UTC(2026, 10, 5)
// A cookie's expiry in the future both for the reads pinned to NOW and for
// the import into the vault, which reads the clock: a month from now, so it
// does not run out the day after NOW.
const LATER = Math.floor(Math.max(NOW, Date.now()) / 1000) + 30 * 86_400
const PUBLIC_URL = "https://ada.pcp.gg"

const executable = await chromiumExecutable()

const state = (cookies: unknown[], origins: unknown[] = []) =>
  JSON.stringify({ cookies, origins })

const pwCookie = (overrides: Record<string, unknown> = {}) => ({
  name: "sid",
  value: "abc",
  domain: ".reddit.com",
  path: "/",
  expires: LATER,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  ...overrides,
})

describe("reading an import", () => {
  it("reads Playwright's storage state, cookies and local storage", () => {
    const parsed = parseSignIns(
      state(
        [pwCookie(), pwCookie({ name: "host", domain: "www.reddit.com" })],
        [
          {
            origin: "https://www.reddit.com",
            localStorage: [{ name: "k", value: "v" }],
          },
        ],
      ),
      { now: NOW },
    )

    expect(parsed.format).toBe("storage-state")
    expect(parsed.cookies.map((cookie) => cookie.domain)).toEqual([
      ".reddit.com",
      "www.reddit.com",
    ])
    expect(parsed.origins).toEqual([
      {
        origin: "https://www.reddit.com",
        localStorage: [{ name: "k", value: "v" }],
      },
    ])
    expect(parsed.skipped).toEqual({})
  })

  it("reads a browser extension's JSON list of cookies", () => {
    const parsed = parseSignIns(
      JSON.stringify([
        {
          domain: ".example.com",
          hostOnly: false,
          name: "a",
          value: "1",
          path: "/",
          expirationDate: LATER,
          httpOnly: false,
          secure: true,
          sameSite: "no_restriction",
          session: false,
          storeId: "0",
        },
        {
          domain: "app.example.com",
          hostOnly: true,
          name: "b",
          value: "2",
          path: "/x",
          secure: false,
          sameSite: "unspecified",
          session: true,
        },
        {
          domain: "example.org",
          hostOnly: false,
          name: "c",
          value: "3",
          sameSite: null,
        },
      ]),
      { now: NOW },
    )

    expect(parsed.format).toBe("cookie-json")
    expect(parsed.cookies).toEqual([
      {
        name: "a",
        value: "1",
        domain: ".example.com",
        path: "/",
        expires: LATER,
        httpOnly: false,
        secure: true,
        sameSite: "None",
      },
      {
        name: "b",
        value: "2",
        domain: "app.example.com",
        path: "/x",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
      expect.objectContaining({ domain: ".example.org", sameSite: "Lax" }),
    ])
  })

  it("reads a Netscape cookies.txt, HttpOnly lines and session cookies too", () => {
    const parsed = parseSignIns(
      [
        "# Netscape HTTP Cookie File",
        "# https://curl.se/docs/http-cookies.html",
        "",
        `.example.com\tTRUE\t/\tTRUE\t${LATER}\tsid\tabc`,
        `#HttpOnly_shop.example.net\tFALSE\t/cart\tFALSE\t0\ttoken\txyz`,
        `.example.com\tTRUE\t/\tFALSE\t${LATER}\tempty`,
      ].join("\r\n"),
      { now: NOW },
    )

    expect(parsed.format).toBe("cookies-txt")
    expect(parsed.cookies).toEqual([
      expect.objectContaining({
        name: "sid",
        domain: ".example.com",
        secure: true,
        httpOnly: false,
        expires: LATER,
      }),
      expect.objectContaining({
        name: "token",
        domain: "shop.example.net",
        path: "/cart",
        httpOnly: true,
        expires: -1,
        sameSite: "Lax",
      }),
      expect.objectContaining({ name: "empty", value: "" }),
    ])
  })

  it("leaves out PCP's own site and its subdomains, this machine and addresses", () => {
    const parsed = parseSignIns(
      state(
        [
          pwCookie(),
          pwCookie({ domain: "ada.pcp.gg" }),
          pwCookie({ domain: ".pcp.gg" }),
          pwCookie({ domain: "localhost" }),
          pwCookie({ domain: "app.localhost" }),
          pwCookie({ domain: "127.0.0.1" }),
          pwCookie({ domain: "192.168.1.1" }),
        ],
        [
          {
            origin: "https://ada.pcp.gg",
            localStorage: [{ name: "k", value: "v" }],
          },
        ],
      ),
      { now: NOW, publicUrl: PUBLIC_URL },
    )

    expect(parsed.cookies.map((cookie) => cookie.domain)).toEqual([
      ".reddit.com",
    ])
    expect(parsed.origins).toEqual([])
    expect(parsed.skipped).toEqual({ own: 5, address: 2 })
  })

  it("leaves out what Chromium would refuse, expired cookies and IndexedDB", () => {
    const parsed = parseSignIns(
      state(
        [
          pwCookie(),
          pwCookie({ name: "a;b" }),
          pwCookie({ name: "a=b" }),
          pwCookie({ value: "line\nbreak" }),
          pwCookie({ name: "", value: "" }),
          pwCookie({ value: "x".repeat(5000) }),
          pwCookie({ path: "relative" }),
          pwCookie({ domain: "-bad-.com" }),
          pwCookie({ domain: "single" }),
          pwCookie({ name: "__Secure-x", secure: false }),
          pwCookie({ name: "__Host-x", domain: ".reddit.com" }),
          pwCookie({ name: "old", expires: NOW / 1000 - 1 }),
          pwCookie({ expires: Number.NaN }),
          { name: "no domain", value: "1" },
          "not an object",
        ],
        [
          { origin: "ftp://example.com", localStorage: [] },
          { origin: "nonsense" },
          {
            origin: "https://app.example.com",
            localStorage: [],
            indexedDB: [{ name: "db" }],
          },
        ],
      ),
      { now: NOW },
    )

    expect(parsed.cookies).toHaveLength(1)
    expect(parsed.skipped).toEqual({ invalid: 15, expired: 1, indexeddb: 1 })
  })

  it("keeps SameSite=None only on a secure cookie, as Chromium does", () => {
    const [cookie] = parseSignIns(
      state([pwCookie({ sameSite: "None", secure: false })]),
      { now: NOW },
    ).cookies

    expect(cookie!.sameSite).toBe("Lax")
  })

  it("keeps the last of the same cookie twice, and a domain in Unicode as Chromium names it", () => {
    const parsed = parseSignIns(
      state([
        pwCookie({ value: "first" }),
        pwCookie({ value: "second" }),
        pwCookie({ domain: ".bücher.example" }),
      ]),
      { now: NOW },
    )

    expect(
      parsed.cookies.map((cookie) => [cookie.domain, cookie.value]),
    ).toEqual([
      [".reddit.com", "second"],
      [".xn--bcher-kva.example", "abc"],
    ])
  })

  it("refuses what it cannot read, what is too large, and an import with nothing to import", () => {
    expect(() => parseSignIns("")).toThrow(/Paste a cookie export/)
    expect(() => parseSignIns("{not json")).toThrow(/not JSON/)
    expect(() => parseSignIns('{"hello": 1}')).toThrow(/neither/)
    expect(() => parseSignIns("just some words")).toThrow(/not a cookie export/)
    expect(() => parseSignIns("x".repeat(MAX_IMPORT_BYTES + 1))).toThrow(
      /over 8 MB/,
    )
    expect(() =>
      parseSignIns(
        JSON.stringify(
          Array.from({ length: MAX_IMPORT_COOKIES + 1 }, () => pwCookie()),
        ),
      ),
    ).toThrow(/more than 3,000 cookies/)
    expect(() =>
      parseSignIns(state([pwCookie({ domain: "ada.pcp.gg" })]), {
        publicUrl: PUBLIC_URL,
      }),
    ).toThrow(/Nothing in it can be imported: 1 for PCP's own site/)
  })
})

describe("merging an import into the profile", () => {
  const existing: StorageState = {
    cookies: [
      pwCookie({ value: "old" }) as StorageState["cookies"][number],
      pwCookie({
        name: "old-host",
        domain: "old.reddit.com",
      }) as StorageState["cookies"][number],
      pwCookie({
        domain: ".example.com",
        value: "stays",
      }) as StorageState["cookies"][number],
      pwCookie({
        domain: "notreddit.com",
        value: "stays",
      }) as StorageState["cookies"][number],
    ],
    origins: [
      {
        origin: "https://www.reddit.com",
        localStorage: [{ name: "old", value: "1" }],
      },
      {
        origin: "https://example.com",
        localStorage: [{ name: "stays", value: "1" }],
      },
    ],
  }

  it("replaces what the profile held for each site the import names, and keeps the rest", () => {
    const imported = parseSignIns(state([pwCookie({ value: "new" })]), {
      now: NOW,
    })
    const merged = mergeSignIns(existing, imported)

    expect(merged.cookies.map((c) => [c.domain, c.name, c.value])).toEqual([
      [".example.com", "sid", "stays"],
      ["notreddit.com", "sid", "stays"],
      [".reddit.com", "sid", "new"],
    ])
    expect(merged.origins.map((origin) => origin.origin)).toEqual([
      "https://example.com",
    ])
  })

  it("replaces a parent domain's cookies too, for a subdomain's import, but not a sibling's", () => {
    const imported = parseSignIns(
      state([pwCookie({ domain: "www.reddit.com" })]),
      { now: NOW },
    )
    const merged = mergeSignIns(existing, imported)

    // old.reddit.com's own cookie is never sent to www.reddit.com.
    expect(merged.cookies.map((c) => c.domain)).toEqual([
      "old.reddit.com",
      ".example.com",
      "notreddit.com",
      "www.reddit.com",
    ])
  })

  it("starts from nothing when there is no profile", () => {
    const imported = parseSignIns(state([pwCookie()]), { now: NOW })
    expect(mergeSignIns(null, imported)).toEqual({
      cookies: imported.cookies,
      origins: [],
    })
  })
})

describe("importing into the vault", () => {
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

  it("previews sites and counts, then writes only what was previewed", async () => {
    await writeProfile(ctx, {
      cookies: [pwCookie({ value: "old" }) as StorageState["cookies"][number]],
      origins: [],
    })
    const text = state(
      [
        pwCookie({ value: "new" }),
        pwCookie({ name: "b", domain: "www.reddit.com" }),
        pwCookie({ domain: "ada.pcp.gg" }),
      ],
      [
        {
          origin: "https://www.reddit.com",
          localStorage: [{ name: "k", value: "v" }],
        },
      ],
    )

    const preview = await previewSignInImport(ctx, text, {
      publicUrl: PUBLIC_URL,
    })

    expect(preview).toMatchObject({
      format: "storage-state",
      cookies: 2,
      origins: 1,
      sites: [
        { site: "reddit.com", cookies: 1, storage: 0 },
        { site: "www.reddit.com", cookies: 1, storage: 1 },
      ],
      skipped: [
        {
          reason: "own",
          count: 1,
          label: "for PCP's own site or this machine",
        },
      ],
      replaces: { sites: 1, cookies: 1 },
      browserOpen: false,
    })
    // Nothing is written by a preview.
    expect((await loadProfile(ctx))?.cookies.map((c) => c.value)).toEqual([
      "old",
    ])

    await expect(
      importSignIns(ctx, `${text} `, preview.basis, { publicUrl: PUBLIC_URL }),
    ).rejects.toThrow(/Preview it again/)

    expect(
      await importSignIns(ctx, text, preview.basis, { publicUrl: PUBLIC_URL }),
    ).toEqual({ sites: 2, cookies: 2 })

    const profile = await loadProfile(ctx)
    expect(profile?.cookies.map((c) => [c.domain, c.value])).toEqual([
      [".reddit.com", "new"],
      ["www.reddit.com", "abc"],
    ])
    expect(profile?.origins).toHaveLength(1)
    expect(await profileSummary(ctx.vaultId)).toMatchObject({
      cookies: 2,
      sites: 2,
      partial: false,
    })
  })
})

describe.skipIf(!executable)(
  "an imported profile in Chromium",
  { timeout: 120_000 },
  () => {
    it("starts a context with every cookie the import kept", async () => {
      const imported = parseSignIns(
        [
          JSON.stringify([
            {
              domain: ".example.com",
              hostOnly: false,
              name: "ext",
              value: "1",
              path: "/",
              expirationDate: Date.now() / 1000 + 3600,
              secure: true,
              sameSite: "no_restriction",
            },
            {
              domain: "app.example.com",
              hostOnly: true,
              name: "__Host-session",
              value: "2",
              path: "/",
              secure: true,
              session: true,
            },
            {
              domain: "plain.example.org",
              hostOnly: true,
              name: "lax",
              value: "3",
              sameSite: "None",
              secure: false,
            },
          ]),
        ].join(""),
      )
      const merged = mergeSignIns(null, imported)
      const { chromium } = await import("patchright-core")
      const scratchDir = mkdtempSync(path.join(os.tmpdir(), "pcp-import-"))
      const browser = await chromium.launch({
        ...launchOptions({
          mode: "headless",
          executablePath: executable!,
          sandbox: false,
          scratchDir,
          display: null,
        }),
        timeout: 30_000,
      })

      try {
        const context = await browser.newContext({
          ...contextOptions(browser.version(), "headless"),
          storageState: merged,
        })
        const names = (await context.cookies()).map((c) => c.name).sort()
        expect(names).toEqual(["__Host-session", "ext", "lax"])
      } finally {
        await browser.close()
        rmSync(scratchDir, { recursive: true, force: true })
      }
    })
  },
)
