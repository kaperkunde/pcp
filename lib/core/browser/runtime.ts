import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  Page,
} from "playwright-core"

import type { VaultContext } from "../context"
import { PcpError } from "../errors"
import { isPcpSite } from "../fetch/fetch"
import { resolveFetchAccess, siteKey, type FetchRuleSet } from "../fetch/rules"
import { isOwnAddress, isPublicAddress } from "../openapi/address"
import { chromiumExecutable } from "./executable"
import {
  DIALOG_DISMISS_MS,
  IDLE_CLOSE_MS,
  MAX_TABS,
  PROFILE_SAVE_INTERVAL_MS,
  VIEWPORT,
} from "./limits"
import { loadProfile, saveProfile } from "./profile"
import {
  startBrowserProxy,
  type AddressVerdict,
  type BrowserProxy,
} from "./proxy"
import type { TabControl, TabView } from "./types"

/**
 * The browser's running side: one headless Chromium per vault, started on
 * first use and closed after IDLE_CLOSE_MS with nothing happening, its
 * tabs, and who drives each. One per process, kept on globalThis because
 * the gateway, the Server Actions and the route handlers are bundled apart
 * and would otherwise each have their own copy of this module.
 *
 * The browser keeps nothing on disk: its context is in memory, started
 * from the vault's saved profile (profile.ts) and saved back while a
 * request holds the vault's key. The idle close has no key, so it saves
 * nothing: what a page changed on its own since the last save is lost.
 *
 * Every connection goes through PCP's proxy (proxy.ts), and every page a
 * tab's main frame opens passes the gate here first: the sites the token
 * that drives the tab may reach (its web fetch lines), the sites the owner
 * allowed for this tab, or anything while the owner drives it. PCP's own
 * site never.
 */

export type Tab = {
  id: string
  page: Page
  cdp: CDPSession
  mainFrameId: string
  /** "owner", or the name of the token that opened it. */
  openedBy: string
  /** The token that last drove the tab; null while only the owner has. */
  tokenId: string | null
  /** That token's web fetch lines, as last read. */
  rules: FetchRuleSet | null
  /** That token may reach private addresses. */
  privateAllowed: boolean
  /** Sites the owner allowed once for this tab, open while it is. */
  allowedHosts: Set<string>
  control: TabControl
  /** The owner holds the tab for an assistant's hand-over, since then. */
  handoverSince: number | null
  /** The last site the gate kept the main frame from opening. */
  lastBlocked: string | null
  dialog: Dialog | null
  createdAt: number
  lastUsedAt: number
  /** The live view's state (screencast.ts) and the owner's input (input.ts). */
  extra: Map<string, unknown>
}

export type VaultBrowser = {
  vaultId: string
  browser: Browser
  context: BrowserContext
  proxy: BrowserProxy
  /** Chromium's own sandbox: off when the machine cannot give it one. */
  sandbox: boolean
  /** Chromium's folder for what it keeps outside the profile (launch). */
  scratchDir: string
  tabs: Map<string, Tab>
  lastTabByToken: Map<string, string>
  /** PCP's own public address, never opened. */
  publicUrl: string | null
  privateAllowed: boolean
  idleTimer: NodeJS.Timeout | null
  chain: Promise<unknown>
  lastSavedAt: number
  lastSavedHash: string | null
  startedAt: number
}

type Runtime = {
  vaults: Map<string, VaultBrowser>
  starting: Map<string, Promise<VaultBrowser>>
  /** Replaces the address check; for tests that serve pages on loopback. */
  addressCheck: ((address: string, port: number) => boolean) | null
}

const RUNTIME = Symbol.for("pcp.browser")

function runtime(): Runtime {
  const holder = globalThis as unknown as { [RUNTIME]?: Runtime }

  holder[RUNTIME] ??= {
    vaults: new Map(),
    starting: new Map(),
    addressCheck: null,
  }

  return holder[RUNTIME]
}

/** Lets loopback through the proxy (for tests that serve pages locally). */
export function setBrowserAddressCheck(
  check: ((address: string, port: number) => boolean) | null,
): void {
  runtime().addressCheck = check
}

export function runningBrowser(vaultId: string): VaultBrowser | null {
  return runtime().vaults.get(vaultId) ?? null
}

/** Runs browser work for a vault one at a time. */
export function withVault<T>(
  vault: VaultBrowser,
  run: () => Promise<T>,
): Promise<T> {
  const result = vault.chain.then(run, run)
  vault.chain = result.catch(() => {})
  return result
}

/** Something happened: the idle close waits again. */
export function touch(vaultId: string): void {
  const vault = runningBrowser(vaultId)

  if (!vault) {
    return
  }

  if (vault.idleTimer) {
    clearTimeout(vault.idleTimer)
  }

  vault.idleTimer = setTimeout(() => {
    void closeBrowser(vaultId).catch((error) =>
      console.error("[browser] closing after idle failed", error),
    )
  }, IDLE_CLOSE_MS).unref()
}

