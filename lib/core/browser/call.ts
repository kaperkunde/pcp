import type { CallToolResult } from "@modelcontextprotocol/server"
import type { Locator } from "patchright-core"

import type { McpServer } from "@/lib/generated/prisma/client"

import { checkSecretRequest, originOf } from "../browser-secrets"
import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, PcpError } from "../errors"
import { CHALLENGE_LINE } from "../fetch/challenge"
import { isPcpSite } from "../fetch/fetch"
import { sliceText } from "../fetch/html"
import { resolvePrivateAccess, siteKey } from "../fetch/rules"
import { bareType, fileMediaType } from "../media-types"
import { markdownLink } from "../owner-link"
import { hiddenCharacter, withoutPresentation } from "../memories"
import { browserToolPaced, pacedResult, paceSite } from "../pacing"
import { PERMISSION_TTL_MS } from "../permission-rules"
import { checkRateLimit } from "../rate-limit"
import { loadResourceLimits } from "../resources/state"
import { missingResultMessage, resolveHandles } from "../result-handles"
import { handleOf, type BytesKeeper, type ResultOpener } from "../tool-results"
import { decideSite, loadFetchRules } from "../web-fetch"
import { parseSecretPlaceholder, scrubResult } from "../wrappers/placeholders"
import { catchDownload, offeredName, tabOwnsFrame } from "./downloads"
import { coveringElement, coveringLine, failureReason } from "./failures"
import { heldSecret, heldValues, holdSecret } from "./held"
import {
  ACTION_TIMEOUT_MS,
  BROWSER_ACTIONS,
  CHALLENGE_WAIT_MS,
  DEFAULT_READ_CHARS,
  DOWNLOAD_DEADLINE_MS,
  DOWNLOAD_START_MS,
  DOWNLOAD_TIMEOUT_MS,
  MAX_FAILURE_SNAPSHOT_CHARS,
  MAX_TABS,
  MAX_UPLOAD_BYTES,
  MAX_URL_LENGTH,
  MAX_WAIT_MS,
  MIN_READ_PAGE_TEXT_CHARS,
  NAVIGATION_TIMEOUT_MS,
  TAB_DEADLINE_MS,
} from "./limits"
import { bounded, inLane, pause } from "./queue"
import { leftOutNote, readableMarkdown } from "./read-page"
import { missingRefMessage, resolveTabRef, tabSnapshot } from "./refs"
import {
  browserHeld,
  closeTab,
  ensureBrowser,
  mayOpen,
  openTab,
  recomputePrivate,
  reopenTab,
  runningBrowser,
  saveVaultProfile,
  setControl,
  tabTitle,
  tabView,
  touch,
  withVault,
  type Reopened,
  type Tab,
  type VaultBrowser,
} from "./runtime"
import { takePicture } from "./screenshot"
import {
  allNodes,
  findInSnapshot,
  nodeByRef,
  parseSnapshot,
  secretMask,
  snapshotText,
  type SnapshotNode,
} from "./snapshot"
import { nameMatches, resolveTarget, type Target } from "./target"
import {
  browserToolSpec,
  parseBrowserArgs,
  type BrowserToolName,
  type BrowserToolSpec,
} from "./tools"
import {
  OwnerNeeded,
  type BrowseAsk,
  type SecretTypeCall,
  type SecretTyper,
} from "./types"

/**
 * Running a browser tool for an assistant: which tab, whether the site may
 * be opened (the token's web fetch lines, decided as web_fetch decides
 * them, a new site getting a line of its own), and what the page looks
 * like afterwards. A site that asks, and a hand-over, end in OwnerNeeded,
 * which the gateway turns into a permission request. A site's check of its
 * visitors is not one: the tab waits for it to pass on its own, and the
 * answer says when it does not, so the assistant can hand the tab over.
 *
 * Every tool but tabs' open and list names its tab: the browser never
 * picks one, since two conversations on one token would otherwise act on
 * each other's. A token sees and drives only the tabs it opened (and their
 * popups): another token's tab, or the owner's own, is answered as a tab
 * that does not exist, so neither its page nor its address reaches the
 * token, and a site the owner allowed once for a tab stays with the token
 * whose tab it is. Nor does a token act on a page its lines no longer let
 * it open.
 *
 * An action on a page (a click, typing, opening a page; not a read of what
 * the tab has) is paced by its site first (lib/core/pacing/): the tab's
 * site, or for a navigation the site it opens. The wait comes before the
 * call queues on its tab, so it holds no lane and counts toward no
 * deadline.
 *
 * Calls on one tab wait their turn in its lane (queue.ts), each for at most
 * its deadline; a tab that passes it is reopened at its address, and the
 * call is told so. A call that arrives while a run_code program's call
 * (another run's, or any while this one is no run's) has the tab is told
 * that in one line first: what it reads may change under it. A page's open
 * dialog is said at once rather than waited on: nothing on the page answers
 * until it is handled.
 *
 * Refusals that name a site or an address are tool errors, never thrown
 * PcpErrors: the request log keeps the text of the latter, and which sites
 * an assistant opened is the owner's to see on the token's page, not the
 * log's.
 *
 * A secret is typed only by type, with text {"$secret": name}, through the
 * SecretTyper upstream.ts hands in (lib/core/browser-secrets.ts decides,
 * secrets.ts decrypts): into an input or textarea whose frame is the page's
 * own origin, asked for at the moment of typing, and typed with CDP's
 * Input.insertText into the field once it has the focus. While a field of
 * the page holds it (held.ts), answers show it as [secret: name] and
 * screenshot is refused.
 */

export type BrowserScope = {
  ctx: VaultContext
  tokenId: string
  publicUrl: string
  serverId: string
  /** The caller gave up (a run_code run stopped): its calls stop waiting. */
  signal?: AbortSignal
  /** The latest the call may still go: how long it waits under pacing. */
  deadline?: number
  /** The run_code or wrapper run the call is made for. */
  runId?: string
}

function text(value: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
  }
}

function failed(result: CallToolResult): CallToolResult {
  return { ...result, isError: true }
}

