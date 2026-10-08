import type { CallToolResult } from "@modelcontextprotocol/server"

import type { McpServer } from "@/lib/generated/prisma/client"

import type { VaultContext } from "../context"
import { db } from "../db"
import { PcpError } from "../errors"
import { CHALLENGE_LINE } from "../fetch/challenge"
import { isPcpSite } from "../fetch/fetch"
import { htmlToMarkdown, sliceText } from "../fetch/html"
import { resolvePrivateAccess, siteKey } from "../fetch/rules"
import { hiddenCharacter } from "../memories"
import { PERMISSION_TTL_MS } from "../permission-rules"
import { checkRateLimit } from "../rate-limit"
import { decideSite, loadFetchRules } from "../web-fetch"
import {
  ACTION_TIMEOUT_MS,
  BROWSER_ACTIONS,
  CHALLENGE_WAIT_MS,
  DEFAULT_READ_CHARS,
  MAX_SCREENSHOT_BYTES,
  MAX_TABS,
  MAX_URL_LENGTH,
  NAVIGATION_TIMEOUT_MS,
} from "./limits"
import {
  closeTab,
  ensureBrowser,
  mayOpen,
  openTab,
  recomputePrivate,
  runningBrowser,
  saveVaultProfile,
  setControl,
  tabTitle,
  tabView,
  touch,
  withVault,
  type Tab,
  type VaultBrowser,
} from "./runtime"
import { findInSnapshot, resolveRef, snapshotTree } from "./snapshot"
import { browserToolSpec, parseBrowserArgs } from "./tools"
import { OwnerNeeded, type BrowseAsk } from "./types"

/**
 * Running a browser tool for an assistant: which tab, whether the site may
 * be opened (the token's web fetch lines, decided as web_fetch decides
 * them, a new site getting a line of its own), and what the page looks
 * like afterwards. A site that asks, and a hand-over, end in OwnerNeeded,
 * which the gateway turns into a permission request. A site's check of its
 * visitors is not one: the tab waits for it to pass on its own, and the
 * answer says when it does not, so the assistant can hand the tab over.
 *
 * A token sees and drives only the tabs it opened (and their popups):
 * another token's tab, or the owner's own, is answered as a tab that does
 * not exist, so neither its page nor its address reaches the token, and a
 * site the owner allowed once for a tab stays with the token whose tab it
 * is. Nor does a token act on a page its lines no longer let it open.
 *
 * Refusals that name a site or an address are tool errors, never thrown
 * PcpErrors: the request log keeps the text of the latter, and which sites
 * an assistant opened is the owner's to see on the token's page, not the
 * log's.
 */

export type BrowserScope = {
  ctx: VaultContext
  tokenId: string
  publicUrl: string
  serverId: string
}

function text(value: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
  }
}

