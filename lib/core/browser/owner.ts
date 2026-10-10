import type { VaultContext } from "../context"
import { dataDir } from "../data-dir"
import { db } from "../db"
import { PcpError } from "../errors"
import { isPcpSite } from "../fetch/fetch"
import { resolvePrivateAccess } from "../fetch/rules"
import { loadSharedFetchRules } from "../web-fetch"
import { giveTab, pageUrl } from "./call"
import { wantsVirtualDisplay } from "./display"
import { chromiumExecutable } from "./executable"
import {
  chromiumInstallState,
  chromiumInstalling,
  installChromium,
  installedChromium,
  olderChromiumInstalled,
  type InstallState,
} from "./install"
import { NAVIGATION_TIMEOUT_MS } from "./limits"
import { clearProfile, profileSummary, type ProfileSummary } from "./profile"
import {
  browserStatus,
  closeBrowser,
  closeTab,
  ensureBrowser,
  getTab,
  listTabs,
  openTab,
  runningBrowser,
  saveVaultProfile,
  setControl,
  tabView,
  withVault,
  type BrowserStatus,
  type Tab,
} from "./runtime"
import { findBrowserServer, syncAllBrowserTools } from "./server"
import type { TabView } from "./types"

/**
 * What the owner does with the browser from PCP's pages: open a tab of
 * their own, take one over and hand it to the token they choose, move it
 * along while they have it, close it, and forget every sign-in. Each saves
 * the profile with the key the owner's session holds.
 */

function tabOf(ctx: VaultContext, tabId: string): Tab {
  const tab = getTab(ctx.vaultId, tabId)

  if (!tab) {
    throw new PcpError(
      "not_found",
      "That tab is closed, or the browser has closed since.",
    )
  }

  return tab
}

function ownersTab(ctx: VaultContext, tabId: string): Tab {
  const tab = tabOf(ctx, tabId)

  if (tab.control !== "owner") {
    throw new PcpError("state", "Take the tab over first.")
  }

  return tab
}

async function save(ctx: VaultContext): Promise<void> {
  const vault = runningBrowser(ctx.vaultId)

  if (vault) {
    await saveVaultProfile(ctx, vault, { force: true })
  }
}

async function go(tab: Tab, raw: string, publicUrl: string): Promise<void> {
  const url = pageUrl(raw)

  if (isPcpSite(url, publicUrl)) {
    throw new PcpError(
      "validation",
      "PCP does not open its own pages in the browser.",
    )
  }

  await tab.page
    .goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => {
      // What went wrong shows in the tab itself.
    })
}

/**
 * A tab of the owner's own: no assistant sees it until the owner hands it
 * to one (handBackTab). It reaches private addresses only where the line
 * for all tokens allows.
 */
export async function openOwnerTab(
  ctx: VaultContext,
  { url, publicUrl }: { url: string; publicUrl: string },
): Promise<TabView> {
  if (!(await findBrowserServer(ctx))) {
    throw new PcpError("state", "Add the browser first.")
  }

  pageUrl(url)
  const vault = await ensureBrowser(ctx, { publicUrl })
  const shared = await loadSharedFetchRules(ctx.vaultId)
  const tab = await openTab(vault, {
    openedBy: "owner",
    tokenId: null,
    rules: null,
    privateAllowed: resolvePrivateAccess(shared),
  })
  setControl(tab, "owner")
  await go(tab, url, publicUrl)
  await save(ctx)

  return tabView(tab)
}

export async function ownerNavigate(
  ctx: VaultContext,
  tabId: string,
  { url, publicUrl }: { url: string; publicUrl: string },
): Promise<void> {
  await go(ownersTab(ctx, tabId), url, publicUrl)
  await save(ctx)
}

export async function ownerBack(
  ctx: VaultContext,
  tabId: string,
): Promise<void> {
  await ownersTab(ctx, tabId)
    .page.goBack({ timeout: NAVIGATION_TIMEOUT_MS })
    .catch(() => null)
}

export async function ownerReload(
  ctx: VaultContext,
  tabId: string,
): Promise<void> {
  await ownersTab(ctx, tabId)
    .page.reload({ timeout: NAVIGATION_TIMEOUT_MS })
    .catch(() => null)
}

/** The owner drives the tab; the browser tools leave it alone meanwhile. */
export async function takeOverTab(
  ctx: VaultContext,
  tabId: string,
): Promise<void> {
  setControl(tabOf(ctx, tabId), "owner")
}

export type BrowserToken = { id: string; name: string }

/**
 * The tokens a tab can be handed to: the vault's own, neither revoked nor
 * expired, that reach the browser (every server, or the browser among
 * theirs).
 */
