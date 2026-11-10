import type { CallToolResult } from "@modelcontextprotocol/server"
import type { Locator, Page } from "patchright-core"

import type { McpServer } from "@/lib/generated/prisma/client"

import {
  checkSecretRequest,
  checkSecretSitesChange,
  originOf,
} from "../browser-secrets"
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
import {
  browserPacingClass,
  browserTurnDeadline,
  pacedResult,
  paceBrowserTurn,
  type BrowserPacingClass,
  type Turn,
} from "../pacing"
import {
  assistantBounds,
  readPacingConfig,
  resolveBrowserPolicy,
  type PacingConfig,
} from "../pacing/config"
import {
  BROWSER_CLASS_WORDS,
  describeRange,
  fromPaceInput,
  outsideBounds,
  type BrowserPaceInput,
} from "../pacing/input"
import {
  BROWSER_PACING_CLASSES,
  PACE_KEY_OF,
  pacingOff,
  type BrowserPace,
  type PaceRange,
  type PacingPolicy,
} from "../pacing/limits"
import { PERMISSION_TTL_MS } from "../permission-rules"
import { checkRateLimit } from "@kaperkunde/security"
import { loadResourceLimits } from "../resources/state"
import { missingResultMessage, resolveHandles } from "../result-handles"
import {
  handleOf,
  type BytesKeeper,
  type ResultKeeper,
  type ResultOpener,
} from "../tool-results"
import type { BrowserExits } from "../exits/use"
import {
  argumentsResult,
  familyError,
  textAnswer,
  withNotes,
} from "../tools/family"
import { decideSite, loadFetchRules } from "../web-fetch"
import { parseSecretRef, scrubResult } from "../wrappers/placeholders"
import { consoleLog, networkLog } from "./devtools"
import { catchDownload, offeredName, tabOwnsFrame } from "./downloads"
import { evaluateInTab } from "./evaluate"
import { atStep, callClock, timeoutMessage, type CallClock } from "./clock"
import { coveringElement, coveringLine, failureReason } from "./failures"
import { heldSecret, heldValues, holdSecret, maskTypedResult } from "./held"
import { clickAt, dragBetween, wheelAt, type MouseButton } from "./input"
import {
  ACTION_TIMEOUT_MS,
  BROWSER_ACTIONS,
  CHALLENGE_WAIT_MS,
  DEFAULT_READ_CHARS,
  DOWNLOAD_DEADLINE_MS,
  DOWNLOAD_START_MS,
  DOWNLOAD_TIMEOUT_MS,
  DEFAULT_CALL_TIMEOUT_MS,
  EXPECTED_TURN_MS,
  MAX_FAILURE_SNAPSHOT_CHARS,
  MAX_LANE_QUEUE,
  MAX_QUEUE_WAIT_MS,
  MAX_TABS,
  MAX_UPLOAD_BYTES,
  MAX_FULL_PAGE_HEIGHT,
  MAX_URL_LENGTH,
  PACED_TAB_DEADLINE_MS,
  PACED_TURN_WAIT_MS,
  SETTLE_MS,
  MAX_WAIT_MS,
  MIN_READ_PAGE_TEXT_CHARS,
  NAVIGATION_TIMEOUT_MS,
  TAB_DEADLINE_MS,
  TAB_IDLE_TTL_MS,
} from "./limits"
import { bounded, inLane, LaneBusy, LaneGaveUp, pause } from "./queue"
import { ocrHint, ocrToolFor } from "./ocr"
import { setTabPace, tabPace, tabPaceFor } from "./tab-pace"
import { leftOutNote, readableMarkdown } from "./read-page"
import { missingRefMessage, resolveTabRef, tabSnapshot } from "./refs"
import {
  browserHeld,
  closeTab,
  ensureBrowser,
  mayOpen,
  openTab,
  recomputePrivate,
  renewExit,
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
import { signInHint } from "./sign-in-hint"
import { callRun, runName, spanWords, tabsToSweep, type Swept } from "./sweep"
import {
  formLike,
  NOTHING_UNSEEN,
  unseenInHtml,
  unseenInSnapshot,
  unseenLine,
  type Unseen,
} from "./unseen"
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
  /**
   * The call's own time limit (timeout_ms, or its tool's default), when it
   * has one: its steps are noted on it, and waits for a turn leave when it
   * runs out.
   */
  clock?: CallClock
  /**
   * The pace the wrapper whose run made the call chose for it (its own,
   * or the one its program picked within it): what the call follows unless
   * its tab has a pace of its own (lib/core/pacing/ resolveBrowserPolicy).
   */
  pace?: PaceRange
  /**
   * The exits the token may name, and opening one for a tab
   * (exits/use.ts browserExits, built where the key is: upstream.ts and
   * the owner's answers). Without it a tab cannot go through an exit.
   */
  exits?: BrowserExits
}

/**
 * An answer in words, or a refusal: what the tab or the page is in the way
 * of ("state"), as the one mapping writes it (lib/core/tools/outcome.ts).
 */
function text(value: string, isError = false): CallToolResult {
  return isError ? familyError(value, "state") : textAnswer(value)
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
      ? `The owner is working in tab ${tab.id} after your hand_over, and the browser tools leave it alone until they are done. On the owner's next message, whatever it says, call check_permission with the id hand_over gave before you ask again; once it is done, take a snapshot.`
      : `The owner has taken over tab ${tab.id} in PCP, and the browser tools leave it alone until they hand it back. Ask them, or use another tab.`,
    true,
  )
}

/**
 * How full the browser is, as every tabs answer says it: "5 of 8 tabs
 * open, 2 of them this token's". Only how many: the other tabs' pages are
 * not this token's to see.
 */
function tabUsage(
  vault: VaultBrowser | null | undefined,
  tokenId: string,
): string {
  const open = [...(vault?.tabs.values() ?? [])]
  const mine = open.filter((tab) => tab.tokenId === tokenId).length

  return `${open.length} of ${MAX_TABS} tabs open in the browser, ${mine} of them this token's`
}

function noTabs(vault: VaultBrowser | null | undefined, tokenId: string) {
  return `This token has no tab open (${tabUsage(vault, tokenId)}). Open one with tabs (action open, with the url): its answer names the new tab's id, which every other browser tool takes as tab.`
}

/**
 * The token's open tabs, newest first (the one it used last, then the one
 * it opened last), a line each: its id, title, address, the run that
 * opened it, how long it has been idle and the link where the owner can
 * watch it. Never another token's.
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

  const now = Date.now()

  return open.map(
    ({ view, tab }) =>
      `- ${view.id}: ${view.title || "(no title)"} · ${view.url}${view.control === "owner" ? " · the owner has it" : ""}${tab.unresponsive ? " · not responding" : ""}${tab.openedIn ? ` · opened by ${runName(tab.openedIn)}` : ""}${tab.run?.endedAt != null ? " · its run has ended" : ""} · ${tab.running ? "in use now" : `idle ${spanWords(now - tab.lastUsedAt)}`}${tabPaceText(tab) ? ` · ${tabPaceText(tab)}` : ""} · ${markdownLink(`Watch tab ${view.id}`, tabLink(scope.publicUrl, view.id))}`,
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
  const vault = runningBrowser(ctx.vaultId)
  const lines = await tabLines({ tokenId, publicUrl }, vault)

  return lines.length === 0
    ? noTabs(vault, tokenId)
    : [
        `This token's open tabs, the one used last first (${tabUsage(vault, tokenId)}):`,
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
    `There is no tab ${tabId}: it was closed (by tabs close, after ${spanWords(TAB_IDLE_TTL_MS)} unused, or once the run that used it ended), or the browser has closed since (it closes after a while with nothing to do). ${await tabHint(scope.ctx, scope.tokenId, scope.publicUrl)}`,
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

/**
 * Gives a check the tab shows the time most take to pass on their own; a
 * call's default time limit is lengthened for it (clock.ts allowCheck).
 */