export function tabLink(publicUrl: string, tabId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/browser/tabs/${encodeURIComponent(tabId)}`
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split("\n")[0] ?? "").slice(0, 300)
}

/** A page address an assistant gave, checked. */
export function pageUrl(raw: string): URL {
  let url: URL

  try {
    url = new URL(raw.trim())
  } catch {
    throw new PcpError(
      "validation",
      "Give a full address, like https://example.com/page.",
    )
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PcpError(
      "validation",
      "The browser opens http:// and https:// addresses only.",
    )
  }

  if (url.username || url.password) {
    throw new PcpError(
      "validation",
      "Leave the user name and password out of the address; sign in on the page, or hand the tab to the owner.",
    )
  }

  if (url.href.length > MAX_URL_LENGTH) {
    throw new PcpError("validation", "That address is too long.")
  }

  return url
}

async function tokenName(tokenId: string): Promise<string> {
  const token = await db().apiToken.findUnique({
    where: { id: tokenId },
    select: { name: true },
  })
  return token?.name ?? "an assistant"
}

/**
 * The token's own tab by its id: one it opened, or a popup of one. Any
 * other tab, the owner's own included, is not there for it.
 */
function ownTab(
  vault: VaultBrowser | null | undefined,
  tokenId: string,
  tabId: string | null | undefined,
): Tab | null {
  const tab = tabId ? vault?.tabs.get(tabId) : undefined
  return tab && tab.tokenId === tokenId ? tab : null
}

/** Makes the token's own tab follow its lines, as they are now. */
async function driveAs(
  vault: VaultBrowser,
  tab: Tab,
  scope: Pick<BrowserScope, "ctx" | "tokenId">,
): Promise<void> {
  const rules = await loadFetchRules(scope.ctx.vaultId, scope.tokenId)
  tab.rules = rules
  tab.privateAllowed = resolvePrivateAccess(rules)
  tab.lastUsedAt = Date.now()
  vault.lastTabByToken.set(scope.tokenId, tab.id)
  recomputePrivate(vault)
}

/**
 * The owner hands a tab they hold to a token (one they checked may use the
 * browser): it becomes that token's tab, following its lines, and the site
 * it is at counts as one the owner allowed for the tab, as Allow once does.
 * Sites allowed for the token it was before were that token's, and go.
 */
export async function giveTab(
  ctx: VaultContext,
  vault: VaultBrowser,
  tab: Tab,
  tokenId: string,
): Promise<void> {
  if (tab.tokenId !== tokenId) {
    tab.allowedHosts.clear()
    tab.lastBlocked = null

    if (tab.tokenId && vault.lastTabByToken.get(tab.tokenId) === tab.id) {
      vault.lastTabByToken.delete(tab.tokenId)
    }

    tab.tokenId = tokenId
  }

  try {
    tab.allowedHosts.add(siteKey(new URL(tab.page.url())))
  } catch {
    // about:blank and the like have no site.
  }

  await driveAs(vault, tab, { ctx, tokenId })
  setControl(tab, "assistant")
}

/**
 * Whether the owner has the tab. A hand-over nobody answered goes back to
 * the assistants once its request has expired.
 */
function ownerHas(tab: Tab): boolean {
  if (
    tab.control === "owner" &&
    tab.handoverSince !== null &&
    Date.now() - tab.handoverSince > PERMISSION_TTL_MS
  ) {
    setControl(tab, "assistant")
  }

  return tab.control === "owner"
}

function ownerHolds(tab: Tab): CallToolResult {
  return text(
    tab.handoverSince !== null
      ? `The owner is working in tab ${tab.id} after your hand_over, and the browser tools leave it alone until they are done. When they say they are, call check_permission with the id hand_over gave, then take a snapshot.`
      : `The owner has taken over tab ${tab.id} in PCP, and the browser tools leave it alone until they hand it back. Ask them, or use another tab.`,
    true,
  )
}

/**
 * The tab a call is for: the one named, or the token's current one, and
 * only ever one of the token's own.
 */
function pickTab(
  vault: VaultBrowser | null,
  tokenId: string,
  tabId: string | undefined,
): Tab | CallToolResult {
  const tab = ownTab(
    vault,
    tokenId,
    tabId ?? vault?.lastTabByToken.get(tokenId),
  )

  if (!tab) {
    return text(
      tabId
        ? `There is no tab ${tabId}: it was closed, or the browser has closed since (it closes after a while with nothing to do). tabs lists this token's open ones.`
        : "This token has no tab open. Open a page with navigate, or tabs with action open.",
      true,
    )
  }

  return tab
}

function isTab(value: Tab | CallToolResult): value is Tab {
  return "page" in value
}

/**
 * Refuses a page the token may not open now: its lines changed since the
 * tab opened it, or the tab's history holds a page the owner opened there.
 * The tab can still be sent elsewhere with navigate, or closed.
 */
