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
} from "patchright-core"

import type { VaultContext } from "../context"
import { PcpError } from "../errors"
import { isPcpSite } from "../fetch/fetch"
import { resolveFetchAccess, siteKey, type FetchRuleSet } from "../fetch/rules"
import { isOwnAddress, isPublicAddress } from "../openapi/address"
import { watchDocuments, type DocumentWatch } from "./challenge"
import { acquireDisplay, type VirtualDisplay } from "./display"
import { openDownloads, watchDownloads, type Downloads } from "./downloads"
import { chromiumExecutable } from "./executable"
import {
  contextOptions,
  keepOffScreen,
  launchOptions,
  modesToTry,
  wantedMode,
  type BrowserMode,
} from "./launch"
import {
  ACTION_TIMEOUT_MS,
  BROWSER_LOCK_DEADLINE_MS,
  DIALOG_DISMISS_MS,
  IDLE_CLOSE_MS,
  MAX_SOLVES,
  MAX_TABS,
  NAVIGATION_TIMEOUT_MS,
  PROFILE_SAVE_INTERVAL_MS,
  TITLE_TIMEOUT_MS,
} from "./limits"
import { loadProfile, saveProfile } from "./profile"
import {
  startBrowserProxy,
  type AddressVerdict,
  type BrowserProxy,
} from "./proxy"
import { bounded, inLane, newLane, type Lane } from "./queue"
import type { TabControl, TabView } from "./types"

/**
 * The browser's running side: one Chromium per vault, started on first use
 * and closed after IDLE_CLOSE_MS with nothing happening, its tabs, and who
 * drives each. It runs with windows on PCP's virtual display where there is
 * one (display.ts: the container image), with a window of its own kept off
 * the screen in the desktop app, or headless (launch.ts). One per process,
 * kept on globalThis because the gateway, the Server Actions and the route
 * handlers are bundled apart and would otherwise each have their own copy of
 * this module.
 *
 * The browser keeps nothing on disk: its context is in memory, started
 * from the vault's saved profile (profile.ts) and saved back while a
 * request holds the vault's key. The idle close has no key, so it saves
 * nothing: what a page changed on its own since the last save is lost.
 * Downloads are refused but while a download call waits for one
 * (downloads.ts), whose file is read off the scratch folder and removed
 * before the call answers.
 *
 * Every connection goes through PCP's proxy (proxy.ts), and every page a
 * tab's main frame opens passes the gate here first: the sites the token
 * that drives the tab may reach (its web fetch lines), the sites the owner
 * allowed for this tab, or anything while the owner drives it. PCP's own
 * site never.
 *
 * Work waits its turn per tab (queue.ts): the calls on one tab run one at
 * a time, each for at most its deadline, and a tab whose call passes it
 * is reopened at its address (reopenTab). Only what changes the set of
 * tabs (opening and closing one, taking a popup in, closing the browser)
 * holds the whole browser, briefly (withVault).
 *
 * Besides its tabs, the browser reads pages for web_fetch when a site
 * checks its visitors first (solve.ts): each in a page of a second context
 * of its own, which starts from none of the vault's sign-ins and is never
 * saved, and which the gate lets open its one site and nothing else. Such
 * a page is not a tab: no token or owner sees, drives or lists it.
 */

export type Tab = {
  id: string
  page: Page
  cdp: CDPSession
  mainFrameId: string
  /** "owner", or the name of the token that opened it. */
  openedBy: string
  /**
   * The token whose tab it is, and the only one that sees or drives it:
   * the one that opened it (or the tab a popup came from), or the one the
   * owner last handed it to. It stays while the owner holds the tab, as the
   * one Hand back offers first. Null for a tab the owner opened and no
   * token had yet.
   */
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
  /**
   * A file the page offered while no download call waited (refused), by
   * the name it gave: said in the next answer, then forgotten.
   */
  offeredFile: string | null
  /** What its main frame shows, and whether that is a site's check. */
  documents: DocumentWatch
  /** The calls on this tab, one at a time. */
  lane: Lane
  /**
   * The call whose turn on the lane it is now, and the run_code or wrapper
   * run it is made for (null for none); null between calls.
   */
  running: { runId: string | null } | null
  /**
   * Its page stopped responding (a call passed its deadline) or crashed:
   * it is reopened at its address, at once or on the next call.
   */
  unresponsive: boolean
  /** The page being reopened (reopenTab), which calls wait for. */
  reopening: Promise<Reopened> | null
  /** Tabs its page opened (popups), said in its next answer. */
  popups: string[]
  createdAt: number
  lastUsedAt: number
  /** The live view's state (screencast.ts) and the owner's input (input.ts). */
  extra: Map<string, unknown>
}