/** A tab in the Browser page's tabs view, live, for the owner to watch or take over. */
export function tabLink(publicUrl: string, tabId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/browser?tab=${encodeURIComponent(tabId)}`
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

const NO_TABS =
  "This token has no tab open. Open one with tabs (action open, with the url): its answer names the new tab's id, which every other browser tool takes as tab."

/**
 * The token's open tabs, newest first (the one it used last, then the one
 * it opened last), a line each: its id, title, address and the link where
 * the owner can watch it. Never another token's.
 */
async function tabLines(
  scope: Pick<BrowserScope, "tokenId" | "publicUrl">,
  vault: VaultBrowser | null,
): Promise<string[]> {
  const open = await Promise.all(
    [...(vault?.tabs.values() ?? [])]
      .filter((tab) => tab.tokenId === scope.tokenId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt)
      .map(async (tab) => ({ view: await tabView(tab), tab })),
  )

  return open.map(
    ({ view, tab }) =>
      `- ${view.id}: ${view.title || "(no title)"} · ${view.url}${view.control === "owner" ? " · the owner has it" : ""}${tab.unresponsive ? " · not responding" : ""} · ${markdownLink(`Watch tab ${view.id}`, tabLink(scope.publicUrl, view.id))}`,
  )
}

/**
 * What a refusal about a tab adds: the token's open tabs, newest first, or
 * how to open one when it has none. Exported for the gateway's own check
 * of a browser call's arguments, which answers a call without tab before
 * it reaches the browser.
 */
export async function tabHint(
  ctx: Pick<VaultContext, "vaultId">,
  tokenId: string,
  publicUrl: string,
): Promise<string> {
  const lines = await tabLines(
    { tokenId, publicUrl },
    runningBrowser(ctx.vaultId),
  )

  return lines.length === 0
    ? NO_TABS
    : [
        "This token's open tabs, the one used last first:",
        ...lines,
        "Name the one you opened in this conversation, or open a new one with tabs (action open).",
      ].join("\n")
}

/**
 * A tab id the token has no tab by: closed, the browser closed since, or
 * another token's (answered in the same words, so nothing of it shows),
 * with the token's own tabs.
 */
async function noTab(
  scope: BrowserScope,
  tabId: string,
): Promise<CallToolResult> {
  return text(
    `There is no tab ${tabId}: it was closed, or the browser has closed since (it closes after a while with nothing to do). ${await tabHint(scope.ctx, scope.tokenId, scope.publicUrl)}`,
    true,
  )
}

/**
 * A call that names no tab: refused, with the tabs it could have meant.
 * The browser never picks one, so another conversation on the same token
 * does not act on a tab it did not open.
 */
async function missingTab(
  scope: BrowserScope,
  toolName: string,
): Promise<CallToolResult> {
  return text(
    `${toolName} needs the tab to act on (tab), and the browser never picks one. ${await tabHint(scope.ctx, scope.tokenId, scope.publicUrl)}`,
    true,
  )
}

/** The token's own tab by the id a call gave, or why there is none. */
async function pickTab(
  scope: BrowserScope,
  vault: VaultBrowser | null,
  tabId: string,
): Promise<Tab | CallToolResult> {
  return ownTab(vault, scope.tokenId, tabId) ?? noTab(scope, tabId)
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
 * A file the page offered while no download call waited: refused, and said
 * once, so the assistant can take it with download.
 */
function offeredLead(tab: Tab): string[] {
  const name = tab.offeredFile
  tab.offeredFile = null

  return name
    ? [
        `The page offered a file to download (${offeredName(name)}), which the browser keeps only through download: call download with the ref you clicked, or the file's address, to keep it.`,
      ]
    : []
}

/**
 * Tabs the page opened (popups) since its last answer: each a tab of the
 * token's, named by its id, never the one the next call falls on.
 */
function popupLead(scope: BrowserScope, tab: Tab): string[] {
  const vault = runningBrowser(scope.ctx.vaultId)

  return tab.popups.splice(0).flatMap((id) => {
    const popup = vault?.tabs.get(id)
    return popup
      ? [
          `The page opened a new tab, ${id} (${popup.page.url()}). This tab stays as it was; name ${id} as tab to read or act on the new one.`,
        ]
      : []
  })
}

/** What a page's open dialog is called. */
function dialogNoun(type: string): string {
  switch (type) {
    case "alert":
      return "an alert"
    case "confirm":
      return "a confirm dialog"
    case "prompt":
      return "a prompt"
    case "beforeunload":
      return "a dialog asking whether to leave the page"
    default:
      return "a dialog"
  }
}

/** The page's open dialog, and how to answer it; null when there is none. */
function dialogNote(tab: Tab): string | null {
  const dialog = tab.dialog

  if (!dialog) {
    return null
  }

  return `Tab ${tab.id} shows ${dialogNoun(dialog.type())}: "${dialog.message().slice(0, 500)}". Nothing else on the page responds until it is answered: call handle_dialog with this tab and action accept or dismiss${dialog.type() === "prompt" ? " (with text, for what to type into it)" : ""}.`
}

/** A tool that needs the page refused while a dialog is open. */
function dialogOpen(tab: Tab, toolName: string): CallToolResult {
  return text(`${dialogNote(tab)} ${toolName} was not done.`, true)
}

/** Gives a check the tab shows the time most take to pass on their own. */
async function passCheck(tab: Tab): Promise<void> {
  if (tab.documents.challenged()) {
    await tab.documents.pass(CHALLENGE_WAIT_MS)
  }
}