function offLimits(vault: VaultBrowser, tab: Tab): CallToolResult | null {
  const address = tab.page.url()

  if (mayOpen(vault, tab, address)) {
    return null
  }

  let host: string

  try {
    host = siteKey(new URL(address))
  } catch {
    host = "its site"
  }

  return text(
    `Tab ${tab.id} shows a page at ${host}, which this token may not open now, so the browser tools leave the page alone. Open another page in the tab with navigate, or close it with tabs.`,
    true,
  )
}

/**
 * Notes a site the gate stopped: on the token's page as a site it tried
 * (a line of its own on first sight, as web_fetch does), and in the
 * answer, so the assistant can ask for it.
 */
async function blockedNote(scope: BrowserScope, tab: Tab): Promise<string[]> {
  const host = tab.lastBlocked

  if (!host) {
    return []
  }

  tab.lastBlocked = null
  await decideSite(scope, host, "GET").catch(() => null)

  return [
    `The page tried to open ${host}, which this token may not open yet, so it stayed where it was. To go there, call navigate with that address: the owner is asked first.`,
  ]
}

/**
 * What an answer leads with while the tab shows a site's check of its
 * visitors (challenge.ts), once the tab has given it its time: the
 * assistant decides whether to hand the tab over; nothing asks the owner
 * on its own.
 */
const CHECK_LEAD = `${CHALLENGE_LINE} It did not pass on its own in this tab: call hand_over so the owner can pass it themselves, then take a snapshot.`

function checkLead(tab: Tab): string[] {
  return tab.documents.challenged() ? [CHECK_LEAD] : []
}

/**
 * Gives a site's check the tab shows the time most take to pass on their
 * own: its script reloads or posts back, and the next document is the
 * page. The clearance it leaves is a cookie in the vault's profile, saved
 * with the rest of the sign-ins.
 */
async function passCheck(tab: Tab): Promise<void> {
  if (tab.documents.challenged()) {
    await tab.documents.pass(CHALLENGE_WAIT_MS)
  }
}

/** The tab as an answer: where it is, how to watch it, and its snapshot. */
async function report(
  scope: BrowserScope,
  tab: Tab,
  { snapshot = true, lead = [] as string[] } = {},
): Promise<CallToolResult> {
  const lines = [
    ...checkLead(tab),
    ...lead,
    `Tab ${tab.id}: ${(await tabTitle(tab)) || "(no title)"}`,
    `Address: ${tab.page.url()}`,
    `The owner can watch it or take over at ${tabLink(scope.publicUrl, tab.id)}`,
    ...(await blockedNote(scope, tab)),
  ]

  if (tab.dialog) {
    lines.push(
      `The page shows a ${tab.dialog.type()}: "${tab.dialog.message().slice(0, 500)}". Nothing else on it responds until it is answered with handle_dialog.`,
    )
    return text(lines.join("\n"))
  }

  if (snapshot) {
    try {
      lines.push("", "Snapshot:", await snapshotTree(tab.page))
    } catch (error) {
      lines.push("", `The snapshot could not be taken: ${firstLine(error)}`)
    }
  }

  return text(lines.join("\n"))
}

/** Waits briefly for what an action started to load, and for its check. */
async function settle(tab: Tab): Promise<void> {
  await tab.page
    .waitForLoadState("domcontentloaded", { timeout: 5_000 })
    .catch(() => {})
  await passCheck(tab)
}

/** Why a page could not be opened, in words. */
function navigationFailure(
  vault: VaultBrowser,
  tab: Tab,
  url: URL,
  error: unknown,
  since: number,
): string {
  const host = siteKey(url)

  if (tab.lastBlocked) {
    return `${host} redirected to ${tab.lastBlocked}, which this token may not open yet, so the browser stopped. Call navigate with an address there to ask the owner.`
  }

  const refusal = vault.proxy.refusal(url.hostname, since)

  if (refusal === "own") {
    return `${host} is, or resolves to, PCP's own address, which the browser never opens.`
  }

  if (refusal === "private") {
    return `${host} is, or resolves to, a private or local address, which the owner has not allowed for this token. They can allow private addresses on the token's page in PCP.`
  }

  return `${host} could not be opened: ${firstLine(error)}`
}