function verdict(
  vault: VaultBrowser,
  address: string,
  port: number,
): AddressVerdict {
  const test = runtime().addressCheck

  if (test) {
    return test(address, port) ? "ok" : "private"
  }

  if (isOwnAddress(address, port, [vault.proxy.port])) {
    return "own"
  }

  return vault.privateAllowed || isPublicAddress(address) ? "ok" : "private"
}

function platformToken(): string {
  switch (process.platform) {
    case "darwin":
      return "Macintosh; Intel Mac OS X 10_15_7"
    case "win32":
      return "Windows NT 10.0; Win64; x64"
    default:
      return "X11; Linux x86_64"
  }
}

/**
 * Chromium keeps its crash reporter's database in the user's config folder
 * (~/.config), and when it cannot make one there it can abort as it starts:
 * a system user with no home, as PCP's image runs as, has none. Each
 * browser gets a private folder for it under the system's temporary folder
 * instead, removed once the browser has closed, so nothing of it lands in
 * the user's home and a crash report does not outlive the browser.
 */
async function makeScratchDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pcp-chromium-"))
}

function removeScratchDir(dir: string): void {
  void fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}

async function launch(
  executablePath: string,
  proxyPort: number,
  sandbox: boolean,
  scratchDir: string,
): Promise<Browser> {
  const { chromium } = await import("playwright-core")

  return chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: sandbox,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(scratchDir, "config"),
      XDG_CACHE_HOME: path.join(scratchDir, "cache"),
    },
    // What tells a page it is being driven: the automation switch and the
    // webdriver flag. The rest of headless Chromium is as it is.
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      // UDP would go around the proxy: no QUIC, and WebRTC only through it.
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
    proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: "<-loopback>" },
    timeout: 30_000,
  })
}

function sandboxSetting(): "on" | "off" | "auto" {
  const value = process.env.PCP_BROWSER_SANDBOX?.toLowerCase()
  return value === "on" || value === "off" ? value : "auto"
}

/**
 * The vault's browser, started if it is not running: Chromium found,
 * the proxy up, the saved profile opened with the request's key.
 */
export async function ensureBrowser(
  ctx: VaultContext,
  { publicUrl }: { publicUrl?: string } = {},
): Promise<VaultBrowser> {
  const state = runtime()
  const running = state.vaults.get(ctx.vaultId)

  if (running) {
    if (publicUrl) running.publicUrl = publicUrl
    touch(ctx.vaultId)
    return running
  }

  let starting = state.starting.get(ctx.vaultId)

  if (!starting) {
    starting = start(ctx, publicUrl ?? null).finally(() =>
      state.starting.delete(ctx.vaultId),
    )
    state.starting.set(ctx.vaultId, starting)
  }

  const vault = await starting
  touch(ctx.vaultId)
  return vault
}