/** The tab as an answer: where it is, how to watch it, and its snapshot. */
async function report(
  scope: BrowserScope,
  tab: Tab,
  {
    snapshot = true,
    lead = [] as string[],
    first = [] as string[],
    maxSnapshot,
    tree: taken,
  }: {
    snapshot?: boolean
    lead?: string[]
    /** Lines before even the check's: the tab a call opened. */
    first?: string[]
    maxSnapshot?: number
    /** The tab's snapshot, when the caller has just taken it. */
    tree?: string
  } = {},
): Promise<CallToolResult> {
  const title = await tabTitle(tab)
  const lines = [
    ...first,
    ...checkLead(tab),
    ...offeredLead(tab),
    ...lead,
    ...popupLead(scope, tab),
    `Tab ${tab.id}: ${title || "(no title)"}`,
    `Address: ${tab.page.url()}`,
    `The owner can watch it or take over: ${markdownLink(`Watch tab ${title || tab.id}`, tabLink(scope.publicUrl, tab.id))}`,
    ...(await blockedNote(scope, tab)),
  ]
  const dialog = dialogNote(tab)

  if (dialog) {
    lines.push(dialog)
    return text(lines.join("\n"))
  }

  if (snapshot) {
    try {
      const tree = taken ?? (await tabSnapshot(tab))
      const shown =
        maxSnapshot && tree.length > maxSnapshot
          ? `${tree.slice(0, maxSnapshot)}\n… (cut short: take a snapshot for all of it)`
          : tree
      lines.push("", "Snapshot:", shown)
    } catch (error) {
      lines.push("", `The snapshot could not be taken: ${failureReason(error)}`)
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

  if (/Download is starting/.test(firstLine(error))) {
    tab.offeredFile = null
    return `${host} answered with a file to download, not a page, so the tab stayed where it was. Call download with that address to keep the file.`
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

/** A new, blank tab of the token's, if the browser has room for one. */
async function newTab(
  scope: BrowserScope,
  vault: VaultBrowser,
): Promise<Tab | CallToolResult> {
  if (vault.tabs.size >= MAX_TABS) {
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

  return openTab(vault, {
    openedBy: await tokenName(scope.tokenId),
    tokenId: scope.tokenId,
    rules: null,
    privateAllowed: false,
  })
}

/** What the caller is told of a tab that was reopened. */
function reopenedResult(
  tab: Tab,
  reopened: Reopened | null,
  why: "deadline" | "crash" | "reset",
): CallToolResult {
  const where = !reopened
    ? "could not be opened again: close it with tabs and open another"
    : reopened.loaded
      ? `was reopened at ${reopened.address}`
      : /^https?:/i.test(reopened.address)
        ? `was reopened, but ${reopened.address} did not load again, so it is blank: open a page in it with navigate`
        : "was reopened, blank"

  if (why === "reset") {
    return text(
      `Tab ${tab.id} was reset: its page was closed and ${where}. What the page held (a form half filled, its history) is gone; take a snapshot for refs.`,
      !reopened,
    )
  }

  return text(
    why === "crash"
      ? `This tab (${tab.id}) stopped responding: its page crashed, and it ${where}. Nothing else was done; take a snapshot, then call again.`
      : `This tab (${tab.id}) stopped responding and ${where}. What the call was doing may or may not have happened: take a snapshot to see the page.`,
    true,
  )
}

/**
 * Runs a call's work in its tab's turn (queue.ts): after the calls on the
 * tab before it, for at most `deadlineMs`. A tab that passes it is
 * reopened at its address, and the call is told so; one whose page
 * crashed is reopened first. A tab closed meanwhile is answered as gone.
 */
function onLane(
  scope: BrowserScope,
  vault: VaultBrowser,
  tab: Tab,
  deadlineMs: number,
  work: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const gone = () => vault.tabs.get(tab.id) !== tab
  const holder = { runId: scope.runId ?? null }

  return inLane(
    tab.lane,
    async () => {
      tab.running = holder

      try {
        return await turn()
      } finally {
        if (tab.running === holder) tab.running = null
      }
    },
    {
      deadlineMs,
      signal: scope.signal,
      onDeadline: async () => {
        if (gone()) {
          return noTab(scope, tab.id)
        }

        return reopenedResult(
          tab,
          await reopenTab(vault, tab).catch(() => null),
          "deadline",
        )
      },
    },
  )

  async function turn(): Promise<CallToolResult> {
    if (browserHeld(vault.vaultId)) {
      throw new PcpError(
        "state",
        "The vault is being restored from an export. Try again in a moment.",
      )
    }

    await tab.reopening?.catch(() => {})

    if (gone()) {
      return noTab(scope, tab.id)
    }

    if (tab.unresponsive) {
      return reopenedResult(
        tab,
        await reopenTab(vault, tab).catch(() => null),
        "crash",
      )
    }

    return work()
  }
}

/**
 * The line a call is told first when a run_code program's call has the
 * tab as it arrives: another run's, or any run's while this call is none.
 */
function holderNote(scope: BrowserScope, tab: Tab): string | null {
  const runId = tab.running?.runId

  return runId && runId !== scope.runId
    ? `A running program (run ${runId}) is acting on this tab right now; what you see may change under it.`
    : null
}

/** The answer with one line in front of everything it says. */
function withLead(result: CallToolResult, line: string | null): CallToolResult {
  if (!line) {
    return result
  }

  const first = result.content[0]

  if (first?.type === "text") {
    return {
      ...result,
      content: [
        { ...first, text: `${line}\n${first.text}` },
        ...result.content.slice(1),
      ],
    }
  }

  return {
    ...result,
    content: [{ type: "text", text: line }, ...result.content],
  }
}

/** The site a tab's page is on, or null for one that is none (about:blank). */
function tabSite(tab: Tab): string | null {
  try {
    const url = new URL(tab.page.url())
    return url.protocol === "http:" || url.protocol === "https:"
      ? siteKey(url)
      : null
  } catch {
    return null
  }
}

/**
 * Waits for the site's turn under pacing (lib/core/pacing/), before the
 * call queues on its tab, up to the caller's deadline; the tool error to
 * answer with when that turn is further off.
 */
async function paceAction(
  scope: BrowserScope,
  site: string | null,
): Promise<CallToolResult | null> {
  if (!site) {
    return null
  }

  const paced = await paceSite(scope.ctx.vaultId, site, "browser_act", {
    serverId: scope.serverId,
    signal: scope.signal,
    deadline: scope.deadline,
  })

  return paced ? pacedResult(paced) : null
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
  let tab = ownTab(vault, scope.tokenId, ask.tabId)
  const first: string[] = []

  if (tab && ownerHas(tab)) {
    return ownerHolds(tab)
  }

  const note = tab ? holderNote(scope, tab) : null
  const paced = await paceAction(scope, siteKey(url))

  if (paced) {
    return withLead(paced, note)
  }

  if (tab && vault.tabs.get(tab.id) !== tab) {
    tab = null
  }

  if (!tab) {
    const opened = await withVault(vault, () => newTab(scope, vault))

    if (!isTab(opened)) {
      return opened
    }

    tab = opened
    first.push(
      ask.tabId
        ? `There is no tab ${ask.tabId} (it was closed, or the browser has closed since), so the page opened in a new tab: ${tab.id}. Name ${tab.id} as tab in the calls that follow.`
        : `Opened a new tab: ${tab.id}. Name ${tab.id} as tab in the calls that follow.`,
    )
  }

  const current = tab

  const answer = onLane(scope, vault, current, TAB_DEADLINE_MS, async () => {
    await driveAs(vault, current, scope)

    if (current.dialog) {
      return dialogOpen(current, "navigate")
    }

    if (allowedByOwner) {
      current.allowedHosts.add(siteKey(url))
    }

    current.lastBlocked = null
    const since = Date.now()
    const go = () =>
      current.page.goto(url.href, {
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

        await current.page
          .waitForURL((address) => address.href === url.href, {
            waitUntil: "domcontentloaded",
            timeout: NAVIGATION_TIMEOUT_MS,
          })
          .catch(() => {
            throw error
          })
      })
    } catch (error) {
      const failure = navigationFailure(vault, current, url, error, since)
      current.lastBlocked = null
      await settle(current)
      await saveVaultProfile(scope.ctx, vault, { force: true })
      return failed(
        await report(scope, current, {
          first,
          lead: [failure],
          snapshot: false,
        }),
      )
    }

    await passCheck(current)
    await saveVaultProfile(scope.ctx, vault, { force: true })
    return report(scope, current, { first })
  })

  return withLead(await answer, note)
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

  return performNavigate(scope, { tabId: tabId ?? null, url: url.href })
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
    const lines = await tabLines(scope, vault)

    return text(
      lines.length === 0
        ? NO_TABS
        : ["This token's open tabs:", ...lines].join("\n"),
    )
  }

  const picked = await pickTab(scope, vault, args.tab!)

  if (!isTab(picked)) {
    return picked
  }

  if (ownerHas(picked)) {
    return ownerHolds(picked)
  }

  // Neither waits behind a call that hangs on the tab: that call ends with
  // the page.
  if (args.action === "close") {
    await withVault(vault!, () => closeTab(vault!, picked))
    await saveVaultProfile(scope.ctx, vault!, { force: true })
    return text(`Closed tab ${picked.id}.`)
  }

  await driveAs(vault!, picked, scope)
  return reopenedResult(
    picked,
    await reopenTab(vault!, picked).catch(() => null),
    "reset",
  )
}

/** The tools that need the page itself, refused while a dialog is open. */
const NEEDS_THE_PAGE = new Set<BrowserToolName>([
  "back",
  "read_page",
  "find",
  "click",
  "type",
  "press_key",
  "select_option",
  "upload_file",
  "scroll",
  "wait_for",
  "download",
])

async function onTab(
  scope: BrowserScope,
  tabId: string,
  spec: BrowserToolSpec,
  run: (tab: Tab, vault: VaultBrowser) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const vault = runningBrowser(scope.ctx.vaultId)
  const picked = await pickTab(scope, vault, tabId)

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
  const note = holderNote(scope, picked)

  if (browserToolPaced(spec.name)) {
    const paced = await paceAction(scope, tabSite(picked))

    if (paced) {
      return withLead(paced, note)
    }
  }

  const answer = await onLane(
    scope,
    vault!,
    picked,
    spec.name === "download" ? DOWNLOAD_DEADLINE_MS : TAB_DEADLINE_MS,
    async () => {
      await driveAs(vault!, picked, scope)
      const refused = offLimits(vault!, picked)

      if (refused) {
        return refused
      }

      if (picked.dialog && NEEDS_THE_PAGE.has(spec.name)) {
        return dialogOpen(picked, spec.name)
      }

      let result: CallToolResult

      try {
        result = await run(picked, vault!)
      } catch (error) {
        if (error instanceof PcpError || error instanceof OwnerNeeded) {
          throw error
        }

        // A dialog the action opened is why it stopped.
        const dialog = dialogNote(picked)
        result = text(
          dialog ? `${failureReason(error)}\n${dialog}` : failureReason(error),
          true,
        )
      }

      if (spec.changes) {
        await saveVaultProfile(scope.ctx, vault!, { force: true })
      }

      return result
    },
  )

  return withLead(answer, note)
}

/**
 * An answer with what the token's tabs hold of a secret PCP typed shown as
 * [secret: name], wherever it appears (held.ts): a page can repeat a field's
 * value in its text or its title.
 */
async function maskHeld(
  { ctx, tokenId }: Pick<BrowserScope, "ctx" | "tokenId">,
  result: CallToolResult,
): Promise<CallToolResult> {
  const vault = runningBrowser(ctx.vaultId)
  let masked = result

  for (const tab of vault?.tabs.values() ?? []) {
    if (tab.tokenId !== tokenId) {
      continue
    }

    for (const { name, value } of (await heldValues(tab.page)).values) {
      masked = scrubResult(masked, [value], { replacement: secretMask(name) })
    }
  }

  return masked
}

/** The type call as it is made again once the owner allows the secret. */
function secretCall(args: Record<string, unknown>): SecretTypeCall {
  return {
    tab: args.tab as string,
    ...(args.ref ? { ref: args.ref as string } : {}),
    ...(args.target ? { target: args.target as Record<string, unknown> } : {}),
    ...(args.submit ? { submit: true } : {}),
  }
}

/** The origin of the frame an element is in; null for one that is no site's. */
async function frameOriginOf(
  handle: Awaited<ReturnType<Locator["elementHandle"]>>,
): Promise<string | null> {
  const frame = await handle.ownerFrame().catch(() => null)
  return frame ? originOf(frame.url()) : null
}

/**
 * type with a stored secret: into an input or textarea of the page's own
 * site (not a frame from another), the value asked for only then, for the
 * page's origin as it is now, and typed once the field has the focus and
 * the page and frame are still where they were. Nothing of the value is in
 * the answer: the field reads as [secret: name] from then on.
 */
async function typeSecret(
  scope: BrowserScope,
  tab: Tab,
  { locator, label }: { locator: Locator; label: string },
  args: Record<string, unknown>,
  typer: SecretTyper,
): Promise<CallToolResult> {
  const origin = originOf(tab.page.url())

  if (!origin) {
    return text(
      `Tab ${tab.id} shows no page at a site, so the secret "${typer.name}" was not typed.`,
      true,
    )
  }

  const handle = await locator.elementHandle({ timeout: ACTION_TIMEOUT_MS })

  try {
    const frameOrigin = await frameOriginOf(handle)

    if (frameOrigin !== origin) {
      return text(
        `${label} is in a frame from ${frameOrigin ?? "an address that is no site's"}, not from ${origin}, the page's own site, so the secret "${typer.name}" was not typed. PCP types a secret only into a field of the page's own site.`,
        true,
      )
    }

    const field = await handle
      .evaluate((element) => {
        const field = element as HTMLInputElement
        const typed = [
          "text",
          "password",
          "email",
          "tel",
          "number",
          "search",
          "url",
        ]

        return (
          (element.tagName === "TEXTAREA" ||
            (element.tagName === "INPUT" && typed.includes(field.type))) &&
          !field.disabled &&
          !field.readOnly
        )
      })
      .catch(() => false)

    if (!field) {
      return text(
        `${label} is not a text field (an input or a text area) that can be typed into, so the secret "${typer.name}" was not typed.`,
        true,
      )
    }

    const value = await typer.value({
      tabId: tab.id,
      origin,
      url: tab.page.url(),
      title: await tabTitle(tab),
      field: label,
      call: secretCall(args),
    })

    await locator.fill("", { timeout: ACTION_TIMEOUT_MS })
    await locator.focus({ timeout: ACTION_TIMEOUT_MS })

    // Again at the last moment: the page and the field's frame are where
    // they were, and the field has the focus, in its frame and every frame
    // around it, so the text goes nowhere else.
    const focused = await handle
      .evaluate((element) => {
        let node: Element = element
        let doc = element.ownerDocument

        for (;;) {
          if (doc.activeElement !== node) return false
          const around = doc.defaultView?.frameElement
          if (!around) return true
          node = around
          doc = around.ownerDocument
        }
      })
      .catch(() => false)

    if (
      !focused ||
      originOf(tab.page.url()) !== origin ||
      (await frameOriginOf(handle)) !== origin
    ) {
      return text(
        `The page moved on, or ${label} lost the focus, before the secret "${typer.name}" could be typed, so it was not. Take a snapshot and call again.`,
        true,
      )
    }

    await bounded(
      tab.cdp.send("Input.insertText", { text: value }),
      ACTION_TIMEOUT_MS,
      "Input.insertText",
    )
    holdSecret(
      tab.page,
      typer.name,
      await handle
        .inputValue({ timeout: ACTION_TIMEOUT_MS })
        .catch(() => value),
    )

    if (args.submit) {
      await locator.press("Enter", { timeout: ACTION_TIMEOUT_MS })
    }
  } finally {
    await handle.dispose().catch(() => {})
  }

  await settle(tab)
  return report(scope, tab, {
    lead: [
      `Typed the secret "${typer.name}" into ${label}. It shows as ${secretMask(typer.name)}, and the tab takes no screenshots while a field holds it.`,
    ],
  })
}

/** A ref that names nothing on the tab's page now: gone, or never the tab's. */
function staleRef(tab: Tab, ref: string): CallToolResult {
  return text(missingRefMessage(tab, ref), true)
}

/** The element a call names, by its ref or its target, or why not. */
async function element(
  tab: Tab,
  args: Record<string, unknown>,
): Promise<{ locator: Locator; label: string } | CallToolResult> {
  if (args.target) {
    const target = args.target as Target
    const resolved = await resolveTarget(tab, target)

    return "refusal" in resolved
      ? text(resolved.refusal, true)
      : {
          locator: resolved.locator,
          label: `the ${target.role} "${target.name}"`,
        }
  }

  const ref = args.ref as string
  const locator = await resolveTabRef(tab, ref)
  return locator ? { locator, label: ref } : staleRef(tab, ref)
}

function isElement(
  value: { locator: Locator; label: string } | CallToolResult,
): value is { locator: Locator; label: string } {
  return "locator" in value
}

type Upload = { name: string; mimeType: string; buffer: Buffer }

/**
 * upload_file's files, read as bytes from the token's kept results before
 * the page is touched: an unknown id puts nothing into it.
 */
async function keptUploads(
  list: Array<{ $result: string; name?: string; type?: string }>,
  open: ResultOpener | undefined,
): Promise<Upload[]> {
  if (!open) {
    throw invalid(
      "upload_file's files are results PCP kept for this token, and this call cannot read them.",
    )
  }

  const uploads: Upload[] = []
  let total = 0

  for (const entry of list) {
    const opened = await open(entry.$result)

    if (!opened) {
      throw invalid(missingResultMessage())
    }

    const buffer = opened.bytes()
    total += buffer.length

    if (total > MAX_UPLOAD_BYTES) {
      throw invalid(
        `The files come to more than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB, more than the browser puts into a page in one call.`,
      )
    }

    uploads.push({
      name:
        entry.name ??
        opened.name ??
        (opened.kind === "text" ? "text.txt" : "file"),
      mimeType: entry.type ?? bareType(opened.mediaType),
      buffer,
    })
  }

  return uploads
}

/**
 * Puts files into a file field: the field itself, or, for a button that
 * opens the page's file picker, the picker (which never opens a window:
 * runtime.ts catches every one).
 */
async function uploadFiles(
  scope: BrowserScope,
  tab: Tab,
  { locator: target, label }: { locator: Locator; label: string },
  uploads: Upload[],
): Promise<CallToolResult> {
  try {
    await target.setInputFiles(uploads, { timeout: ACTION_TIMEOUT_MS })
  } catch (error) {
    if (!/not an HTMLInputElement/i.test(firstLine(error))) {
      throw error
    }

    const chooser = await Promise.all([
      tab.page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT_MS }),
      target.click({ timeout: ACTION_TIMEOUT_MS }),
    ])
      .then(([opened]) => opened)
      .catch(() => null)

    if (!chooser) {
      return text(
        `${label} is not a file field, and clicking it opened no file picker. Give the field, or the button that opens its picker.`,
        true,
      )
    }

    if (uploads.length > 1 && !chooser.isMultiple()) {
      return text("That field takes one file; give it one.", true)
    }

    await chooser.setFiles(uploads, { timeout: ACTION_TIMEOUT_MS })
  }

  await settle(tab)
  return report(scope, tab, {
    lead: [
      `Chose ${uploads.map((upload) => offeredName(upload.name)).join(", ")} in ${label}. The page has them; it sends them as it would for a person, usually when its form is sent.`,
    ],
  })
}

/**
 * download: a click (ref) or an address (url) that starts a download in
 * the tab, and the file kept for the token. The file comes only from the
 * tab (or a popup of it), from an address the tab may open; it is read and
 * gone from the machine before this answers (downloads.ts).
 */
async function downloadFile(
  scope: BrowserScope,
  vault: VaultBrowser,
  tab: Tab,
  args: { ref?: string; url?: string },
  keepBytes: BytesKeeper | undefined,
): Promise<CallToolResult> {
  if (!keepBytes) {
    return text(
      "A download is kept as a result for the token, which this call cannot make.",
      true,
    )
  }

  let start: () => Promise<number | void>

  if (args.url) {
    const url = pageUrl(args.url)

    if (isPcpSite(url, scope.publicUrl)) {
      return text(
        `${url.host} is PCP's own address, which the browser never opens.`,
        true,
      )
    }

    if (!mayOpen(vault, tab, url.href)) {
      return text(
        `Tab ${tab.id} may not open ${siteKey(url)} now, so nothing was downloaded. Call navigate with the address to ask the owner; once they allow it, call download with it again.`,
        true,
      )
    }

    start = async () => {
      const since = Date.now()

      try {
        await tab.page.goto(url.href, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        })
      } catch (error) {
        if (/Download is starting/.test(firstLine(error))) {
          return
        }

        throw new Error(navigationFailure(vault, tab, url, error, since))
      }

      // A page opened rather than a file: a download it starts on its own
      // has a moment.
      return 1_000
    }
  } else {
    const ref = args.ref!
    const target = await resolveTabRef(tab, ref)

    if (!target) {
      return staleRef(tab, ref)
    }

    start = () => target.click({ timeout: ACTION_TIMEOUT_MS })
  }

  const { fileBytes } = await loadResourceLimits()
  const caught = await catchDownload(vault.downloads, {
    tabSession: tab.cdp,
    judge: async (frameId, address) =>
      !(await tabOwnsFrame(vault.downloads, tab, frameId))
        ? "other"
        : mayOpen(vault, tab, address)
          ? "take"
          : "refuse",
    start,
    maxBytes: fileBytes,
  })
  const failedWith = async (lead: string) =>
    failed(await report(scope, tab, { lead: [lead], snapshot: false }))

  switch (caught.kind) {
    case "busy":
      return text(
        "Another tab is waiting for a download now, and the browser takes one at a time. Try again once it is done.",
        true,
      )
    case "none":
      await settle(tab)
      return failed(
        await report(scope, tab, {
          lead: [
            args.url
              ? "That address opened a page, not a file, and nothing started a download. The tab shows the page now."
              : `Nothing started a download within ${DOWNLOAD_START_MS / 1000} seconds of the click. Take a snapshot to see what it did.`,
          ],
        }),
      )
    case "refused": {
      let host = "another site"

      try {
        host = siteKey(new URL(caught.url))
        await decideSite(scope, host, "GET").catch(() => null)
      } catch {
        // Only http(s) addresses are ever refused.
      }

      return failedWith(
        `The download came from ${host}, which this token may not open yet, so it was stopped. Call navigate with its address to ask the owner; once they allow it, call download again.`,
      )
    }
    case "too_large":
      return failedWith(
        `${offeredName(caught.name)} is larger than PCP keeps of one file (${fileBytes.toLocaleString("en")} bytes), so the download was stopped. The owner can raise that in PCP's settings, under Resources.`,
      )
    case "timeout":
      return failedWith(
        `${offeredName(caught.name)} did not finish downloading within ${DOWNLOAD_TIMEOUT_MS / 60_000} minutes, so it was stopped.`,
      )
    case "failed":
      return failedWith(
        `The download of ${offeredName(caught.name)} failed: the site broke it off, or Chromium could not save it.`,
      )
  }

  const kept = await keepBytes({
    bytes: caught.bytes,
    mediaType: fileMediaType(caught.name, caught.bytes),
    name: caught.name,
    serverId: scope.serverId,
    toolName: "download",
  })
  const from = /^https?:/i.test(caught.url)
    ? caught.url.slice(0, MAX_URL_LENGTH)
    : null

  return text(
    JSON.stringify(
      {
        tab: tab.id,
        file: handleOf(kept),
        ...(from ? { from } : {}),
        note: `PCP keeps this file for you: pass {"$result": "${kept.id}"} where a tool wants a file (upload_file's files, send_email's or create_draft's attachments, a field that takes base64), read it with read_result, or get it onto your own computer with share_result's link where this token has it.`,
      },
      null,
      2,
    ),
  )
}