/**
 * Opens a page the token may open, in its tab or a new one. Exported for
 * the owner's answer to a `browse` request, which allows the site for the
 * tab while it is open.
 */
export async function performNavigate(
  scope: BrowserScope,
  ask: Pick<BrowseAsk, "tabId" | "url">,
  { allowedByOwner = false }: { allowedByOwner?: boolean } = {},
): Promise<CallToolResult> {
  const url = pageUrl(ask.url)

  if (isPcpSite(url, scope.publicUrl)) {
    return text(
      `${url.host} is PCP's own address, which the browser never opens.`,
      true,
    )
  }

  const vault = await ensureBrowser(scope.ctx, { publicUrl: scope.publicUrl })

  return withVault(vault, async () => {
    let tab = ownTab(vault, scope.tokenId, ask.tabId)

    if (tab && ownerHas(tab)) {
      return ownerHolds(tab)
    }

    if (!tab && vault.tabs.size >= MAX_TABS) {
      // Only how many: the other tabs' pages are not this token's to see.
      const mine = [...vault.tabs.values()].filter(
        (open) => open.tokenId === scope.tokenId,
      ).length

      return text(
        mine > 0
          ? `The browser has ${MAX_TABS} tabs open, as many as it keeps. Close one of this token's first (tabs with action close), or open the page in one of them.`
          : `The browser has ${MAX_TABS} tabs open, as many as it keeps, and none is this token's. The owner can close one on PCP's Browser page.`,
        true,
      )
    }

    tab ??= await openTab(vault, {
      openedBy: await tokenName(scope.tokenId),
      tokenId: scope.tokenId,
      rules: null,
      privateAllowed: false,
    })
    await driveAs(vault, tab, scope)

    if (allowedByOwner) {
      tab.allowedHosts.add(siteKey(url))
    }

    tab.lastBlocked = null
    const since = Date.now()
    const go = () =>
      tab.page.goto(url.href, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      })

    try {
      await go().catch(async (error) => {
        // Leaving an error page, Chromium can start the same navigation
        // twice, and Playwright reports the first as interrupted: what
        // counts is whether the tab gets there.
        if (!/interrupted by another navigation/.test(firstLine(error))) {
          throw error
        }

        await tab.page
          .waitForURL((current) => current.href === url.href, {
            waitUntil: "domcontentloaded",
            timeout: NAVIGATION_TIMEOUT_MS,
          })
          .catch(() => {
            throw error
          })
      })
    } catch (error) {
      const failure = navigationFailure(vault, tab, url, error, since)
      tab.lastBlocked = null
      await settle(tab)
      await saveVaultProfile(scope.ctx, vault, { force: true })
      return report(scope, tab, { lead: [failure], snapshot: false }).then(
        (result) => ({ ...result, isError: true }),
      )
    }

    await passCheck(tab)
    await saveVaultProfile(scope.ctx, vault, { force: true })
    return report(scope, tab)
  })
}

/** tabs open and navigate: decided per site before anything opens. */
async function openSite(
  scope: BrowserScope,
  tabId: string | null,
  rawUrl: string,
  toolName: BrowseAsk["toolName"],
): Promise<CallToolResult> {
  const url = pageUrl(rawUrl)

  if (isPcpSite(url, scope.publicUrl)) {
    return text(
      `${url.host} is PCP's own address, which the browser never opens.`,
      true,
    )
  }

  const decided = await decideSite(scope, siteKey(url), "GET")

  if (decided.access === "blocked") {
    return text(
      decided.by === "site"
        ? `The owner has blocked ${decided.host} for this token, so the browser did not open it.`
        : "The owner has blocked reading pages (GET) for this token, so the browser opens nothing. They decide per site and per method on the token's page in PCP.",
      true,
    )
  }

  // Another token's tab, or one that is gone, is not there for this token:
  // the page opens in a new tab of its own.
  const tab = ownTab(runningBrowser(scope.ctx.vaultId), scope.tokenId, tabId)
  const inTab = tab?.id ?? null

  if (decided.access === "ask" && !tab?.allowedHosts.has(decided.host)) {
    throw new OwnerNeeded({
      kind: "browse",
      input: {
        serverId: scope.serverId,
        tabId: inTab,
        url: url.href,
        toolName,
      },
    })
  }

  return performNavigate(scope, { tabId: inTab, url: url.href })
}