async function passCheck(tab: Tab, clock?: CallClock): Promise<void> {
  if (tab.documents.challenged()) {
    atStep(clock, "waiting for the site's check of its visitors to pass")
    clock?.allowCheck(CHALLENGE_WAIT_MS)
    await tab.documents.pass(CHALLENGE_WAIT_MS)
  }
}

/** How the token reads the text in a picture (ocr.ts): its OCR tool, if any. */
async function ocrWords(scope: BrowserScope): Promise<string> {
  return ocrHint(await ocrToolFor(scope.ctx, scope.tokenId).catch(() => null))
}

/** The line for what a page holds that its tree leaves out, or null. */
async function unseenWords(
  scope: BrowserScope,
  unseen: Unseen,
): Promise<string | null> {
  return unseenLine(unseen, await ocrWords(scope))
}

/**
 * What the tab's snapshot (its parsed `nodes`) leaves out, in a line: its
 * empty iframes, closed shadow roots and canvases (unseen.ts). Null when
 * it leaves nothing out.
 */
async function unseenNote(
  scope: BrowserScope,
  tab: Tab,
  nodes: SnapshotNode[],
): Promise<string | null> {
  const unseen = await unseenInSnapshot(tab, nodes, (ref) =>
    resolveTabRef(tab, ref),
  ).catch(() => NOTHING_UNSEEN)

  return unseenWords(scope, unseen)
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
    signIns = false,
    unseen = false,
  }: {
    snapshot?: boolean
    lead?: string[]
    /** Lines before even the check's: the tab a call opened. */
    first?: string[]
    maxSnapshot?: number
    /** The tab's snapshot, when the caller has just taken it. */
    tree?: string
    /** Name the owner's sign-ins at the page's site (sign-in-hint.ts). */
    signIns?: boolean
    /** Say what the snapshot leaves out (unseen.ts). */
    unseen?: boolean
  } = {},
): Promise<CallToolResult> {
  atStep(scope.clock, `reading tab ${tab.id} for the answer`)
  const title = await tabTitle(tab)
  const hint = signIns ? await signInHint(scope.ctx, tab.page) : null
  const lines = [
    ...first,
    ...checkLead(tab),
    ...offeredLead(tab),
    ...lead,
    ...(hint?.loud ? [hint.line] : []),
    ...popupLead(scope, tab),
    `Tab ${tab.id}: ${title || "(no title)"}`,
    `Address: ${tab.page.url()}`,
    `The owner can watch it or take over: ${markdownLink(`Watch tab ${title || tab.id}`, tabLink(scope.publicUrl, tab.id))}`,
    ...(await blockedNote(scope, tab)),
    ...(hint && !hint.loud ? [hint.line] : []),
    ...fileShownLine(tab),
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
      const missing = unseen
        ? await unseenNote(scope, tab, parseSnapshot(tree))
        : null
      lines.push(...(missing ? [missing] : []), "", "Snapshot:", shown)
    } catch (error) {
      lines.push("", `The snapshot could not be taken: ${failureReason(error)}`)
    }
  }

  return text(lines.join("\n"))
}

/**
 * A tab showing a PDF or a picture rather than a page: its tree has little
 * or nothing of what it shows, so the line says how to read it, through
 * download and the capability tools (capabilities/). Read off the main
 * document's Content-Type as Chromium reported it, never page script.
 */
export function fileShownLine(tab: Pick<Tab, "id" | "documents">): string[] {
  const line = fileShownWords(tab.id, tab.documents.contentType())
  return line ? [line] : []
}

/** fileShownLine's words for a tab and its document's media type. */
export function fileShownWords(
  tabId: string,
  type: string | null,
): string | null {
  if (type === "application/pdf") {
    return `Tab ${tabId} shows a PDF, which its snapshot cannot read. To read it, call download with its address to keep the file, then pass the handle to convert_document (read_image for a scan); edit_pdf fills in, flattens, merges or signs it.`
  }

  if (type?.startsWith("image/")) {
    return `Tab ${tabId} shows a picture, which its snapshot cannot read. To read the text in it, call download with its address to keep the file, then pass the handle to read_image.`
  }

  return null
}