/** Characters of a text that are not white space. */
function visibleChars(value: string): number {
  return value.replace(/\s+/g, "").length
}

/** The element of a snapshot a target names, as resolveTarget found it. */
function targetNode(
  nodes: SnapshotNode[],
  target: Target,
): SnapshotNode | null {
  const scope = target.within ? nodeByRef(nodes, target.within) : null

  if (target.within && !scope) {
    return null
  }

  const matching = allNodes(scope ? [scope] : nodes).filter(
    (node) =>
      node.role === target.role &&
      nameMatches(node.name, target.name, target.exact),
  )

  return target.nth !== undefined
    ? (matching[target.nth] ?? null)
    : matching.length === 1
      ? matching[0]!
      : null
}

/** What read_page says when the page's HTML gave its text from the snapshot. */
const FROM_SNAPSHOT =
  "The page's HTML holds next to no text (a page its scripts draw, in shadow DOM or in frames), so this is the text of its accessibility snapshot instead: its headings, links and words, without refs (snapshot gives those)."

/**
 * read_page: the page's text, or one part of it, as Markdown. A page whose
 * HTML holds next to none (one its scripts draw, in shadow DOM or frames,
 * which page.content() does not reach) is read from the tab's snapshot
 * instead (refs.ts, so no ref changes for it), and the answer says so.
 */