/**
 * A page the browser reads for web_fetch (solve.ts): in the fetch context,
 * which holds none of the vault's sign-ins, and allowed to open one site.
 */
export type Solve = {
  page: Page
  mainFrameId: string
  /** The site (siteKey: host, and a port that is not the default). */
  host: string
  /** That site's name as the proxy is asked to dial it. */
  hostname: string
  /** The token whose web_fetch it is may reach private addresses. */
  privateAllowed: boolean
  /** An address the gate kept the page from opening (another site). */
  refused: string | null
  documents: DocumentWatch
}

export type VaultBrowser = {
  vaultId: string
  browser: Browser
  context: BrowserContext
  proxy: BrowserProxy
  /** Chromium's own sandbox: off when the machine cannot give it one. */
  sandbox: boolean
  /** How it runs (launch.ts): what started, not what was wanted. */
  mode: BrowserMode
  /** The virtual display its windows are on (display.ts), in "virtual". */
  display: string | null
  /** Chromium's folder for what it keeps outside the profile (launch). */
  scratchDir: string
  /** Downloads, refused but while a download call waits (downloads.ts). */
  downloads: Downloads
  tabs: Map<string, Tab>
  /**
   * The context web_fetch's pages open in: made on the first, from none of
   * the vault's sign-ins, never saved, gone with the browser.
   */
  fetchContext: Promise<BrowserContext> | null
  /** Pages read for web_fetch, by their main frame. */
  solves: Map<string, Solve>
  /** Solves started, counting those still opening their page. */
  solving: number
  /**
   * Sites whose check a solve passed, until when (epoch ms): web_fetch reads
   * them through the browser first while it still holds the clearance.
   */
  clearances: Map<string, number>
  /** PCP's own public address, never opened. */
  publicUrl: string | null
  privateAllowed: boolean
  idleTimer: NodeJS.Timeout | null
  /** What holds the whole browser: the set of tabs changing. */
  lock: Lane
  /** Profile saves, one at a time (calls on two tabs may save at once). */
  saving: Promise<unknown>
  lastSavedAt: number
  lastSavedHash: string | null
  startedAt: number
}

type Runtime = {
  vaults: Map<string, VaultBrowser>
  starting: Map<string, Promise<VaultBrowser>>
  /** Vaults whose browser may not start: a restore is writing them. */
  held: Set<string>
  /** Replaces the address check; for tests that serve pages on loopback. */
  addressCheck: ((address: string, port: number) => boolean) | null
}

const RUNTIME = Symbol.for("pcp.browser")