/** Waits briefly for what an action started to load, and for its check. */
async function settle(tab: Tab): Promise<void> {
  await tab.page
    .waitForLoadState("domcontentloaded", { timeout: SETTLE_MS })
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
    return `${host} answered with a file to download, not a page, so the tab stayed where it was. Call download with that address to keep the file; then convert_document reads a document, read_image a picture or scan.`
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

/** Tabs a sweep closed, each with why. */
type Closed = Swept & { tab: Tab }

/**
 * Closes the tabs that are done with (sweep.ts tabsToSweep): idle past the
 * TTL, or used last by a run that has ended. Call it under withVault.
 */
async function sweepUnder(
  vault: VaultBrowser,
  options: { keep?: string | null; needRoom?: boolean },
): Promise<Closed[]> {
  const closed: Closed[] = []

  for (const picked of tabsToSweep(vault.tabs.values(), options)) {
    const tab = vault.tabs.get(picked.id)

    if (tab) {
      await closeTab(vault, tab)
      closed.push({ ...picked, tab })
    }
  }

  return closed
}

/** What the token is told of its own tabs a sweep closed. */
function sweptLines(scope: BrowserScope, closed: Closed[]): string[] {
  const now = Date.now()

  return closed
    .filter(({ tab }) => tab.tokenId === scope.tokenId)
    .map(({ tab, why }) =>
      why === "run"
        ? `Closed tab ${tab.id}: the run that used it${tab.run ? `, ${runName(tab.run)},` : ""} has ended.`
        : `Closed tab ${tab.id}, which nothing used for ${spanWords(now - tab.lastUsedAt)}.`,
    )
}

/**
 * At each browser call, inside its request: the tabs that are done with are
 * closed and the profile saved (this call holds the key). Never the tab
 * the call names. The lines are about the token's own tabs.
 */
async function sweepTabs(
  scope: BrowserScope,
  keep: string | null,
): Promise<string[]> {
  const vault = runningBrowser(scope.ctx.vaultId)

  if (
    !vault ||
    browserHeld(vault.vaultId) ||
    tabsToSweep(vault.tabs.values(), { keep }).length === 0
  ) {
    return []
  }

  const closed = await withVault(vault, () =>
    sweepUnder(vault, { keep }),
  ).catch(() => [] as Closed[])

  if (closed.length > 0) {
    await saveVaultProfile(scope.ctx, vault, { force: true }).catch(() => {})
  }

  return sweptLines(scope, closed)
}

/**
 * A new, blank tab of the token's, if the browser has room for one: when
 * it is full, the tabs whose run has ended go first, without their grace
 * (sweep.ts), and `notes` is told of the token's own. Call it under
 * withVault.
 */
async function newTab(
  scope: BrowserScope,
  vault: VaultBrowser,
  exit?: Awaited<ReturnType<BrowserExits["open"]>>,
  notes: string[] = [],
): Promise<Tab | CallToolResult> {
  if (vault.tabs.size >= MAX_TABS) {
    notes.push(
      ...sweptLines(scope, await sweepUnder(vault, { needRoom: true })),
    )
  }

  if (vault.tabs.size >= MAX_TABS) {
    // Only how many: the other tabs' pages are not this token's to see.
    const mine = [...vault.tabs.values()].filter(
      (open) => open.tokenId === scope.tokenId,
    ).length

    return text(
      mine > 0
        ? `The browser has ${MAX_TABS} tabs open, as many as it keeps (${mine} of them this token's). Close one of this token's first (tabs with action close), or open the page in one of them.`
        : `The browser has ${MAX_TABS} tabs open, as many as it keeps, and none is this token's. The owner can close one on PCP's Browser page; a tab nobody uses closes after ${spanWords(TAB_IDLE_TTL_MS)}.`,
      true,
    )
  }

  return openTab(
    vault,
    {
      openedBy: await tokenName(scope.tokenId),
      tokenId: scope.tokenId,
      rules: null,
      privateAllowed: false,
      run: callRun(scope.runId, scope.signal),
    },
    exit,
  )
}

/**
 * A tab that goes out through an exit: the exit opened again for this call,
 * which keeps its connection up while the tab is used, and refused once
 * the token may no longer use it. Null when the call may go on.
 */
async function keepExit(
  scope: BrowserScope,
  vault: VaultBrowser,
  tab: Tab,
): Promise<CallToolResult | null> {
  if (!tab.exit) {
    return null
  }

  if (!scope.exits) {
    return text(
      `Tab ${tab.id} goes through the exit ${tab.exit.name}, which this call cannot use. Close it with tabs.`,
      true,
    )
  }

  try {
    const opened = await scope.exits.open(tab.exit.name)

    if (opened.id !== tab.exit.id) {
      return text(
        `The exit ${tab.exit.name} that tab ${tab.id} opened with is gone. Close the tab with tabs and open a new one.`,
        true,
      )
    }

    renewExit(vault, opened.id, opened.dialer)
    return null
  } catch (error) {
    if (error instanceof PcpError) {
      return text(`${error.message} Close tab ${tab.id} with tabs.`, true)
    }

    throw error
  }
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
 * How long a call waits for a turn (queue.ts): no longer than its own time
 * limit leaves it, else MAX_QUEUE_WAIT_MS, behind at most MAX_LANE_QUEUE
 * others; it leaves the queue when its time runs out.
 */
function waitBounds(scope: BrowserScope) {
  return {
    giveUp: scope.clock?.expired,
    maxWaitMs: scope.clock ? scope.clock.left() : MAX_QUEUE_WAIT_MS,
    maxQueue: MAX_LANE_QUEUE,
    turnMs: EXPECTED_TURN_MS,
  }
}

/**
 * A call refused rather than queued: what it would wait behind, and when
 * to try again, as a `browser_busy` tool error with retryAfterMs.
 */
function busyResult(tab: Tab | null, busy: LaneBusy): CallToolResult {
  const wait = Math.max(1, Math.ceil(busy.retryAfterMs / 1000))
  const calls = `${busy.ahead} ${busy.ahead === 1 ? "call" : "calls"}`

  return familyError(
    tab
      ? `Tab ${tab.id} is busy: ${calls} on it before this one would take about ${wait} seconds, longer than this call waits. Nothing was done: try again in about ${wait} seconds, give a longer timeout_ms, or use another tab.`
      : `The browser is busy opening and closing tabs: ${calls} before this one would take about ${wait} seconds, longer than this call waits. Nothing was done: try again in about ${wait} seconds.`,
    "browser_busy",
    { retryAfterMs: busy.retryAfterMs },
  )
}

/**
 * Runs a call's work in its tab's turn (queue.ts): after the calls on the
 * tab before it, for at most `deadlineMs`. A tab that passes it is
 * reopened at its address, and the call is told so; one whose page
 * crashed is reopened first. A tab closed meanwhile is answered as gone.
 * A call that would wait longer than it means to is refused as busy; one
 * whose time runs out while it waits leaves the queue (LaneGaveUp, which
 * the call's timeout answers). The tab is the run's the call is made in
 * (sweep.ts), or nobody's run once a call outside any run uses it.
 */
async function onLane(
  scope: BrowserScope,
  vault: VaultBrowser,
  tab: Tab,
  deadlineMs: number,
  work: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const gone = () => vault.tabs.get(tab.id) !== tab
  const holder = { runId: scope.runId ?? null }

  if (scope.clock) {
    scope.clock.tabId = tab.id
  }

  atStep(scope.clock, `waiting for its turn on tab ${tab.id}`)

  return inLane(
    tab.lane,
    async () => {
      tab.running = holder
      tab.run = callRun(scope.runId, scope.signal)

      try {
        return await turn()
      } finally {
        if (tab.running === holder) tab.running = null
      }
    },
    {
      ...waitBounds(scope),
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
  ).catch((error: unknown) => {
    if (error instanceof LaneBusy) return busyResult(tab, error)
    throw error
  })

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

/** A turn that holds nothing back: an action with no site to pace. */
const NO_TURN: Turn = { release: () => {} }

function isTurn(value: Turn | CallToolResult): value is Turn {
  return "release" in value
}

/**
 * The action's turn at its site under pacing (lib/core/pacing/), taken on
 * the tab's lane right before the action and held until it is done, so no
 * two actions at a site, whatever tab or caller they come from, follow
 * closer than its pause (pacing/pace.ts takeTurn). A page opened first
 * waits for the one the tab shows to settle. The pace is the tab's own
 * (tab-pace.ts), else the one its wrapper chose for the call
 * (`scope.pace`), else the owner's; the tool error to answer with when the
 * turn is further off than the call can wait.
 */
async function pacedTurn(
  scope: BrowserScope,
  tab: Tab,
  site: string | null,
  pacingClass: BrowserPacingClass | null,
): Promise<Turn | CallToolResult> {
  if (!site || !pacingClass) {
    return NO_TURN
  }

  // A page opened waits for the one the tab shows to finish loading first
  // (a site's check is the navigation's own to wait for, not the pause's).
  if (pacingClass === "browser_navigate" && !pacingOff()) {
    atStep(scope.clock, `waiting for tab ${tab.id}'s page to settle`)
    await tab.page
      .waitForLoadState("domcontentloaded", { timeout: SETTLE_MS })
      .catch(() => {})
  }

  atStep(scope.clock, `waiting for its turn at ${site} under pacing`)
  const signals = [scope.signal, scope.clock?.expired].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  )
  const turn = await paceBrowserTurn(scope.ctx.vaultId, site, pacingClass, {
    serverId: scope.serverId,
    own: tabPaceFor(tab, pacingClass) ?? scope.pace ?? null,
    signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
    deadline: browserTurnDeadline(scope.deadline),
  })

  return "release" in turn ? turn : pacedResult(turn)
}

/**
 * Opens a page the token may open, in its tab or a new one. Exported for
 * the owner's answer to a `browse` request, which allows the site for the
 * tab while it is open.
 */
export async function performNavigate(
  scope: BrowserScope,
  ask: Pick<BrowseAsk, "tabId" | "url" | "exit">,
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
  // Starting Chromium does not count against the call's time limit.
  scope.clock?.start()
  let tab = ownTab(vault, scope.tokenId, ask.tabId)
  const first: string[] = []

  if (tab && ownerHas(tab)) {
    return ownerHolds(tab)
  }

  const note = tab ? holderNote(scope, tab) : null

  if (tab && vault.tabs.get(tab.id) !== tab) {
    tab = null
  }

  if (tab) {
    const closed = await keepExit(scope, vault, tab)

    if (closed) {
      return withLead(closed, note)
    }
  }

  if (!tab) {
    let exit: Awaited<ReturnType<BrowserExits["open"]>> | undefined

    if (ask.exit) {
      if (!scope.exits) {
        return text("A tab cannot go through an exit from here.", true)
      }

      try {
        exit = await scope.exits.open(ask.exit)
      } catch (error) {
        if (error instanceof PcpError) return text(error.message, true)
        throw error
      }
    }

    atStep(scope.clock, "waiting to open a new tab")
    const swept: string[] = []
    let opened: Tab | CallToolResult

    try {
      opened = await withVault(
        vault,
        () => newTab(scope, vault, exit, swept),
        waitBounds(scope),
      )
    } catch (error) {
      if (error instanceof LaneBusy) return busyResult(null, error)
      throw error
    }

    if (!isTab(opened)) {
      return withLead(opened, swept.join("\n") || null)
    }

    const fresh = opened
    tab = fresh

    // Its caller was answered while the tab opened: nobody will use it.
    if (scope.clock?.expired.aborted) {
      await withVault(vault, () => closeTab(vault, fresh)).catch(() => {})
      throw new LaneGaveUp()
    }

    const usage = tabUsage(vault, scope.tokenId)
    first.push(
      ...swept,
      ask.tabId
        ? `There is no tab ${ask.tabId} (it was closed, or the browser has closed since), so the page opened in a new tab: ${tab.id} (${usage}). Name ${tab.id} as tab in the calls that follow.`
        : exit
          ? `Opened a new tab through the exit ${exit.name}: ${tab.id} (${usage}). It is signed in to nothing, and every page of it comes from the exit. Name ${tab.id} as tab in the calls that follow.`
          : `Opened a new tab: ${tab.id} (${usage}). Name ${tab.id} as tab in the calls that follow.`,
    )
  }

  const current = tab

  const answer = onLane(
    scope,
    vault,
    current,
    PACED_TAB_DEADLINE_MS,
    async () => {
      await driveAs(vault, current, scope)

      if (current.dialog) {
        return dialogOpen(current, "navigate")
      }

      const turn = await pacedTurn(
        scope,
        current,
        siteKey(url),
        "browser_navigate",
      )

      if (!isTurn(turn)) {
        return turn
      }

      try {
        return await openIn(current)
      } finally {
        turn.release()
      }
    },
  )

  return withLead(await answer, note)

  async function openIn(current: Tab): Promise<CallToolResult> {
    if (allowedByOwner) {
      current.allowedHosts.add(siteKey(url))
    }

    current.lastBlocked = null
    const since = Date.now()
    atStep(scope.clock, `loading ${siteKey(url)} in tab ${current.id}`, true)
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

    await passCheck(current, scope.clock)
    await saveVaultProfile(scope.ctx, vault, { force: true })
    return report(scope, current, { first, signIns: true, unseen: true })
  }
}

/** tabs open and navigate: decided per site before anything opens. */
async function openSite(
  scope: BrowserScope,
  tabId: string | null,
  rawUrl: string,
  toolName: BrowseAsk["toolName"],
  exitName?: string,
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
  const browse: BrowseAsk = {
    serverId: scope.serverId,
    tabId: inTab,
    url: url.href,
    toolName,
    ...(exitName ? { exit: exitName } : {}),
  }

  // An exit that asks first is asked about with the site: the owner sees
  // both in one request, and allowing it once opens this tab.
  if (exitName) {
    const exit = scope.exits
      ? await scope.exits.check(exitName)
      : ({
          kind: "refused",
          message: "A tab cannot go through an exit from here.",
        } as const)

    if (exit.kind === "refused") {
      return text(exit.message, true)
    }

    if (exit.kind === "ask") {
      throw new OwnerNeeded({
        kind: "exit_use",
        input: {
          exitId: exit.exit.id,
          exitName: exit.exit.name,
          exitLabel: exit.exit.label,
          via: "browser",
          browse,
        },
      })
    }
  }

  if (decided.access === "ask" && !tab?.allowedHosts.has(decided.host)) {
    throw new OwnerNeeded({ kind: "browse", input: browse })
  }

  return performNavigate(scope, {
    tabId: tabId ?? null,
    url: url.href,
    ...(exitName ? { exit: exitName } : {}),
  })
}

async function tabs(
  scope: BrowserScope,
  args: {
    action: string
    url?: string
    tab?: string
    exit?: string
    pace?: BrowserPaceInput
  },
): Promise<CallToolResult> {
  const vault = runningBrowser(scope.ctx.vaultId)

  if (args.action === "open") {
    return openSite(scope, null, args.url!, "tabs", args.exit)
  }

  if (args.action === "list") {
    const lines = await tabLines(scope, vault)

    return text(
      lines.length === 0
        ? noTabs(vault, scope.tokenId)
        : [
            `This token's open tabs (${tabUsage(vault, scope.tokenId)}):`,
            ...lines,
            await ownerPaceLine(scope),
          ].join("\n"),
    )
  }

  const picked = await pickTab(scope, vault, args.tab!)

  if (!isTab(picked)) {
    return picked
  }

  if (ownerHas(picked)) {
    return ownerHolds(picked)
  }

  if (args.action === "pace") {
    return paceTab(scope, picked, args.pace)
  }

  // Neither waits behind a call that hangs on the tab: that call ends with
  // the page.
  if (args.action === "close") {
    await withVault(vault!, () => closeTab(vault!, picked))
    await saveVaultProfile(scope.ctx, vault!, { force: true })
    return text(
      `Closed tab ${picked.id}. ${upper(tabUsage(vault, scope.tokenId))}.`,
    )
  }

  await driveAs(vault!, picked, scope)
  atStep(scope.clock, `reopening tab ${picked.id}`, true)
  return withTail(
    reopenedResult(
      picked,
      await reopenTab(vault!, picked).catch(() => null),
      "reset",
    ),
    `${upper(tabUsage(vault, scope.tokenId))}.`,
  )
}

/** A pace per class, in words: "actions in a page 0.05 to 0.15 s". */
function paceWords(paces: Partial<Record<BrowserPacingClass, string>>): string {
  return BROWSER_PACING_CLASSES.flatMap((pacingClass) =>
    paces[pacingClass]
      ? [`before ${BROWSER_CLASS_WORDS[pacingClass]} ${paces[pacingClass]}`]
      : [],
  ).join(", ")
}

/** A policy in words, or "no wait" for none. */
function policyWords(policy: PacingPolicy | null): string {
  return policy
    ? describeRange({
        minMs: policy.minIntervalMs,
        maxMs: policy.minIntervalMs + policy.jitterMs,
      })
    : "no wait"
}

/** What tabs without a pace of their own follow, as tabs list ends. */
async function ownerPaceLine(scope: BrowserScope): Promise<string> {
  const config = await readPacingConfig(scope.ctx.vaultId)
  const paces: Partial<Record<BrowserPacingClass, string>> = {}

  for (const pacingClass of BROWSER_PACING_CLASSES) {
    paces[pacingClass] = policyWords(
      resolveBrowserPolicy(config, pacingClass, { serverId: scope.serverId }),
    )
  }

  return `A tab without a pace of its own waits, after the previous action at its site, ${paceWords(paces)} (the owner's pace; a site of theirs may have its own). tabs with action pace gives one tab a pace of its own.`
}

/** A tab's own pace, as tabs list shows it; null when it has none. */
function tabPaceText(tab: Tab): string | null {
  const own = tabPace(tab)

  if (!own) return null

  const paces: Partial<Record<BrowserPacingClass, string>> = {}

  for (const pacingClass of BROWSER_PACING_CLASSES) {
    const range = own[PACE_KEY_OF[pacingClass]]
    if (range) paces[pacingClass] = describeRange(range)
  }

  return `its own pace: ${paceWords(paces)}`
}

/**
 * tabs' action pace: the tab's own pace (tab-pace.ts), in memory with the
 * tab. Within the owner's bounds it applies at once; outside them the
 * owner is asked (a tab_pace request), and nothing changes until they say
 * yes. Without pace, the tab follows the owner's again.
 */
async function paceTab(
  scope: BrowserScope,
  tab: Tab,
  input: BrowserPaceInput | undefined,
): Promise<CallToolResult> {
  let pace: BrowserPace

  try {
    pace = fromPaceInput(input ?? {})
  } catch (error) {
    if (error instanceof PcpError) return text(error.message, true)
    throw error
  }

  const config = await readPacingConfig(scope.ctx.vaultId)
  const bounds = assistantBounds(config)
  const outside = outsideBounds(pace, bounds)

  if (outside.length > 0) {
    const view = await tabView(tab)

    throw new OwnerNeeded({
      kind: "tab_pace",
      input: {
        serverId: scope.serverId,
        tabId: tab.id,
        url: view.url,
        title: view.title,
        pace,
        outside,
        bounds,
      },
    })
  }

  setTabPace(tab, pace)
  return text(await tabPaceAnswer(scope, tab, config))
}

/** What a tab follows now, per class, as tabs' pace answers. */
async function tabPaceAnswer(
  scope: BrowserScope,
  tab: Tab,
  config?: PacingConfig,
): Promise<string> {
  const read = config ?? (await readPacingConfig(scope.ctx.vaultId))
  const site = tabSite(tab) ?? undefined
  const paces: Partial<Record<BrowserPacingClass, string>> = {}

  for (const pacingClass of BROWSER_PACING_CLASSES) {
    const own = tabPaceFor(tab, pacingClass)
    paces[pacingClass] = `${policyWords(
      resolveBrowserPolicy(read, pacingClass, {
        serverId: scope.serverId,
        site,
        own,
      }),
    )} (${own ? "its own" : "the owner's"})`
  }

  const bounds = assistantBounds(read)

  return [
    `Tab ${tab.id} waits, after the previous action at its site ended, ${paceWords(paces)}${site ? ` at ${site}` : ""}. For this tab only, while it is open; a site the owner paced themselves never goes faster than they set.`,
    `Assistants may set ${paceWords({
      browser_act: describeRange(bounds.browser_act),
      browser_navigate: describeRange(bounds.browser_navigate),
    })} without asking; anything else asks the owner.`,
  ].join("\n")
}

/**
 * A tab's pace the owner allowed on a tab_pace request: set on that tab,
 * still the token's and open, whatever the bounds. False when it is gone.
 */
export function applyTabPace(
  ctx: Pick<VaultContext, "vaultId">,
  tokenId: string,
  tabId: string,
  pace: BrowserPace,
): boolean {
  const tab = runningBrowser(ctx.vaultId)?.tabs.get(tabId)

  if (!tab || tab.tokenId !== tokenId) {
    return false
  }

  setTabPace(tab, pace)
  return true
}

function upper(line: string): string {
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/** The answer with one line after everything its first text says. */
function withTail(result: CallToolResult, line: string): CallToolResult {
  const first = result.content[0]

  return first?.type === "text"
    ? {
        ...result,
        content: [
          { ...first, text: `${first.text}\n${line}` },
          ...result.content.slice(1),
        ],
      }
    : result
}

/** The tools that need the page itself, refused while a dialog is open. */
const NEEDS_THE_PAGE = new Set<BrowserToolName>([
  "back",
  "read_page",
  "find",
  "click",
  "drag",
  "type",
  "press_key",
  "select_option",
  "upload_file",
  "scroll",
  "wait_for",
  "download",
  "print_pdf",
  "evaluate",
])

async function onTab(
  scope: BrowserScope,
  tabId: string,
  spec: BrowserToolSpec,
  run: (tab: Tab, vault: VaultBrowser) => Promise<CallToolResult>,
  {
    pacing = browserPacingClass(spec.name),
  }: {
    /** How the call is paced, when not as its tool is (download by url). */
    pacing?: BrowserPacingClass | null
  } = {},
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
  const closed = await keepExit(scope, vault!, picked)

  if (closed) {
    return withLead(closed, note)
  }

  // Files cross only through the vault's own context (downloads.ts).
  if (spec.name === "download" && picked.exit) {
    return text(
      `Tab ${picked.id} goes through the exit ${picked.exit.name}, and a tab that goes through an exit downloads nothing.`,
      true,
    )
  }

  const answer = await onLane(
    scope,
    vault!,
    picked,
    (spec.name === "download" ? DOWNLOAD_DEADLINE_MS : TAB_DEADLINE_MS) +
      (pacing ? PACED_TURN_WAIT_MS : 0),
    async () => {
      await driveAs(vault!, picked, scope)
      const refused = offLimits(vault!, picked)

      if (refused) {
        return refused
      }

      if (picked.dialog && NEEDS_THE_PAGE.has(spec.name)) {
        return dialogOpen(picked, spec.name)
      }

      const turn = await pacedTurn(scope, picked, tabSite(picked), pacing)

      if (!isTurn(turn)) {
        return turn
      }

      try {
        return await acting(picked)
      } finally {
        turn.release()
      }
    },
  )

  return withLead(answer, note)

  /** The tool's own work, its turn taken. */
  async function acting(tab: Tab): Promise<CallToolResult> {
    atStep(
      scope.clock,
      `running ${spec.name} on tab ${tab.id}`,
      !spec.annotations.readOnlyHint,
    )
    let result: CallToolResult

    try {
      result = await run(tab, vault!)
    } catch (error) {
      if (error instanceof PcpError || error instanceof OwnerNeeded) {
        throw error
      }

      // A dialog the action opened is why it stopped.
      const dialog = dialogNote(tab)
      result = text(
        dialog ? `${failureReason(error)}\n${dialog}` : failureReason(error),
        true,
      )
    }

    if (spec.changes) {
      await saveVaultProfile(scope.ctx, vault!, { force: true })
    }

    return result
  }
}

/**
 * An answer with what the token's tabs hold of a secret PCP typed shown as
 * [secret: name], wherever it appears (held.ts): a page can repeat a field's
 * value in its text or its title. Then every secret PCP typed into any of
 * the token's tabs while it lived, as it is or as a page writes it its own
 * way (spaced, upper case), whichever page the tab shows now: a summary
 * page repeats what was typed on the one before.
 */
async function maskHeld(
  { ctx, tokenId }: Pick<BrowserScope, "ctx" | "tokenId">,
  result: CallToolResult,
): Promise<CallToolResult> {
  const vault = runningBrowser(ctx.vaultId)
  let masked = result
  const pages: Page[] = []

  for (const tab of vault?.tabs.values() ?? []) {
    if (tab.tokenId !== tokenId) {
      continue
    }

    pages.push(tab.page)

    for (const { name, value } of (await heldValues(tab.page)).values) {
      masked = scrubResult(masked, [value], { replacement: secretMask(name) })
    }
  }

  return maskTypedResult(pages, masked)
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
    // A field inside a web component (a shadow root) is its root's active
    // element, and the document's is the component itself.
    const focused = await handle
      .evaluate((element) => {
        let node: Element = element

        for (;;) {
          const root = node.getRootNode()

          if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in root) {
            const shadow = root as ShadowRoot
            if (shadow.activeElement !== node) return false
            node = shadow.host
            continue
          }

          const doc = node.ownerDocument
          if (root !== doc || doc.activeElement !== node) return false
          const around = doc.defaultView?.frameElement
          if (!around) return true
          node = around
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

    // A login name is typed through the same gate but is no secret from
    // the assistant (the page's sign-in note names it): not held. A
    // password is held as the field has it (the page may have cut or
    // reformatted it), and as it was typed, which a later page may repeat.
    if (typer.part !== "username") {
      holdSecret(
        tab.page,
        typer.name,
        await handle
          .inputValue({ timeout: ACTION_TIMEOUT_MS })
          .catch(() => value),
      )
      holdSecret(tab.page, typer.name, value)
    }

    if (args.submit) {
      await locator.press("Enter", { timeout: ACTION_TIMEOUT_MS })
    }
  } finally {
    await handle.dispose().catch(() => {})
  }

  await settle(tab)
  return report(scope, tab, {
    lead: [
      typer.part === "username"
        ? `Typed the login name of "${typer.name}" into ${label}.`
        : `Typed the secret "${typer.name}" into ${label}. It shows as ${secretMask(typer.name)}, and the tab takes no screenshots while a field holds it.`,
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

/**
 * One end of a drag: a point (x, y; to_x, to_y), or the middle of an
 * element (ref or target; to_ref or to_target), scrolled into view first.
 */
async function pointOf(
  tab: Tab,
  args: Record<string, unknown>,
  prefix: "" | "to_",
): Promise<{ x: number; y: number } | CallToolResult> {
  if (args[`${prefix}x`] !== undefined) {
    return { x: args[`${prefix}x`] as number, y: args[`${prefix}y`] as number }
  }

  const found = await element(tab, {
    ref: args[`${prefix}ref`],
    target: args[`${prefix}target`],
  })

  if (!isElement(found)) {
    return found
  }

  await found.locator
    .scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS })
    .catch(() => {})
  const box = await found.locator.boundingBox({ timeout: ACTION_TIMEOUT_MS })

  if (!box) {
    return text(
      `${found.label} shows nowhere on the page now, so there is nothing to drag ${prefix ? "to" : "from"}. Take a snapshot to see what the page has.`,
      true,
    )
  }

  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  }
}

/**
 * How a screenshot's pixels map to the viewport's CSS pixels, which click,
 * scroll and drag take as x and y.
 */
function pictureScale(picture: {
  scale: number
  origin: { x: number; y: number }
}): string {
  const { scale, origin } = picture
  const left = Math.round(origin.x)
  const top = Math.round(origin.y)

  if (scale === 1 && left === 0 && top === 0) {
    return "Its pixels are the viewport's CSS pixels: a point at x, y in it is x, y for click, scroll and drag."
  }

  const factor = Math.round((1 / scale) * 1000) / 1000
  const across = [
    left !== 0 ? `${left} + ` : "",
    scale === 1 ? "x" : `x × ${factor}`,
  ].join("")
  const down = [
    top !== 0 ? `${top} + ` : "",
    scale === 1 ? "y" : `y × ${factor}`,
  ].join("")

  return `Scale ${Math.round(scale * 1000) / 1000}${left || top ? `, its top left at x ${left}, y ${top} of the viewport` : ""}: a point at x, y in this picture is x ${across}, y ${down} in the viewport's CSS pixels, which click, scroll and drag take.`
}

/** How a picture of the whole page maps to the page, in words. */
function fullPageScale(picture: {
  scale: number
  height: number
  origin: { x: number; y: number }
  cut: boolean
}): string {
  const factor = Math.round((1 / picture.scale) * 1000) / 1000
  const top = Math.round(-picture.origin.y)

  return [
    `The whole page from its top${picture.cut ? `, cut at ${MAX_FULL_PAGE_HEIGHT.toLocaleString("en")} CSS pixels down (the page goes on past that)` : ""}.`,
    picture.scale === 1
      ? "Its pixels are the page's CSS pixels,"
      : `A pixel here is ${factor} of the page's CSS pixels,`,
    `not the viewport's: the viewport shows the part from y ${top} down, so scroll to a part before you click, scroll or drag at a point of it.`,
  ].join(" ")
}

/**
 * A capture of the page (screenshot, print_pdf) refused while a field holds
 * a secret PCP typed: the picture would show it.
 */
async function capturesRefused(
  tab: Tab,
  what: string,
): Promise<CallToolResult | null> {
  const held = await heldSecret(tab.page)

  return held
    ? text(
        `A field in tab ${tab.id} holds the secret "${held}", which PCP typed, so the tab takes no ${what} until the field changes or the page moves on. Take a snapshot to see the page: it shows the field as ${secretMask(held)}.`,
        true,
      )
    : null
}

/** print_pdf's paper sizes, in inches across and down. */
const PAPER: Record<string, { width: number; height: number }> = {
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  tabloid: { width: 11, height: 17 },
  a3: { width: 11.69, height: 16.54 },
  a4: { width: 8.27, height: 11.69 },
  a5: { width: 5.83, height: 8.27 },
}

/**
 * print_pdf: the tab's page printed to a PDF by Chromium (Page.printToPDF on
 * the tab's own DevTools session), kept for the token as a file and
 * answered with its handle. Refused while a field holds a typed secret.
 */
async function printPdf(
  scope: BrowserScope,
  tab: Tab,
  args: Record<string, unknown>,
  keepBytes: BytesKeeper | undefined,
): Promise<CallToolResult> {
  if (!keepBytes) {
    return text(
      "A PDF is kept as a result for the token, which this call cannot make.",
      true,
    )
  }

  const held = await capturesRefused(tab, "PDFs")

  if (held) {
    return held
  }

  const paper = PAPER[(args.paper as string | undefined) ?? "letter"]!
  let data: string

  try {
    ;({ data } = await bounded(
      tab.cdp.send("Page.printToPDF", {
        landscape: args.landscape === true,
        printBackground: args.print_background === true,
        paperWidth: paper.width,
        paperHeight: paper.height,
        ...(typeof args.page_ranges === "string"
          ? { pageRanges: args.page_ranges.replace(/\s+/g, "") }
          : {}),
      }),
      ACTION_TIMEOUT_MS,
      "page.pdf",
    ))
  } catch (error) {
    return text(
      /range/i.test(firstLine(error))
        ? `The page has no ${String(args.page_ranges)}: ask for pages it has, or leave out page_ranges for all of them.`
        : `The page could not be printed: ${failureReason(error)}`,
      true,
    )
  }

  const bytes = Buffer.from(data, "base64")
  let title = ""

  try {
    title = await tab.page.title()
  } catch {
    // A page that went away keeps the default name.
  }

  let kept: Awaited<ReturnType<BytesKeeper>>

  try {
    kept = await keepBytes({
      bytes,
      mediaType: "application/pdf",
      name: `${pdfName(title)}.pdf`,
      serverId: scope.serverId,
      toolName: "print_pdf",
    })
  } catch (error) {
    if (error instanceof PcpError) return text(error.message, true)
    throw error
  }

  return text(
    JSON.stringify(
      {
        tab: tab.id,
        file: handleOf(kept),
        from: tab.page.url().slice(0, MAX_URL_LENGTH),
        note: `PCP keeps this PDF for you: pass {"$result": "${kept.id}"} where a tool wants a file (send_email's or create_draft's attachments, save_file, convert_document), read it with read_result, or get it onto your own computer with share_result's link where this token has it.`,
      },
      null,
      2,
    ),
  )
}

/** A file name from a page's title: its words, or "page". */
function pdfName(title: string): string {
  const name = title
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim()

  return name || "page"
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
  scope: BrowserScope,
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
  /** The snapshot the text came from, when it did. */
  let fromSnapshot: SnapshotNode[] | null = null

  if (visibleChars(markdown) < MIN_READ_PAGE_TEXT_CHARS) {
    const nodes = parseSnapshot(await tabSnapshot(tab).catch(() => ""))
    const part = partOf(nodes)
    const words = part ? snapshotText(part) : ""

    if (visibleChars(words) > visibleChars(markdown)) {
      body = words
      fromSnapshot = nodes
      lead.push(FROM_SNAPSHOT)
    }
  }

  // The whole page's text leaves out what its frames, closed shadow roots
  // and canvases show; one element's or the main part's says nothing of
  // them.
  if (!args.ref && !args.target && !args.main_only) {
    const unseen = fromSnapshot
      ? await unseenNote(scope, tab, fromSnapshot)
      : await unseenWords(
          scope,
          await unseenInHtml(tab).catch(() => NOTHING_UNSEEN),
        )

    if (unseen) {
      lead.push(unseen)
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
  scope: BrowserScope,
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
  // Nothing found on a page that shows more than its tree: say so, so the
  // page is not taken for one without it.
  const unseen =
    total === 0
      ? await unseenNote(scope, tab, args.within ? nodes : tree)
      : null

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
        ...(unseen
          ? {
              unseen: formLike(args.text)
                ? `${unseen} The form or field you looked for may be in one of them.`
                : unseen,
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
  server: Pick<McpServer, "id" | "name"> & { slug?: string },
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
  server: Pick<McpServer, "id" | "name"> & { slug?: string },
  toolName: string,
  rawArgs: Record<string, unknown>,
  {
    tokenId,
    publicUrl,
    open,
    keep,
    keepBytes,
    signal,
    deadline,
    runId,
    secret,
    exits,
    pace,
  }: {
    tokenId: string
    publicUrl: string
    /** Keeps a long text for the token: evaluate's long result. */
    keep?: ResultKeeper
    /** The exits a new tab may go out through (upstream.ts browserExitsFor). */
    exits?: BrowserExits
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
    /** The pace a wrapper's run chose for the call (BrowserScope.pace). */
    pace?: PaceRange
    /**
     * The secret a type call carries as {"$secret": name}, from upstream.ts:
     * the only way one reaches a page.
     */
    secret?: SecretTyper
  },
): Promise<CallToolResult> {
  const spec = browserToolSpec(toolName)

  if (!spec) {
    return familyError(
      `${server.name} has no tool called ${toolName}.`,
      "not_found",
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
    ...(exits ? { exits } : {}),
    ...(pace ? { pace } : {}),
    runId,
  }
  const listsOrOpens =
    spec.name === "request_secret" ||
    spec.name === "update_secret_sites" ||
    (spec.name === "tabs" &&
      (rawArgs.action === "open" || rawArgs.action === "list"))

  if (!listsOrOpens && (rawArgs.tab == null || rawArgs.tab === "")) {
    return missingTab(scope, spec.name)
  }

  // Before the browser is touched: an unknown id never reaches a page.
  const checked = spec.check(
    open ? await resolveHandles(rawArgs, open, { skip: ["files"] }) : rawArgs,
  )

  if (!checked.fits) {
    return argumentsResult(
      `${server.slug ?? "browser"}/${spec.name}`,
      checked.problems,
      {
        notes: checked.notes,
        hint: tabProblem(checked.problems)
          ? await tabHint(ctx, tokenId, publicUrl)
          : undefined,
      },
    )
  }

  return withNotes(
    await runCheckedTool(scope, server, spec, checked.args, {
      open,
      keep,
      keepBytes,
      secret,
    }),
    checked.notes,
  )
}

/** Whether a refusal of arguments is about the tab, so it lists the tabs. */
export function tabProblem(problems: string[]): boolean {
  return problems.some((problem) => /\btab\b/.test(problem))
}

type ToolExtras = {
  open: ResultOpener | undefined
  keep?: ResultKeeper
  keepBytes: BytesKeeper | undefined
  secret: SecretTyper | undefined
}

/** The tools that wait DEFAULT_CALL_TIMEOUT_MS unless timeout_ms says otherwise. */
function defaultTimeout(
  name: BrowserToolName,
  args: Record<string, unknown>,
): boolean {
  return (
    name === "navigate" ||
    name === "snapshot" ||
    (name === "tabs" && args.action === "open")
  )
}

/**
 * The call's time limit: timeout_ms, or its tool's default; null for none
 * (the tab's deadline alone). tabs list and close wait for nothing.
 */
function clockFor(
  spec: BrowserToolSpec,
  args: Record<string, unknown>,
): CallClock | null {
  if (
    spec.name === "tabs" &&
    (args.action === "list" || args.action === "close")
  ) {
    return null
  }

  const given = args.timeout_ms as number | undefined

  if (given !== undefined) {
    return callClock(given, true)
  }

  return defaultTimeout(spec.name, args)
    ? callClock(DEFAULT_CALL_TIMEOUT_MS, false)
    : null
}

/**
 * A browser tool on arguments checked against its schema: first the tabs
 * that are done with are closed (sweep.ts; never the one it names), then
 * the tool runs, within its time limit when it has one. When the limit
 * runs out the call is answered at once with a `timeout` tool error naming
 * the step it was at (clock.ts); what it had begun finishes alone.
 */
async function runCheckedTool(
  scope: BrowserScope,
  server: Pick<McpServer, "id" | "name">,
  spec: BrowserToolSpec,
  args: Record<string, unknown>,
  extras: ToolExtras,
): Promise<CallToolResult> {
  const swept = await sweepTabs(scope, (args.tab as string | undefined) ?? null)
  const lead = swept.length > 0 ? swept.join("\n") : null
  const clock = clockFor(spec, args)

  if (!clock) {
    return withLead(await runTool(scope, server, spec, args, extras), lead)
  }

  const timed: BrowserScope = {
    ...scope,
    clock,
    deadline: Math.min(scope.deadline ?? Infinity, Date.now() + clock.ms),
  }

  // tabs open and navigate start it once the browser runs (performNavigate).
  if (!(spec.name === "navigate" || args.action === "open")) {
    clock.start()
  }

  const work = runTool(timed, server, spec, args, extras)
  const first = await Promise.race([
    work.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    ),
    clock.ended.then(() => null),
  ])
  clock.stop()

  if (first && "result" in first) {
    return withLead(first.result, lead)
  }

  if (first && !(first.error instanceof LaneGaveUp)) {
    throw first.error
  }

  // The work goes on alone; what it comes to is nobody's answer.
  void work.catch(() => {})

  return withLead(
    familyError(timeoutMessage(`browser/${spec.name}`, clock), "timeout"),
    lead,
  )
}

/** One browser tool, its time limit (if any) on the scope. */
async function runTool(
  scope: BrowserScope,
  server: Pick<McpServer, "id" | "name">,
  spec: BrowserToolSpec,
  args: Record<string, unknown>,
  { open, keep, keepBytes, secret }: ToolExtras,
): Promise<CallToolResult> {
  const { ctx, tokenId, publicUrl, signal } = scope

  if (!checkRateLimit(`browser:${tokenId}`, BROWSER_ACTIONS).allowed) {
    return text(
      "That is a lot of browsing in a short time. Wait a few minutes.",
      true,
    )
  }

  const tab = args.tab as string

  switch (spec.name) {
    case "tabs":
      return tabs(scope, args as Parameters<typeof tabs>[1])
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
      return onTab(scope, tab, spec, (current) =>
        report(scope, current, { signIns: true, unseen: true }),
      )
    case "read_page":
      return onTab(scope, tab, spec, (current) =>
        readPage(scope, current, args),
      )
    case "find":
      return onTab(scope, tab, spec, (current) =>
        findOnPage(scope, current, args as { text: string; within?: string }),
      )
    case "click":
      return onTab(scope, tab, spec, async (current) => {
        const button = (args.button as MouseButton | undefined) ?? "left"

        if (args.x !== undefined) {
          const at = await clickAt(
            current,
            { x: args.x as number, y: args.y as number },
            { button, double: args.double === true },
          )
          await settle(current)
          return report(scope, current, {
            lead: [
              `${args.double ? "Double-clicked" : "Clicked"}${button === "left" ? "" : ` with the ${button} button`} at x ${at.x}, y ${at.y} of the viewport.`,
            ],
          })
        }

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
            button,
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
    case "drag":
      return onTab(scope, tab, spec, async (current) => {
        const from = await pointOf(current, args, "")
        if ("content" in from) return from
        const to = await pointOf(current, args, "to_")
        if ("content" in to) return to
        const moved = await dragBetween(current, from, to, {
          button: (args.button as MouseButton | undefined) ?? "left",
        })
        await settle(current)
        return report(scope, current, {
          lead: [
            `Dragged from x ${moved.from.x}, y ${moved.from.y} to x ${moved.to.x}, y ${moved.to.y} of the viewport.`,
          ],
        })
      })
    case "type": {
      const ref = parseSecretRef(args.text)
      const named = ref?.name ?? null

      if (
        ref !== null &&
        (secret?.name !== ref.name || secret.part !== ref.part)
      ) {
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
      return onTab(
        scope,
        tab,
        spec,
        (current, vault) =>
          downloadFile(
            scope,
            vault,
            current,
            args as { ref?: string; url?: string },
            keepBytes,
          ),
        { pacing: browserPacingClass("download", args) },
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
          const dx =
            direction === "left" ? -amount : direction === "right" ? amount : 0
          const dy =
            direction === "up" ? -amount : direction === "down" ? amount : 0

          if (args.x !== undefined) {
            await wheelAt(
              current,
              { x: args.x as number, y: args.y as number },
              { dx, dy },
            )
          } else {
            await current.page.mouse.wheel(dx, dy)
          }
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

        const held = await capturesRefused(current, "screenshots")

        if (held) {
          return held
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
          fullPage: args.full_page === true,
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
              text: [
                `Tab ${current.id}: ${current.page.url()} (${label ? `${label}, ` : picture.fullPage ? "the whole page, " : ""}${picture.width} by ${picture.height}${picture.scale < 1 ? ", made smaller to pass on" : ""}, JPEG quality ${picture.quality}; the owner can watch the tab: ${markdownLink(`Watch tab ${current.id}`, tabLink(publicUrl, current.id))})`,
                picture.fullPage
                  ? fullPageScale(picture)
                  : pictureScale(picture),
                `To read the text in this picture, ${await ocrWords(scope)}; read_result does not show an image.`,
              ].join("\n"),
            },
            {
              type: "image",
              data: picture.bytes.toString("base64"),
              mimeType: "image/jpeg",
            },
          ],
        }
      })
    case "print_pdf":
      return onTab(scope, tab, spec, (current) =>
        printPdf(scope, current, args, keepBytes),
      )
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
          username: args.username as string | undefined,
          generate: args.generate,
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
    case "update_secret_sites": {
      let input

      try {
        input = await checkSecretSitesChange(ctx, server.id, {
          name: args.name as string,
          reason: args.reason as string,
          add: args.add as
            Array<{ origin: string; subdomains?: boolean }> | undefined,
          remove: args.remove as string[] | undefined,
        })
      } catch (error) {
        // Its refusals name sites: a tool error, out of the log.
        if (error instanceof PcpError) {
          return text(error.message, true)
        }

        throw error
      }

      // Always the owner's, whatever the token's levels.
      throw new OwnerNeeded({ kind: "secret_sites_change", input })
    }
    case "evaluate":
      return onTab(scope, tab, spec, (current) =>
        evaluateInTab(
          {
            vaultId: ctx.vaultId,
            tokenId,
            serverId: server.id,
            ...(keep ? { keep } : {}),
          },
          current,
          args.script as string,
        ),
      )
    case "console_log":
      return onTab(scope, tab, spec, (current) => consoleLog(current, args))
    case "network_log":
      return onTab(scope, tab, spec, (current) =>
        networkLog(current, args, {
          serverId: server.id,
          ...(keep ? { keep } : {}),
          ...(keepBytes ? { keepBytes } : {}),
        }),
      )
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