async function readPage(
  tab: Tab,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const lead: string[] = []
  let html: string
  /** The part of the snapshot the same text is in. */
  let partOf = (nodes: SnapshotNode[]): SnapshotNode[] | null => nodes

  if (args.ref || args.target) {
    const found = await element(tab, args)
    if (!isElement(found)) return found
    html = `<body>${await found.locator.innerHTML({ timeout: ACTION_TIMEOUT_MS })}</body>`
    lead.push(`Only ${found.label}, as asked.`)
    partOf = (nodes) => {
      const node = args.ref
        ? nodeByRef(nodes, args.ref as string)
        : targetNode(nodes, args.target as Target)
      return node ? [node] : null
    }
  } else if (args.main_only) {
    const main = tab.page.locator("main, [role=main]").first()

    if ((await main.count()) > 0) {
      html = `<body>${await main.innerHTML({ timeout: ACTION_TIMEOUT_MS })}</body>`
      lead.push("Only the page's main part, as asked.")
      partOf = (nodes) => {
        const node = allNodes(nodes).find((one) => one.role === "main")
        return node ? [node] : null
      }
    } else {
      html = await bounded(
        tab.page.content(),
        ACTION_TIMEOUT_MS,
        "page.content",
      )
      lead.push("The page marks no main part, so this is all of it.")
    }
  } else {
    html = await bounded(tab.page.content(), ACTION_TIMEOUT_MS, "page.content")
  }

  const { markdown, left } = readableMarkdown(html, tab.page.url())
  const note = leftOutNote(left)
  let body = markdown

  if (visibleChars(markdown) < MIN_READ_PAGE_TEXT_CHARS) {
    const part = partOf(parseSnapshot(await tabSnapshot(tab).catch(() => "")))
    const words = part ? snapshotText(part) : ""

    if (visibleChars(words) > visibleChars(markdown)) {
      body = words
      lead.push(FROM_SNAPSHOT)
    }
  }

  const start = (args.start_index as number | undefined) ?? 0
  const max = (args.max_length as number | undefined) ?? DEFAULT_READ_CHARS
  const slice = sliceText(body, start, max)
  const head = [
    ...checkLead(tab),
    `Tab ${tab.id}: ${(await tabTitle(tab)) || "(no title)"}`,
    `Address: ${tab.page.url()}`,
    ...lead,
    ...(note ? [note] : []),
  ]

  if (slice.total === 0) {
    return text(
      [
        ...head,
        "",
        "(no text)",
        "",
        "Neither its HTML nor its accessibility snapshot has words: take a screenshot to see what it shows.",
      ].join("\n"),
    )
  }

  if (start >= slice.total) {
    return text(
      [
        ...head,
        `start_index ${start} is past the end: the text has ${slice.total} characters.`,
      ].join("\n"),
      true,
    )
  }

  const more =
    slice.end < slice.total
      ? `; call again with start_index ${slice.end} for the rest`
      : ""

  return text(
    [
      ...head,
      `Characters ${slice.start} to ${slice.end} of ${slice.total}${more}.`,
      "",
      slice.part,
    ].join("\n"),
  )
}