function runtime(): Runtime {
  const holder = globalThis as unknown as { [RUNTIME]?: Runtime }

  holder[RUNTIME] ??= {
    vaults: new Map(),
    starting: new Map(),
    held: new Set(),
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

/** Whether a restore is writing the vault, and its browser may not run. */
export function browserHeld(vaultId: string): boolean {
  return runtime().held.has(vaultId)
}

/**
 * Runs what changes the set of tabs (opening or closing one, taking a
 * popup in, closing the browser) one at a time for the vault, for at most
 * BROWSER_LOCK_DEADLINE_MS. The calls on a tab wait in its own lane, not
 * here.
 */
export function withVault<T>(
  vault: VaultBrowser,
  run: () => Promise<T>,
): Promise<T> {
  return inLane(vault.lock, run, {
    deadlineMs: BROWSER_LOCK_DEADLINE_MS,
    onDeadline: async () => {
      throw new PcpError(
        "state",
        "The browser did not answer in time. Try again in a moment.",
      )
    },
  })
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

function bareName(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase()
}

function verdict(
  vault: VaultBrowser,
  address: string,
  port: number,
  host: string,
): AddressVerdict {
  const test = runtime().addressCheck

  if (test) {
    return test(address, port) ? "ok" : "private"
  }

  if (isOwnAddress(address, port, [vault.proxy.port])) {
    return "own"
  }

  if (isPublicAddress(address)) {
    return "ok"
  }

  // The site of a page read for web_fetch follows that request's token
  // alone: a tab's private line does not open it, and its own opens nothing
  // else.
  const solves = [...vault.solves.values()].filter(
    (solve) => solve.hostname === host,
  )

  if (solves.length > 0) {
    return solves.every((solve) => solve.privateAllowed) ? "ok" : "private"
  }

  return vault.privateAllowed ? "ok" : "private"
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
  mode: BrowserMode,
  executablePath: string,
  proxyPort: number,
  sandbox: boolean,
  scratchDir: string,
  display: VirtualDisplay | null,
): Promise<Browser> {
  const { chromium } = await import("patchright-core")

  return chromium.launch({
    ...launchOptions({ mode, executablePath, sandbox, scratchDir, display }),
    proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: "<-loopback>" },
    timeout: 30_000,
  })
}

/**
 * Chromium started in the first of `modes` that starts, with its own
 * sandbox where the machine gives one.
 */
async function launchFirst(
  modes: BrowserMode[],
  executable: string,
  proxyPort: number,
  scratchDir: string,
  display: VirtualDisplay | null,
): Promise<{ browser: Browser; mode: BrowserMode; sandbox: boolean }> {
  let failure: unknown = new Error("No mode to start Chromium in.")

  for (const [index, mode] of modes.entries()) {
    const attempt = (sandbox: boolean) =>
      launch(mode, executable, proxyPort, sandbox, scratchDir, display)
    const sandbox = sandboxSetting() !== "off"

    try {
      try {
        return { browser: await attempt(sandbox), mode, sandbox }
      } catch (error) {
        // An unprivileged container, or root, has no sandbox to give.
        if (!sandbox || sandboxSetting() === "on") throw error
        return { browser: await attempt(false), mode, sandbox: false }
      }
    } catch (error) {
      failure = error

      if (index < modes.length - 1) {
        console.error(
          `[browser] Chromium did not start in its ${mode} mode; it starts ${modes[index + 1]} instead`,
          error,
        )
      }
    }
  }

  throw failure
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

  if (state.held.has(ctx.vaultId)) {
    throw new PcpError(
      "state",
      "The vault is being restored from an export. Try again in a moment.",
    )
  }

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
    check: (address, port, host) =>
      vault ? verdict(vault, address, port, host) : "private",
  })

  const scratchDir = await makeScratchDir()
  const wanted = wantedMode()
  const screen = wanted === "virtual" ? await acquireDisplay() : null
  const display = screen?.display ?? null
  let browser: Browser
  let mode: BrowserMode
  let sandbox: boolean

  try {
    ;({ browser, mode, sandbox } = await launchFirst(
      // A virtual display that did not start leaves the browser headless.
      modesToTry(wanted === "virtual" && !display ? "headless" : wanted),
      executable,
      proxy.port,
      scratchDir,
      display,
    ))
  } catch (error) {
    screen?.release()
    await proxy.close()
    removeScratchDir(scratchDir)
    console.error("[browser] Chromium did not start", error)
    throw new PcpError(
      "state",
      "Chromium did not start on the machine PCP runs on. The owner can see why in PCP's log.",
    )
  }

  // The display is given back however the browser ends.
  browser.on("disconnected", () => screen?.release())

  let downloads: Downloads

  try {
    await startGate(browser, () => vault)
    downloads = await openDownloads(
      browser,
      path.join(scratchDir, "downloads"),
      (frameId, name) => {
        const tab = vault ? tabOfFrame(vault, frameId) : undefined
        if (tab) tab.offeredFile = name
      },
    )
  } catch (error) {
    await browser.close().catch(() => {})
    await proxy.close()
    removeScratchDir(scratchDir)
    throw error
  }

  const context = await browser.newContext({
    ...contextOptions(browser.version(), mode),
    storageState: (await loadProfile(ctx)) ?? undefined,
  })

  vault = {
    vaultId: ctx.vaultId,
    browser,
    context,
    proxy,
    sandbox,
    mode,
    display: display?.display ?? null,
    scratchDir,
    downloads,
    tabs: new Map(),
    fetchContext: null,
    solves: new Map(),
    solving: 0,
    clearances: new Map(),
    publicUrl,
    privateAllowed: false,
    idleTimer: null,
    lock: newLane(),
    saving: Promise.resolve(),
    lastSavedAt: Date.now(),
    lastSavedHash: null,
    startedAt: Date.now(),
  }

  const self = vault
  context.on("page", (page) => {
    // A page the browser opened itself (a popup, target=_blank): a tab of
    // the one that opened it, if there is room. Until then the gate decides
    // its pages by that tab (judge), so it has loaded nothing else.
    if ([...self.tabs.values()].some((tab) => tab.page === page)) return
    void withVault(self, () => adoptPopup(self, page)).catch(() =>
      page.close().catch(() => {}),
    )
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
  vault.solves.clear()
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

  const close = async () => {
    if (runningBrowser(vaultId) !== vault) return

    if (ctx) {
      await saveVaultProfile(ctx, vault, { force: true }).catch((error) =>
        console.error("[browser] saving the profile failed", error),
      )
    }

    forget(vault)
    await vault.browser.close().catch(() => {})
  }

  // A lock that does not come in time still closes the browser.
  await withVault(vault, close).catch(close)
}

/**
 * Runs `write` with the vault's browser closed, and none started until it
 * is done: for a write that replaces the vault's rows, the profile's too. A
 * call in flight finishes first, a browser still starting is waited for,
 * and the profile is saved with the key (so a write that fails loses
 * nothing). Nothing of the old browser can save over what `write` leaves.
 */
export async function withBrowserClosed<T>(
  ctx: VaultContext,
  write: () => Promise<T>,
): Promise<T> {
  const state = runtime()

  if (state.held.has(ctx.vaultId)) {
    throw new PcpError("state", "The vault is already being restored.")
  }

  state.held.add(ctx.vaultId)

  try {
    await state.starting.get(ctx.vaultId)?.catch(() => {})
    const vault = runningBrowser(ctx.vaultId)

    if (vault) {
      // The calls in flight on each tab finish (or pass their deadline);
      // any later one is refused while the vault is held.
      await Promise.all([...vault.tabs.values()].map((tab) => tab.lane.tail))
      await closeBrowser(ctx.vaultId, { ctx })
    }

    return await write()
  } finally {
    state.held.delete(ctx.vaultId)
  }
}

/** Every vault's browser, at shutdown or between tests. */
export async function closeAllBrowsers(): Promise<void> {
  for (const vaultId of [...runtime().vaults.keys()]) {
    await closeBrowser(vaultId)
  }
}

/**
 * Saves the profile, at most every PROFILE_SAVE_INTERVAL_MS unless forced,
 * one save at a time. A browser that has closed saves nothing: a call that
 * finished after it (one past its deadline) cannot write over what a
 * restore wrote since.
 */
export function saveVaultProfile(
  ctx: VaultContext,
  vault: VaultBrowser,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const save = async () => {
    if (runningBrowser(vault.vaultId) !== vault) {
      return
    }

    if (!force && Date.now() - vault.lastSavedAt < PROFILE_SAVE_INTERVAL_MS) {
      return
    }

    vault.lastSavedAt = Date.now()
    vault.lastSavedHash = await saveProfile(ctx, vault.context, {
      unless: vault.lastSavedHash,
    })
  }
  const saved = vault.saving.then(save, save)
  vault.saving = saved.catch(() => {})
  return saved
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

/** What the gate is handed: a request, paused before it is sent. */
type PausedDocument = {
  requestId: string
  frameId?: string
  resourceType?: string
  request: { url: string; headers?: Record<string, string> }
}

/**
 * Whether a request is a service worker's script being fetched, which a
 * browser marks with "Service-Worker: script" (the header's name is any
 * case here: the protocol hands headers over as sent).
 */
export function isServiceWorkerScript(
  headers: Record<string, string> | undefined,
): boolean {
  return Object.entries(headers ?? {}).some(
    ([name, value]) =>
      name.toLowerCase() === "service-worker" &&
      value.trim().toLowerCase() === "script",
  )
}

/** Whether a request goes out, and a popup to close once it is answered. */
type Verdict = { allow: boolean; close?: string }

/** The tab whose main frame this is (a page's main frame is its target). */
function tabOfFrame(vault: VaultBrowser, frameId: string): Tab | undefined {
  return [...vault.tabs.values()].find((tab) => tab.mainFrameId === frameId)
}

function noteBlocked(tab: Tab, url: string): void {
  try {
    tab.lastBlocked = siteKey(new URL(url))
  } catch {
    tab.lastBlocked = null
  }
}

async function judge(
  vault: VaultBrowser,
  gate: CDPSession,
  event: PausedDocument,
): Promise<Verdict> {
  const url = event.request.url

  if (!event.frameId) {
    return { allow: false }
  }

  const tab = tabOfFrame(vault, event.frameId)

  if (tab) {
    if (mayOpen(vault, tab, url)) {
      return { allow: true }
    }

    noteBlocked(tab, url)
    return { allow: false }
  }

  const solve = vault.solves.get(event.frameId)

  if (solve) {
    if (solveMayOpen(vault, solve, url)) {
      return { allow: true }
    }

    solve.refused = url
    return { allow: false }
  }

  // Not a tab's main frame. A frame inside a page has no target of its own
  // yet, or one of type "iframe", and is not gated per site (the proxy
  // still checks its addresses). Any other page is one PCP has not made a
  // tab of yet: a popup Playwright has not reported, which opens what its
  // opener's tab may open and is refused anything else.
  const info = await gate
    .send("Target.getTargetInfo", { targetId: event.frameId })
    .then(({ targetInfo }) => targetInfo)
    .catch(() => null)

  if (!info || info.type === "iframe") {
    return { allow: true }
  }

  const parent = info.openerId ? tabOfFrame(vault, info.openerId) : undefined
  const allowed = parent !== undefined && mayOpen(vault, parent, url)

  if (allowed && vault.tabs.size < MAX_TABS) {
    return { allow: true }
  }

  if (parent && !allowed) {
    // Said in the next answer about the tab whose page tried.
    noteBlocked(parent, url)
  }

  // A popup is a window of its own, so it is closed rather than left blank;
  // anything else (a page being prerendered) only loads nothing.
  return { allow: false, close: info.openerId ? info.targetId : undefined }
}

/**
 * The gate: every document a page's main frame is about to load, redirects
 * included, paused before a byte is sent. It is the browser's, not a tab's,
 * and on before the first page exists, so it holds for a popup from its
 * very first request, before Playwright has reported the popup to PCP.
 * Until the vault's state exists it refuses everything, as the proxy does.
 *
 * It also sees the requests of type Other, only to refuse a service
 * worker's script (isServiceWorkerScript): the registration then fails as
 * it does where the network refuses, and nothing in the page is changed.
 * Every other such request goes on at once, ahead of the verdicts.
 */
async function startGate(
  browser: Browser,
  current: () => VaultBrowser | null,
): Promise<void> {
  const gate = await browser.newBrowserCDPSession()

  gate.on("Fetch.requestPaused", (event) => {
    if (event.resourceType !== "Document") {
      void (
        isServiceWorkerScript(event.request.headers)
          ? gate.send("Fetch.failRequest", {
              requestId: event.requestId,
              errorReason: "BlockedByClient",
            })
          : gate.send("Fetch.continueRequest", { requestId: event.requestId })
      ).catch(() => {})
      return
    }

    const vault = current()

    void (vault ? judge(vault, gate, event) : Promise.resolve({ allow: false }))
      .catch((): Verdict => ({ allow: false }))
      .then(async (verdict: Verdict) => {
        // A navigation answered 204 does not navigate: the tab stays on the
        // page it was on, rather than showing an error page.
        await (
          verdict.allow
            ? gate.send("Fetch.continueRequest", { requestId: event.requestId })
            : gate.send("Fetch.fulfillRequest", {
                requestId: event.requestId,
                responseCode: 204,
                responseHeaders: [],
              })
        ).catch(() => {})

        if (verdict.close) {
          await gate
            .send("Target.closeTarget", { targetId: verdict.close })
            .catch(() => {})
        }
      })
  })
  await gate.send("Fetch.enable", {
    patterns: [
      { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
      { urlPattern: "*", resourceType: "Other", requestStage: "Request" },
    ],
  })
}

/** What PCP holds of a page: its DevTools session and main frame. */
async function pageParts(
  vault: VaultBrowser,
  page: Page,
): Promise<Pick<Tab, "page" | "cdp" | "mainFrameId" | "documents">> {
  // Every wait on the page ends: none of Playwright's has no timeout.
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
  const documents = watchDocuments(page)
  const cdp = await vault.context.newCDPSession(page)
  const { frameTree } = await cdp.send("Page.getFrameTree")

  // Every tab and popup, before PCP lets it load anything.
  if (vault.mode === "window") await keepOffScreen(cdp)

  return { page, cdp, mainFrameId: frameTree.frame.id, documents }
}

/** What a tab listens for on its page, for as long as it is the tab's. */
async function listen(
  vault: VaultBrowser,
  tab: Tab,
  page: Page,
): Promise<void> {
  const mine = () => tab.page === page

  // A page's file chooser never opens a window on the machine: a file
  // reaches a page only through upload_file.
  page.on("filechooser", () => {})
  await watchDownloads(vault.downloads, tab.cdp).catch(() => {})

  page.on("dialog", (dialog) => {
    if (!mine()) {
      dialog.dismiss().catch(() => {})
      return
    }

    tab.dialog = dialog
    setTimeout(() => {
      if (tab.dialog === dialog) {
        tab.dialog = null
        dialog.dismiss().catch(() => {})
      }
    }, DIALOG_DISMISS_MS).unref()
  })
  // Reopened on the next call (reopenTab).
  page.on("crash", () => {
    if (mine()) tab.unresponsive = true
  })
  page.on("close", () => {
    // A page closed as its tab is reopened is no longer the tab's.
    if (!mine()) return
    vault.tabs.delete(tab.id)
    recomputePrivate(vault)
  })
}

async function attach(
  vault: VaultBrowser,
  page: Page,
  meta: Pick<Tab, "openedBy" | "tokenId" | "rules" | "privateAllowed"> & {
    allowedHosts?: Iterable<string>
  },
): Promise<Tab> {
  const now = Date.now()
  const tab: Tab = {
    id: newTabId(),
    ...(await pageParts(vault, page)),
    openedBy: meta.openedBy,
    tokenId: meta.tokenId,
    rules: meta.rules,
    privateAllowed: meta.privateAllowed,
    allowedHosts: new Set(meta.allowedHosts ?? []),
    control: "assistant",
    handoverSince: null,
    lastBlocked: null,
    dialog: null,
    offeredFile: null,
    lane: newLane(),
    running: null,
    unresponsive: false,
    reopening: null,
    popups: [],
    createdAt: now,
    lastUsedAt: now,
    extra: new Map(),
  }

  await listen(vault, tab, page)
  vault.tabs.set(tab.id, tab)
  recomputePrivate(vault)
  return tab
}

/**
 * A page the browser opened itself (a popup, target=_blank) becomes a tab of
 * the one that opened it, its token's, and that tab's next answer names it.
 * Runs under withVault, so the room for it is counted with every other tab.
 */
async function adoptPopup(vault: VaultBrowser, page: Page): Promise<void> {
  const opener = await page.opener()

  // A page PCP opened itself (openTab, reopenTab) has no opener, and is
  // attached there.
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
  parent.popups.push(tab.id)
}

/** A new, empty tab. Call it under withVault. */
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
  return attach(vault, page, meta)
}

/** Where a reopened tab is now. */
export type Reopened = { address: string; loaded: boolean }

/**
 * Closes a tab's page and opens a new one in its place, at the address it
 * was at, through the gate as any page is: for a tab whose call passed its
 * deadline, whose page crashed, or that its assistant asked to reset. The
 * tab keeps its id, its token and the sites allowed for it; what the page
 * held (a form half filled, its history) is gone. Calls on the tab wait
 * for it; a second reset while one runs is the same one.
 */
export function reopenTab(vault: VaultBrowser, tab: Tab): Promise<Reopened> {
  tab.reopening ??= (async () => {
    tab.unresponsive = true
    const old = tab.page
    const address = old.url()
    const page = await vault.context.newPage()

    try {
      Object.assign(tab, await pageParts(vault, page), { dialog: null })
      await listen(vault, tab, page)
    } catch (error) {
      await page.close().catch(() => {})
      throw error
    }

    await bounded(old.close(), ACTION_TIMEOUT_MS, "page.close").catch(() => {})

    // Closed meanwhile: the new page goes too.
    if (vault.tabs.get(tab.id) !== tab) {
      await page.close().catch(() => {})
      return { address, loaded: false }
    }

    let loaded = false

    if (/^https?:/i.test(address) && mayOpen(vault, tab, address)) {
      loaded = await page
        .goto(address, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        })
        .then(
          () => true,
          () => false,
        )
    }

    tab.unresponsive = false
    tab.lastUsedAt = Date.now()
    return { address, loaded }
  })().finally(() => {
    tab.reopening = null
  })

  return tab.reopening
}

/** Whether the gate lets a page read for web_fetch open an address. */
export function solveMayOpen(
  vault: VaultBrowser,
  solve: Solve,
  url: string,
): boolean {
  let parsed: URL

  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  // Its one site, as web_fetch follows redirects only within a site:
  // another one gets its own decision when the assistant asks for it.
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    !isPcpSite(parsed, vault.publicUrl ?? undefined) &&
    siteKey(parsed) === solve.host
  )
}

function fetchContext(vault: VaultBrowser): Promise<BrowserContext> {
  vault.fetchContext ??= vault.browser
    .newContext(contextOptions(vault.browser.version(), vault.mode))
    .then((context) => {
      // A page read for web_fetch opens no windows: the gate refuses what a
      // popup would load, and the window is closed.
      context.on("page", (page) => {
        void page
          .opener()
          .then((opener) => (opener ? page.close() : undefined))
          .catch(() => {})
      })
      return context
    })
  vault.fetchContext.catch(() => {
    vault.fetchContext = null
  })

  return vault.fetchContext
}

/**
 * A blank page in the fetch context, allowed to open `url`'s site only:
 * for web_fetch (solve.ts). Close it with closeSolvePage.
 */
export async function openSolvePage(
  vault: VaultBrowser,
  { url, privateAllowed }: { url: URL; privateAllowed: boolean },
): Promise<Solve> {
  if (vault.solving >= MAX_SOLVES) {
    throw new PcpError(
      "state",
      `PCP's browser is already reading ${MAX_SOLVES} pages for web_fetch. Try again in a moment.`,
    )
  }

  vault.solving++
  let page: Page | null = null

  try {
    page = await (await fetchContext(vault)).newPage()
    const documents = watchDocuments(page)
    const cdp = await page.context().newCDPSession(page)
    const { frameTree } = await cdp.send("Page.getFrameTree")

    // The window's place is told to the page through this session, which
    // then lasts as long as the page; otherwise it is not needed.
    if (vault.mode === "window") await keepOffScreen(cdp)
    else await cdp.detach().catch(() => {})
    const solve: Solve = {
      page,
      mainFrameId: frameTree.frame.id,
      host: siteKey(url),
      hostname: bareName(url.hostname),
      privateAllowed,
      refused: null,
      documents,
    }

    vault.solves.set(solve.mainFrameId, solve)
    return solve
  } catch (error) {
    vault.solving--
    await page?.close().catch(() => {})
    throw error
  }
}

export async function closeSolvePage(
  vault: VaultBrowser,
  solve: Solve,
): Promise<void> {
  if (vault.solves.get(solve.mainFrameId) === solve) {
    vault.solves.delete(solve.mainFrameId)
  }

  vault.solving = Math.max(0, vault.solving - 1)
  await solve.page.close().catch(() => {})
}

export function getTab(vaultId: string, id: string): Tab | null {
  return runningBrowser(vaultId)?.tabs.get(id) ?? null
}

/**
 * Closes a tab, even one whose call hangs: its page closes under it, and
 * the calls queued on it are answered as for a tab that is gone. Call it
 * under withVault.
 */
export async function closeTab(vault: VaultBrowser, tab: Tab): Promise<void> {
  vault.tabs.delete(tab.id)
  recomputePrivate(vault)
  await bounded(tab.page.close(), ACTION_TIMEOUT_MS, "page.close").catch(
    () => {},
  )
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

/** The page's title, or none when the page does not say in time. */
export async function tabTitle(tab: Tab): Promise<string> {
  return (
    await bounded(tab.page.title(), TITLE_TIMEOUT_MS, "page.title").catch(
      () => "",
    )
  ).slice(0, 300)
}

export async function tabView(tab: Tab): Promise<TabView> {
  return {
    id: tab.id,
    url: tab.page.url(),
    title: await tabTitle(tab),
    openedBy: tab.openedBy,
    tokenId: tab.tokenId,
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
  /**
   * How it runs (launch.ts): with windows on the virtual display, with a
   * window of its own kept off the screen, or headless (also where a
   * display or a window was wanted and did not start). Null when it is not
   * running.
   */
  display: BrowserMode | null
}

export function browserStatus(vaultId: string): BrowserStatus {
  const vault = runningBrowser(vaultId)

  return {
    running: vault !== null,
    sandbox: vault?.sandbox ?? null,
    tabs: vault?.tabs.size ?? 0,
    startedAt: vault ? new Date(vault.startedAt).toISOString() : null,
    display: vault?.mode ?? null,
  }
}
