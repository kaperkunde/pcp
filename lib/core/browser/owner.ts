import type { VaultContext } from "../context"
import { dataDir } from "../data-dir"
import { PcpError } from "../errors"
import { isPcpSite } from "../fetch/fetch"
import { resolvePrivateAccess } from "../fetch/rules"
import { loadSharedFetchRules } from "../web-fetch"
import { pageUrl } from "./call"
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
  type BrowserStatus,
  type Tab,
} from "./runtime"
import { findBrowserServer, syncAllBrowserTools } from "./server"
import type { TabView } from "./types"

/**
 * What the owner does with the browser from PCP's pages: open a tab of
 * their own, take one over from the assistants and hand it back, move it
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
 * A tab of the owner's own, theirs alone: no assistant sees it or is
 * handed it. It reaches private addresses only where the line for all
 * tokens allows.
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

/**
 * Back to the assistant whose tab it is, which may go on from the site the
 * owner left it at. A tab handed over by an assistant goes back when the
 * owner answers its request instead, and the owner's own tab is no
 * assistant's to go back to.
 */
export async function handBackTab(
  ctx: VaultContext,
  tabId: string,
): Promise<void> {
  const tab = tabOf(ctx, tabId)

  if (tab.tokenId === null) {
    throw new PcpError(
      "state",
      "You opened this tab, so it stays yours: an assistant opens tabs of its own, and your sign-ins go with them.",
    )
  }

  if (tab.handoverSince !== null) {
    throw new PcpError(
      "state",
      "An assistant handed you this tab: say Done (or Not now) on its request, and it goes back.",
    )
  }

  setControl(tab, "assistant")
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