/** find: the snapshot's elements that mention a text, as JSON. */
async function findOnPage(
  tab: Tab,
  args: { text: string; within?: string },
): Promise<CallToolResult> {
  // The tab's snapshot (refs.ts): the page's refs hold through it.
  const tree = parseSnapshot(await tabSnapshot(tab))
  let nodes = tree

  if (args.within) {
    const within = nodeByRef(tree, args.within)

    if (!within) {
      return staleRef(tab, args.within)
    }

    nodes = [within]
  }

  const { matches, total } = findInSnapshot(nodes, args.text)

  return text(
    JSON.stringify(
      {
        tab: tab.id,
        ...(args.within ? { within: args.within } : {}),
        total,
        matches,
        ...(total > matches.length
          ? {
              note: `Only the first ${matches.length} of ${total}: give within (the ref of a part of the page) or a longer text for the rest.`,
            }
          : {}),
      },
      null,
      2,
    ),
  )
}

/** Rejects when the signal aborts, so work the caller left stops waiting. */
function untilAborted<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return promise
  }

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      })
    }),
  ])
}

type BrowserCallOptions = Parameters<typeof runBrowserTool>[4]

/**
 * Runs one browser tool for an assistant. `serverId` is the browser's row;
 * `publicUrl` makes the links to PCP's page for each tab. Whatever the
 * tool, nothing of a secret PCP typed in the token's tabs goes out with
 * the answer.
 */