export async function browserTokens(
  ctx: VaultContext,
): Promise<BrowserToken[]> {
  const server = await findBrowserServer(ctx)

  if (!server) {
    return []
  }

  return db().apiToken.findMany({
    where: {
      vaultId: ctx.vaultId,
      revokedAt: null,
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        {
          OR: [
            { allowAllServers: true },
            { servers: { some: { serverId: server.id } } },
          ],
        },
      ],
    },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  })
}

/**
 * Hands a tab the owner holds to the token they chose, which may go on from
 * the site they left it at: the token it was (the page offers it first), or
 * another, which then has it alone. A tab handed over by an assistant goes
 * back when the owner answers its request instead.
 */
export async function handBackTab(
  ctx: VaultContext,
  tabId: string,
  tokenId: string,
): Promise<void> {
  const tab = ownersTab(ctx, tabId)

  if (tab.handoverSince !== null) {
    throw new PcpError(
      "state",
      "An assistant handed you this tab: say Done (or Not now) on its request, and it goes back.",
    )
  }

  // Whatever the form said: only a live token of this vault that reaches
  // the browser.
  if (!(await browserTokens(ctx)).some((token) => token.id === tokenId)) {
    throw new PcpError(
      "validation",
      "Choose a token that can use the browser: one that is not revoked or expired and reaches the browser.",
    )
  }

  const vault = runningBrowser(ctx.vaultId)!
  await withVault(vault, () => giveTab(ctx, vault, tab, tokenId))
  await save(ctx)
}

export async function closeOwnerTab(
  ctx: VaultContext,
  tabId: string,
): Promise<void> {
  const vault = runningBrowser(ctx.vaultId)
  const tab = tabOf(ctx, tabId)
  await closeTab(vault!, tab)
  await save(ctx)
}

/** Closes the browser, its sign-ins saved first. */
export async function stopBrowser(ctx: VaultContext): Promise<void> {
  await closeBrowser(ctx.vaultId, { ctx })
}

/** Signs the browser out of everything: closed unsaved, profile dropped. */
export async function forgetSites(ctx: VaultContext): Promise<void> {
  await closeBrowser(ctx.vaultId)
  await clearProfile(ctx)
}

/**
 * Installs Chromium for the machine, from Playwright's addresses
 * (install.ts), unless it is already there or being installed. Returns at
 * once: the Browser page follows it, and the browser rows turn ready when
 * it is done.
 */
export async function startChromiumInstall(): Promise<void> {
  if (chromiumInstalling()) {
    return
  }

  if (await chromiumExecutable()) {
    throw new PcpError("state", "Chromium is already on this machine.")
  }

  void installChromium({ dataDir: dataDir() })
    .then(async (state) => {
      if (state.stage === "done") {
        await syncAllBrowserTools()
      } else {
        console.error("[browser] could not install Chromium", {
          message: state.error,
        })
      }
    })
    .catch((error) => console.error("[browser] install failed", error))
}

export type BrowserOverview = {
  server: { id: string; name: string; enabled: boolean } | null
  chromium: {
    path: string | null
    /** PCP installed it, under its data folder. */
    fromInstall: boolean
    /** PCP installed one for an earlier version, which no longer runs. */
    outdated: boolean
    install: InstallState
    platform: NodeJS.Platform
    /**
     * How the browser is wanted to run on this machine: with a window on a
     * virtual display, or headless. What is running is `status.display`,
     * which differs when the display did not start.
     */
    display: "virtual" | "headless"
  }
  status: BrowserStatus
  profile: ProfileSummary | null
  tabs: TabView[]
}

export async function browserOverview(
  ctx: VaultContext,
): Promise<BrowserOverview> {
  const [server, path, installed, outdated, profile, tabs] = await Promise.all([
    findBrowserServer(ctx),
    chromiumExecutable(),
    installedChromium(dataDir()),
    olderChromiumInstalled(dataDir()),
    profileSummary(ctx.vaultId),
    listTabs(ctx.vaultId),
  ])

  return {
    server: server
      ? { id: server.id, name: server.name, enabled: server.enabled }
      : null,
    chromium: {
      path,
      fromInstall: !!installed && installed === path,
      outdated: outdated && !installed,
      install: chromiumInstallState(),
      platform: process.platform,
      display: wantsVirtualDisplay() ? "virtual" : "headless",
    },
    status: browserStatus(ctx.vaultId),
    profile,
    tabs,
  }
}

export async function tabFor(
  ctx: VaultContext,
  tabId: string,
): Promise<TabView | null> {
  const tab = getTab(ctx.vaultId, tabId)
  return tab ? tabView(tab) : null
}