async function tabs(
  scope: BrowserScope,
  args: { action: string; url?: string; tab?: string },
): Promise<CallToolResult> {
  const vault = runningBrowser(scope.ctx.vaultId)

  if (args.action === "open") {
    return openSite(scope, null, args.url!, "tabs")
  }

  if (args.action === "list") {
    const open = await Promise.all(
      [...(vault?.tabs.values() ?? [])]
        .filter((tab) => tab.tokenId === scope.tokenId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(tabView),
    )

    if (open.length === 0) {
      return text(
        "This token has no tab open. Open a page with navigate, or tabs with action open.",
      )
    }

    const current = vault?.lastTabByToken.get(scope.tokenId)
    return text(
      [
        "This token's open tabs (the one marked * is its current tab):",
        ...open.map(
          (view) =>
            `${view.id === current ? "*" : "-"} ${view.id}: ${view.title || "(no title)"} · ${view.url}${view.control === "owner" ? " · the owner has it" : ""} · ${tabLink(scope.publicUrl, view.id)}`,
        ),
      ].join("\n"),
    )
  }

  const picked = pickTab(vault, scope.tokenId, args.tab)

  if (!isTab(picked)) {
    return picked
  }

  if (ownerHas(picked)) {
    return ownerHolds(picked)
  }

  if (args.action === "close") {
    await withVault(vault!, () => closeTab(vault!, picked))
    await saveVaultProfile(scope.ctx, vault!, { force: true })
    return text(`Closed tab ${picked.id}.`)
  }

  await driveAs(vault!, picked, scope)
  return offLimits(vault!, picked) ?? report(scope, picked)
}

async function onTab(
  scope: BrowserScope,
  tabId: string | undefined,
  { changes }: { changes: boolean },
  run: (tab: Tab, vault: VaultBrowser) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const vault = runningBrowser(scope.ctx.vaultId)
  const picked = pickTab(vault, scope.tokenId, tabId)

  if (!isTab(picked)) {
    return picked
  }

  if (ownerHas(picked)) {
    return ownerHolds(picked)
  }

  if (vault!.publicUrl !== scope.publicUrl) {
    vault!.publicUrl = scope.publicUrl
  }

  touch(scope.ctx.vaultId)

  return withVault(vault!, async () => {
    await driveAs(vault!, picked, scope)
    const refused = offLimits(vault!, picked)

    if (refused) {
      return refused
    }

    let result: CallToolResult

    try {
      result = await run(picked, vault!)
    } catch (error) {
      if (error instanceof PcpError || error instanceof OwnerNeeded) {
        throw error
      }

      result = text(firstLine(error), true)
    }

    if (changes) {
      await saveVaultProfile(scope.ctx, vault!, { force: true })
    }

    return result
  })
}

function staleRef(ref: string): CallToolResult {
  return text(
    `There is no element ${ref} on the page now: refs hold until the next snapshot. Take a new snapshot and use its refs.`,
    true,
  )
}

async function screenshotOf(tab: Tab): Promise<Buffer> {
  for (const quality of [70, 50, 35, 20]) {
    const picture = await tab.page.screenshot({
      type: "jpeg",
      quality,
      timeout: ACTION_TIMEOUT_MS,
    })

    if (picture.length <= MAX_SCREENSHOT_BYTES) {
      return picture
    }
  }

  throw new PcpError("state", "The page's picture is too large to hand back.")
}

/**
 * Runs one browser tool for an assistant. `serverId` is the browser's row;
 * `publicUrl` makes the links to PCP's page for each tab.
 */
export async function callBrowserTool(
  ctx: VaultContext,
  server: Pick<McpServer, "id" | "name">,
  toolName: string,
  rawArgs: Record<string, unknown>,
  { tokenId, publicUrl }: { tokenId: string; publicUrl: string },
): Promise<CallToolResult> {
  const spec = browserToolSpec(toolName)

  if (!spec) {
    throw new PcpError(
      "state",
      `${server.name} has no tool called ${toolName}.`,
    )
  }

  const args = parseBrowserArgs(spec, rawArgs)

  if (!checkRateLimit(`browser:${tokenId}`, BROWSER_ACTIONS)) {
    return text(
      "That is a lot of browsing in a short time. Wait a few minutes.",
      true,
    )
  }

  const scope: BrowserScope = { ctx, tokenId, publicUrl, serverId: server.id }
  const tab = args.tab as string | undefined

  switch (spec.name) {
    case "tabs":
      return tabs(scope, args as { action: string; url?: string; tab?: string })
    case "navigate":
      return openSite(
        scope,
        tab ?? runningBrowser(ctx.vaultId)?.lastTabByToken.get(tokenId) ?? null,
        args.url as string,
        "navigate",
      )
    case "back":
      return onTab(scope, tab, spec, async (current) => {
        const went = await current.page
          .goBack({
            waitUntil: "domcontentloaded",
            timeout: NAVIGATION_TIMEOUT_MS,
          })
          .catch(() => null)
        await passCheck(current)
        return report(scope, current, {
          lead: went
            ? []
            : ["There is no earlier page in this tab, or it did not load."],
        })
      })
    case "snapshot":
      return onTab(scope, tab, spec, (current) => report(scope, current))
    case "read_page":
      return onTab(scope, tab, spec, async (current) => {
        const { title, markdown } = htmlToMarkdown(
          await current.page.content(),
          current.page.url(),
        )
        const start = (args.start_index as number | undefined) ?? 0
        const max =
          (args.max_length as number | undefined) ?? DEFAULT_READ_CHARS
        const slice = sliceText(markdown, start, max)
        const more =
          slice.end < slice.total
            ? `; call again with start_index ${slice.end} for the rest`
            : ""

        return text(
          [
            ...checkLead(current),
            `Tab ${current.id}: ${title ?? "(no title)"}`,
            `Address: ${current.page.url()}`,
            `Characters ${slice.start} to ${slice.end} of ${slice.total}${more}.`,
            "",
            slice.part,
          ].join("\n"),
        )
      })
    case "find":
      return onTab(scope, tab, spec, async (current) => {
        const found = findInSnapshot(
          await snapshotTree(current.page),
          args.text as string,
        )
        return text(
          found.length === 0
            ? `Nothing in tab ${current.id}'s snapshot mentions that.`
            : [`In tab ${current.id}:`, ...found].join("\n"),
        )
      })
    case "click":
      return onTab(scope, tab, spec, async (current) => {
        const ref = args.ref as string
        const target = await resolveRef(current.page, ref)
        if (!target) return staleRef(ref)
        await target.click({
          timeout: ACTION_TIMEOUT_MS,
          clickCount: args.double ? 2 : 1,
        })
        await settle(current)
        return report(scope, current)
      })
    case "type":
      return onTab(scope, tab, spec, async (current) => {
        const ref = args.ref as string
        const field = await resolveRef(current.page, ref)
        if (!field) return staleRef(ref)
        await field.fill(args.text as string, { timeout: ACTION_TIMEOUT_MS })
        if (args.submit) {
          await field.press("Enter", { timeout: ACTION_TIMEOUT_MS })
        }
        await settle(current)
        return report(scope, current)
      })
    case "press_key":
      return onTab(scope, tab, spec, async (current) => {
        await current.page.keyboard.press(args.key as string)
        await settle(current)
        return report(scope, current)
      })
    case "select_option":
      return onTab(scope, tab, spec, async (current) => {
        const ref = args.ref as string
        const list = await resolveRef(current.page, ref)
        if (!list) return staleRef(ref)
        await list.selectOption(args.values as string[], {
          timeout: ACTION_TIMEOUT_MS,
        })
        await settle(current)
        return report(scope, current)
      })
    case "scroll":
      return onTab(scope, tab, spec, async (current) => {
        if (args.ref) {
          const target = await resolveRef(current.page, args.ref as string)
          if (!target) return staleRef(args.ref as string)
          await target.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
        } else {
          const amount = (args.amount as number | undefined) ?? 600
          const direction = args.direction as string
          await current.page.mouse.wheel(
            direction === "left" ? -amount : direction === "right" ? amount : 0,
            direction === "up" ? -amount : direction === "down" ? amount : 0,
          )
        }
        return report(scope, current)
      })
    case "wait_for":
      return onTab(scope, tab, spec, async (current) => {
        if (args.ms) {
          await current.page.waitForTimeout(args.ms as number)
          return report(scope, current)
        }

        const appeared = await current.page
          .getByText(args.text as string)
          .first()
          .waitFor({ timeout: 30_000 })
          .then(() => true)
          .catch(() => false)

        return report(scope, current, {
          lead: appeared ? [] : ["That text did not appear within 30 seconds."],
        })
      })
    case "screenshot":
      return onTab(scope, tab, spec, async (current) => {
        if (current.dialog) {
          return report(scope, current, { snapshot: false })
        }
        const picture = await screenshotOf(current)
        return {
          content: [
            {
              type: "text",
              text: `Tab ${current.id}: ${current.page.url()} (1280 by 800, as the owner would see it at ${tabLink(publicUrl, current.id)})`,
            },
            {
              type: "image",
              data: picture.toString("base64"),
              mimeType: "image/jpeg",
            },
          ],
        }
      })
    case "handle_dialog":
      return onTab(scope, tab, spec, async (current) => {
        const dialog = current.dialog

        if (!dialog) {
          return text(`No dialog is open in tab ${current.id}.`, true)
        }

        current.dialog = null
        await (
          args.action === "accept"
            ? dialog.accept(args.text as string | undefined)
            : dialog.dismiss()
        ).catch(() => {})
        await settle(current)
        return report(scope, current)
      })
    case "hand_over":
      return onTab(scope, tab, spec, async (current) => {
        const message = (args.message as string).trim()
        const hidden = hiddenCharacter(message)

        if (hidden) {
          throw new PcpError(
            "validation",
            `The message has a character that does not show on screen (${hidden}); write it in plain text.`,
          )
        }

        setControl(current, "owner", { handover: true })
        throw new OwnerNeeded({
          kind: "browser_handover",
          input: {
            serverId: scope.serverId,
            tabId: current.id,
            message,
            url: current.page.url(),
            title: await tabTitle(current),
          },
        })
      })
  }
}

/**
 * The owner's answer to a hand-over: the tab goes back to the assistants,
 * and what the owner did there (a sign-in) is saved with their key.
 */
export async function finishHandover(
  ctx: VaultContext,
  tabId: string,
): Promise<boolean> {
  const vault = runningBrowser(ctx.vaultId)
  const tab = vault?.tabs.get(tabId)

  if (!vault || !tab) {
    return false
  }

  if (tab.control === "owner" && tab.handoverSince !== null) {
    setControl(tab, "assistant")
  }

  await saveVaultProfile(ctx, vault, { force: true }).catch((error) =>
    console.error("[browser] saving the profile failed", error),
  )
  return true
}