async function start(
  ctx: VaultContext,
  publicUrl: string | null,
): Promise<VaultBrowser> {
  const executable = await chromiumExecutable()

  if (!executable) {
    throw new PcpError(
      "state",
      "Chromium is not installed on the machine PCP runs on, so the browser cannot start. The owner can see how to add it on PCP's Browser page.",
    )
  }

  // The proxy decides with the vault's state, which exists only once the
  // browser does: until then it refuses everything.
  let vault: VaultBrowser | null = null
  const proxy = await startBrowserProxy({
    check: (address, port) =>
      vault ? verdict(vault, address, port) : "private",
  })

  let browser: Browser
  let sandbox = sandboxSetting() !== "off"
  const scratchDir = await makeScratchDir()

  try {
    try {
      browser = await launch(executable, proxy.port, sandbox, scratchDir)
    } catch (error) {
      // An unprivileged container, or root, has no sandbox to give.
      if (!sandbox || sandboxSetting() === "on") throw error
      sandbox = false
      browser = await launch(executable, proxy.port, false, scratchDir)
    }
  } catch (error) {
    await proxy.close()
    removeScratchDir(scratchDir)
    console.error("[browser] Chromium did not start", error)
    throw new PcpError(
      "state",
      "Chromium did not start on the machine PCP runs on. The owner can see why in PCP's log.",
    )
  }

  const major = browser.version().split(".")[0] ?? "141"
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions()
  const context = await browser.newContext({
    viewport: { ...VIEWPORT },
    deviceScaleFactor: 1,
    userAgent: `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    locale,
    timezoneId: timeZone,
    acceptDownloads: false,
    // A service worker can answer a navigation without the network, which
    // would go around the gate.
    serviceWorkers: "block",
    storageState: (await loadProfile(ctx)) ?? undefined,
  })

  vault = {
    vaultId: ctx.vaultId,
    browser,
    context,
    proxy,
    sandbox,
    scratchDir,
    tabs: new Map(),
    lastTabByToken: new Map(),
    publicUrl,
    privateAllowed: false,
    idleTimer: null,
    chain: Promise.resolve(),
    lastSavedAt: Date.now(),
    lastSavedHash: null,
    startedAt: Date.now(),
  }

  const self = vault
  context.on("page", (page) => {
    // A page the browser opened itself (a popup, target=_blank): a tab of
    // the one that opened it, if there is room.
    if ([...self.tabs.values()].some((tab) => tab.page === page)) return
    void adoptPopup(self, page).catch(() => page.close().catch(() => {}))
  })
  browser.on("disconnected", () => {
    if (runtime().vaults.get(self.vaultId) === self) {
      forget(self)
    }
    removeScratchDir(self.scratchDir)
  })

  runtime().vaults.set(ctx.vaultId, vault)
  return vault
}

function forget(vault: VaultBrowser): void {
  if (vault.idleTimer) clearTimeout(vault.idleTimer)
  runtime().vaults.delete(vault.vaultId)
  vault.tabs.clear()
  void vault.proxy.close()
}

/**
 * Closes the vault's browser. With the key (`ctx`), the profile is saved
 * first; the idle close has none.
 */
export async function closeBrowser(
  vaultId: string,
  { ctx }: { ctx?: VaultContext } = {},
): Promise<void> {
  const vault = runningBrowser(vaultId)

  if (!vault) {
    return
  }

  if (ctx) {
    await saveVaultProfile(ctx, vault, { force: true }).catch((error) =>
      console.error("[browser] saving the profile failed", error),
    )
  }

  forget(vault)
  await vault.browser.close().catch(() => {})
}

/** Every vault's browser, at shutdown or between tests. */
export async function closeAllBrowsers(): Promise<void> {
  for (const vaultId of [...runtime().vaults.keys()]) {
    await closeBrowser(vaultId)
  }
}

/** Saves the profile, at most every PROFILE_SAVE_INTERVAL_MS unless forced. */
export async function saveVaultProfile(
  ctx: VaultContext,
  vault: VaultBrowser,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  if (!force && Date.now() - vault.lastSavedAt < PROFILE_SAVE_INTERVAL_MS) {
    return
  }

  vault.lastSavedAt = Date.now()
  vault.lastSavedHash = await saveProfile(ctx, vault.context, {
    unless: vault.lastSavedHash,
  })
}

function newTabId(): string {
  return randomBytes(6).toString("base64url")
}

/** The private-address setting the proxy follows: any tab's that has it. */
export function recomputePrivate(vault: VaultBrowser): void {
  vault.privateAllowed = [...vault.tabs.values()].some(
    (tab) => tab.privateAllowed,
  )
}

/** Whether the gate lets a tab's main frame open a site. */
export function mayOpen(vault: VaultBrowser, tab: Tab, url: string): boolean {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true
  }

  if (isPcpSite(parsed, vault.publicUrl ?? undefined)) {
    return false
  }

  const host = siteKey(parsed)

  if (tab.control === "owner" || tab.rules === null) {
    return true
  }

  return (
    tab.allowedHosts.has(host) ||
    resolveFetchAccess(tab.rules, host, "GET").access === "allowed"
  )
}

async function attach(
  vault: VaultBrowser,
  page: Page,
  meta: Pick<Tab, "openedBy" | "tokenId" | "rules" | "privateAllowed"> & {
    allowedHosts?: Iterable<string>
  },
): Promise<Tab> {
  const cdp = await vault.context.newCDPSession(page)
  const { frameTree } = await cdp.send("Page.getFrameTree")
  const now = Date.now()
  const tab: Tab = {
    id: newTabId(),
    page,
    cdp,
    mainFrameId: frameTree.frame.id,
    openedBy: meta.openedBy,
    tokenId: meta.tokenId,
    rules: meta.rules,
    privateAllowed: meta.privateAllowed,
    allowedHosts: new Set(meta.allowedHosts ?? []),
    control: "assistant",
    handoverSince: null,
    lastBlocked: null,
    dialog: null,
    createdAt: now,
    lastUsedAt: now,
    extra: new Map(),
  }

  // The gate: every document the main frame is about to load, redirects
  // included, before a byte is sent. Frames inside a page are not gated
  // here (the proxy still checks their addresses).
  cdp.on("Fetch.requestPaused", (event) => {
    const allow =
      event.frameId !== tab.mainFrameId ||
      mayOpen(vault, tab, event.request.url)

    if (!allow) {
      try {
        tab.lastBlocked = siteKey(new URL(event.request.url))
      } catch {
        tab.lastBlocked = null
      }
    }

    // A navigation answered 204 does not navigate: the tab stays on the
    // page it was on, rather than showing an error page.
    void (
      allow
        ? cdp.send("Fetch.continueRequest", { requestId: event.requestId })
        : cdp.send("Fetch.fulfillRequest", {
            requestId: event.requestId,
            responseCode: 204,
            responseHeaders: [],
          })
    ).catch(() => {})
  })
  await cdp.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
    ],
  })

  page.on("dialog", (dialog) => {
    tab.dialog = dialog
    setTimeout(() => {
      if (tab.dialog === dialog) {
        tab.dialog = null
        dialog.dismiss().catch(() => {})
      }
    }, DIALOG_DISMISS_MS).unref()
  })
  page.on("close", () => {
    vault.tabs.delete(tab.id)
    for (const [token, id] of vault.lastTabByToken) {
      if (id === tab.id) vault.lastTabByToken.delete(token)
    }
    recomputePrivate(vault)
  })

  vault.tabs.set(tab.id, tab)
  recomputePrivate(vault)
  return tab
}

async function adoptPopup(vault: VaultBrowser, page: Page): Promise<void> {
  const opener = await page.opener()

  // A page PCP opened itself (openTab) has no opener, and is attached there.
  if (!opener) {
    return
  }

  const parent = [...vault.tabs.values()].find((tab) => tab.page === opener)

  if (!parent || vault.tabs.size >= MAX_TABS) {
    await page.close()
    return
  }

  const tab = await attach(vault, page, {
    openedBy: parent.openedBy,
    tokenId: parent.tokenId,
    rules: parent.rules,
    privateAllowed: parent.privateAllowed,
    allowedHosts: parent.allowedHosts,
  })
  tab.control = parent.control

  // The popup may have started loading before the gate was on.
  const url = page.url()

  if (url && url !== "about:blank" && !mayOpen(vault, tab, url)) {
    tab.lastBlocked = siteKey(new URL(url))
    await page.goto("about:blank").catch(() => {})
  }

  if (parent.tokenId) {
    vault.lastTabByToken.set(parent.tokenId, tab.id)
  }
}

/** A new, empty tab. */
export async function openTab(
  vault: VaultBrowser,
  meta: Pick<Tab, "openedBy" | "tokenId" | "rules" | "privateAllowed">,
): Promise<Tab> {
  if (vault.tabs.size >= MAX_TABS) {
    throw new PcpError(
      "state",
      `The browser has ${MAX_TABS} tabs open, as many as it keeps. Close one first.`,
    )
  }

  const page = await vault.context.newPage()
  const tab = await attach(vault, page, meta)

  if (meta.tokenId) {
    vault.lastTabByToken.set(meta.tokenId, tab.id)
  }

  return tab
}

export function getTab(vaultId: string, id: string): Tab | null {
  return runningBrowser(vaultId)?.tabs.get(id) ?? null
}

export async function closeTab(vault: VaultBrowser, tab: Tab): Promise<void> {
  await tab.page.close().catch(() => {})
  vault.tabs.delete(tab.id)
  recomputePrivate(vault)
}

/** Who drives a tab. A hand-over keeps it the owner's until they answer. */
export function setControl(
  tab: Tab,
  control: TabControl,
  { handover = false }: { handover?: boolean } = {},
): void {
  if (control === "assistant" && tab.control === "owner") {
    // Where the owner left it is where the assistant may go on from.
    try {
      tab.allowedHosts.add(siteKey(new URL(tab.page.url())))
    } catch {
      // about:blank and the like have no site.
    }
  }

  tab.control = control
  tab.handoverSince = control === "owner" && handover ? Date.now() : null
}

export async function tabTitle(tab: Tab): Promise<string> {
  return (await tab.page.title().catch(() => "")).slice(0, 300)
}

export async function tabView(tab: Tab): Promise<TabView> {
  return {
    id: tab.id,
    url: tab.page.url(),
    title: await tabTitle(tab),
    openedBy: tab.openedBy,
    control: tab.control,
    handover: tab.handoverSince !== null,
    lastUsedAt: new Date(tab.lastUsedAt).toISOString(),
  }
}

export async function listTabs(vaultId: string): Promise<TabView[]> {
  const vault = runningBrowser(vaultId)

  if (!vault) {
    return []
  }

  return Promise.all(
    [...vault.tabs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(tabView),
  )
}

export type BrowserStatus = {
  running: boolean
  sandbox: boolean | null
  tabs: number
  startedAt: string | null
}

export function browserStatus(vaultId: string): BrowserStatus {
  const vault = runningBrowser(vaultId)

  return {
    running: vault !== null,
    sandbox: vault?.sandbox ?? null,
    tabs: vault?.tabs.size ?? 0,
    startedAt: vault ? new Date(vault.startedAt).toISOString() : null,
  }
}