export async function callBrowserTool(
  ctx: VaultContext,
  server: Pick<McpServer, "id" | "name">,
  toolName: string,
  rawArgs: Record<string, unknown>,
  options: BrowserCallOptions,
): Promise<CallToolResult> {
  return maskHeld(
    { ctx, tokenId: options.tokenId },
    await runBrowserTool(ctx, server, toolName, rawArgs, options),
  )
}

async function runBrowserTool(
  ctx: VaultContext,
  server: Pick<McpServer, "id" | "name">,
  toolName: string,
  rawArgs: Record<string, unknown>,
  {
    tokenId,
    publicUrl,
    open,
    keepBytes,
    signal,
    deadline,
    runId,
    secret,
  }: {
    tokenId: string
    publicUrl: string
    /**
     * Opens a result the token kept: a handle in the arguments is replaced
     * by what it stands for (a text to type), and upload_file's files are
     * read as bytes.
     */
    open?: ResultOpener
    /** Keeps a file for the token: what download takes. */
    keepBytes?: BytesKeeper
    /**
     * The caller gave up (a run_code run stopped or timed out): the call
     * stops waiting at once, is rejected with the signal's reason, and its
     * turn on the tab passes to the next call. What Playwright was already
     * doing on the page cannot be called back, and finishes alone.
     */
    signal?: AbortSignal
    /** The latest the call may still go: how long it waits under pacing. */
    deadline?: number
    /**
     * The run_code or wrapper run the call is made from, when it is one's:
     * another call that arrives while it has the tab is told so.
     */
    runId?: string
    /**
     * The secret a type call carries as {"$secret": name}, from upstream.ts:
     * the only way one reaches a page.
     */
    secret?: SecretTyper
  },
): Promise<CallToolResult> {
  const spec = browserToolSpec(toolName)

  if (!spec) {
    throw new PcpError(
      "state",
      `${server.name} has no tool called ${toolName}.`,
    )
  }

  signal?.throwIfAborted()
  const scope: BrowserScope = {
    ctx,
    tokenId,
    publicUrl,
    serverId: server.id,
    signal,
    deadline,
    runId,
  }
  const listsOrOpens =
    spec.name === "request_secret" ||
    (spec.name === "tabs" &&
      (rawArgs.action === "open" || rawArgs.action === "list"))

  if (!listsOrOpens && (rawArgs.tab == null || rawArgs.tab === "")) {
    return missingTab(scope, spec.name)
  }

  // Before the browser is touched: an unknown id never reaches a page.
  const args = parseBrowserArgs(
    spec,
    open ? await resolveHandles(rawArgs, open, { skip: ["files"] }) : rawArgs,
  )

  if (!checkRateLimit(`browser:${tokenId}`, BROWSER_ACTIONS)) {
    return text(
      "That is a lot of browsing in a short time. Wait a few minutes.",
      true,
    )
  }

  const tab = args.tab as string

  switch (spec.name) {
    case "tabs":
      return tabs(scope, args as { action: string; url?: string; tab?: string })
    case "navigate":
      return openSite(scope, tab, args.url as string, "navigate")
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
      return onTab(scope, tab, spec, (current) => readPage(current, args))
    case "find":
      return onTab(scope, tab, spec, (current) =>
        findOnPage(current, args as { text: string; within?: string }),
      )
    case "click":
      return onTab(scope, tab, spec, async (current) => {
        const found = await element(current, args)
        if (!isElement(found)) return found
        const force = args.force === true

        try {
          if (!force) {
            await found.locator
              .scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
              .catch(() => {})
          }

          await found.locator.click({
            timeout: ACTION_TIMEOUT_MS,
            clickCount: args.double ? 2 : 1,
            force,
          })
        } catch (error) {
          // Why, in words, and what the tab shows, in short: with the ref
          // of what covers the element, when the snapshot shows it.
          const dialog = dialogNote(current)
          const tree = dialog
            ? undefined
            : await tabSnapshot(current).catch(() => undefined)
          const covering = coveringElement(error)
          const over =
            covering && tree !== undefined
              ? coveringLine(parseSnapshot(tree), covering)
              : null

          return failed(
            await report(scope, current, {
              lead: [
                `The click on ${found.label} did not happen: ${failureReason(error)}`,
                ...(over ? [over] : []),
              ],
              snapshot: !dialog,
              tree,
              maxSnapshot: MAX_FAILURE_SNAPSHOT_CHARS,
            }),
          )
        }

        await settle(current)
        return report(scope, current)
      })
    case "type": {
      const named = parseSecretPlaceholder(args.text)

      if (named !== null && secret?.name !== named) {
        throw invalid(
          'A secret goes into a page only through PCP: {"$secret": …} was not placed.',
        )
      }

      return onTab(scope, tab, spec, async (current) => {
        const found = await element(current, args)
        if (!isElement(found)) return found

        if (named !== null) {
          return typeSecret(scope, current, found, args, secret!)
        }

        await found.locator.fill(args.text as string, {
          timeout: ACTION_TIMEOUT_MS,
        })
        if (args.submit) {
          await found.locator.press("Enter", { timeout: ACTION_TIMEOUT_MS })
        }
        await settle(current)
        return report(scope, current)
      })
    }
    case "press_key":
      return onTab(scope, tab, spec, async (current) => {
        await bounded(
          current.page.keyboard.press(args.key as string),
          ACTION_TIMEOUT_MS,
          "keyboard.press",
        )
        await settle(current)
        return report(scope, current)
      })
    case "select_option":
      return onTab(scope, tab, spec, async (current) => {
        const found = await element(current, args)
        if (!isElement(found)) return found
        await found.locator.selectOption(args.values as string[], {
          timeout: ACTION_TIMEOUT_MS,
        })
        await settle(current)
        return report(scope, current)
      })
    case "upload_file": {
      const uploads = await keptUploads(
        args.files as Array<{ $result: string; name?: string; type?: string }>,
        open,
      )
      return onTab(scope, tab, spec, async (current) => {
        const found = await element(current, args)
        if (!isElement(found)) return found
        return uploadFiles(scope, current, found, uploads)
      })
    }
    case "download":
      return onTab(scope, tab, spec, (current, vault) =>
        downloadFile(
          scope,
          vault,
          current,
          args as { ref?: string; url?: string },
          keepBytes,
        ),
      )
    case "scroll":
      return onTab(scope, tab, spec, async (current) => {
        if (args.ref || args.target) {
          const found = await element(current, args)
          if (!isElement(found)) return found
          await found.locator.scrollIntoViewIfNeeded({
            timeout: ACTION_TIMEOUT_MS,
          })
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
          await pause(args.ms as number, signal)
          return report(scope, current)
        }

        const appeared = await untilAborted(
          current.page
            .getByText(args.text as string)
            .first()
            .waitFor({ timeout: MAX_WAIT_MS })
            .then(() => true)
            .catch(() => false),
          signal,
        )

        return report(scope, current, {
          lead: appeared
            ? []
            : [
                `That text did not appear within ${MAX_WAIT_MS / 1000} seconds.`,
              ],
        })
      })
    case "screenshot":
      return onTab(scope, tab, spec, async (current) => {
        if (current.dialog) {
          return report(scope, current, { snapshot: false })
        }

        const held = await heldSecret(current.page)

        if (held) {
          return text(
            `A field in tab ${current.id} holds the secret "${held}", which PCP typed, so the tab takes no screenshots until the field changes or the page moves on. Take a snapshot to see the page: it shows the field as ${secretMask(held)}.`,
            true,
          )
        }

        let label: string | null = null
        let locator: Locator | undefined

        if (args.ref || args.target) {
          const found = await element(current, args)
          if (!isElement(found)) return found
          locator = found.locator
          label = found.label
        }

        const picture = await takePicture(current, {
          element: locator,
          maxWidth: args.max_width as number | undefined,
          quality: args.quality as number | undefined,
        })

        if (!picture) {
          return text(
            `${label} shows nowhere on the page now, so there is no picture of it. Take a snapshot to see what the page has.`,
            true,
          )
        }

        return {
          content: [
            {
              type: "text",
              text: `Tab ${current.id}: ${current.page.url()} (${label ? `${label}, ` : ""}${picture.width} by ${picture.height}${picture.scale < 1 ? ", made smaller to pass on" : ""}, JPEG quality ${picture.quality}; the owner can watch the tab: ${markdownLink(`Watch tab ${current.id}`, tabLink(publicUrl, current.id))})`,
            },
            {
              type: "image",
              data: picture.bytes.toString("base64"),
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
    case "request_secret": {
      let input

      try {
        input = await checkSecretRequest(ctx, server.id, {
          name: args.name as string,
          purpose: args.purpose as string,
          origins: args.origins as string[],
          kind: args.kind as string | undefined,
        })
      } catch (error) {
        // Its refusals can name a site: a tool error, out of the log.
        if (error instanceof PcpError) {
          return text(error.message, true)
        }

        throw error
      }

      throw new OwnerNeeded({ kind: "secret_request", input })
    }
    case "hand_over":
      return onTab(scope, tab, spec, async (current) => {
        const message = withoutPresentation(args.message as string).trim()
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
