import type { CallToolResult } from "@modelcontextprotocol/server"

import { decideScript, scriptSiteOf, takeScriptOnce } from "../browser-scripts"
import { siteKey } from "../fetch/rules"
import { handleOf, type ResultKeeper } from "../tool-results"
import { familyError, textAnswer } from "../tools/family"
import { makeRedactor } from "../openapi/redact"
import { heldSecret, heldValues, maskTyped } from "./held"
import {
  EVALUATE_INLINE_CHARS,
  EVALUATE_TIMEOUT_MS,
  MAX_EVALUATE_RESULT_CHARS,
} from "./limits"
import { bounded } from "./queue"
import {
  closeTab,
  runningBrowser,
  tabTitle,
  withVault,
  type ScriptRun,
  type Tab,
} from "./runtime"
import { secretMask } from "./snapshot"
import { OwnerNeeded } from "./types"

/**
 * evaluate: an assistant's JavaScript, run in a tab's page. It is the one
 * way a script of an assistant's runs there, and so the one tool that can
 * read what the page holds (its cookies that scripts see, its storage):
 *
 * - Destructive, and asked of the owner per site: unless they allowed
 *   scripts at the tab's site for the token (browser-scripts.ts), or let
 *   this very script run once, it throws OwnerNeeded, a `script_use`
 *   request that shows them the site, the page and the whole script.
 * - Refused while a field of the page holds a secret PCP typed (held.ts),
 *   as screenshot is.
 * - While it runs, the tab reaches its own site only: the tab's DevTools
 *   session pauses every request its frames and workers make and fails the
 *   ones to another site; the gate (runtime.ts mayOpen) keeps its main
 *   frame and popups there, a popup it opens is closed, and the proxies
 *   hold every new connection to another site until it is done, then
 *   refuse the ones it reached for (a WebSocket, which request interception
 *   does not see). What it starts that outlives it (a timer) goes on as the
 *   page's own would.
 * - Bounded in time (EVALUATE_TIMEOUT_MS: its own work, and any promise it
 *   returns), its result as JSON with what PCP typed as a secret shown as
 *   [secret: name], and a long one kept for the token as a result
 *   (tool-results.ts), answered as its handle.
 *
 * The script runs in the page's own world, as the page's scripts do, with
 * DevTools' Runtime.evaluate (which needs no Runtime.enable, so nothing of
 * it shows to the page but what the script itself does).
 */

const GROUP = "pcp-evaluate"

type Remote = {
  type: string
  subtype?: string
  value?: unknown
  unserializableValue?: string
  description?: string
  objectId?: string
}

type Evaluated = {
  result: Remote
  exceptionDetails?: {
    text: string
    exception?: { description?: string }
    lineNumber?: number
  }
}

function thrown(details: NonNullable<Evaluated["exceptionDetails"]>): string {
  return (details.exception?.description ?? details.text).slice(0, 2_000)
}

/** The value a result stands for, as JSON can carry it. */
async function valueOf(tab: Tab, remote: Remote): Promise<unknown> {
  if (remote.unserializableValue !== undefined) {
    return remote.unserializableValue
  }

  if (!remote.objectId) {
    return remote.type === "undefined" ? undefined : remote.value
  }

  const byValue = (await tab.cdp
    .send("Runtime.callFunctionOn", {
      objectId: remote.objectId,
      functionDeclaration: "function () { return this }",
      returnByValue: true,
      objectGroup: GROUP,
    })
    .catch(() => null)) as Evaluated | null

  // A value DevTools cannot hand over whole (a node, a cycle): in words.
  return byValue && !byValue.exceptionDetails
    ? byValue.result.value
    : `[${remote.description ?? remote.type}]`
}

/** The script's result: run, a function called, a promise awaited. */
async function run(tab: Tab, script: string): Promise<Evaluated> {
  const first = (await tab.cdp.send("Runtime.evaluate", {
    expression: script,
    // Statements and top-level await, as DevTools' console takes them.
    replMode: true,
    awaitPromise: true,
    objectGroup: GROUP,
    timeout: EVALUATE_TIMEOUT_MS,
  })) as Evaluated

  if (first.exceptionDetails) {
    return first
  }

  // A promise as the last value is not awaited in this mode: await it.
  if (first.result.subtype === "promise") {
    return (await tab.cdp.send("Runtime.awaitPromise", {
      promiseObjectId: first.result.objectId!,
    })) as Evaluated
  }

  if (first.result.type !== "function") {
    return first
  }

  return (await tab.cdp.send("Runtime.callFunctionOn", {
    objectId: first.result.objectId!,
    functionDeclaration: "async function () { return await this() }",
    awaitPromise: true,
    objectGroup: GROUP,
  })) as Evaluated
}

type Paused = {
  requestId: string
  request: { url: string }
}

/**
 * Runs `work` with the tab kept at its site: its other-site requests
 * refused, its popups closed, and the proxies holding connections
 * elsewhere until it is done. Answers with the hosts it reached for.
 */
async function keptAtSite<T>(
  vaultId: string,
  tab: Tab,
  site: string,
  work: () => Promise<T>,
): Promise<{ value: T; reached: string[] }> {
  let finish = () => {}
  const reached = new Set<string>()
  const script: ScriptRun = {
    site,
    refused: new Set(),
    listeners: new Set(),
    done: new Promise<void>((resolve) => {
      finish = resolve
    }),
  }
  const elsewhere = (address: string): string | null => {
    try {
      const url = new URL(address)
      if (!/^(https?|wss?):$/.test(url.protocol)) return null
      const other = siteKey(url)
      return other === site ? null : other
    } catch {
      return null
    }
  }
  const onPaused = (event: Paused) => {
    const host = elsewhere(event.request.url)
    if (host) reached.add(host)
    void (
      host
        ? tab.cdp.send("Fetch.failRequest", {
            requestId: event.requestId,
            errorReason: "BlockedByClient",
          })
        : tab.cdp.send("Fetch.continueRequest", { requestId: event.requestId })
    ).catch(() => {})
  }
  const onSocket = ({ url }: { url: string }) => {
    const host = elsewhere(url)
    if (!host) return
    reached.add(host)
    script.refused.add(host)
    for (const listener of script.listeners) listener()
  }
  const popupsBefore = tab.popups.length

  tab.script = script
  tab.cdp.on("Fetch.requestPaused", onPaused)
  tab.cdp.on("Network.webSocketCreated", onSocket)

  try {
    await bounded(
      tab.cdp.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      }),
      EVALUATE_TIMEOUT_MS,
      "Fetch.enable",
    )
    return { value: await work(), reached: [...reached] }
  } finally {
    await tab.cdp.send("Fetch.disable").catch(() => {})
    // A moment for what it opened elsewhere to close before the proxies
    // let held connections go.
    if (reached.size > 0) await new Promise((r) => setTimeout(r, 100))
    tab.cdp.off("Fetch.requestPaused", onPaused)
    tab.cdp.off("Network.webSocketCreated", onSocket)
    await closePopupsSince(vaultId, tab, popupsBefore)
    tab.script = null
    finish()
  }
}

/** Popups the tab took in while the script ran: closed. */
async function closePopupsSince(
  vaultId: string,
  tab: Tab,
  before: number,
): Promise<void> {
  const vault = runningBrowser(vaultId)
  const ids = tab.popups.splice(before)

  for (const id of ids) {
    const popup = vault?.tabs.get(id)
    if (vault && popup) {
      await withVault(vault, () => closeTab(vault, popup)).catch(() => {})
    }
  }
}

export type EvaluateScope = {
  vaultId: string
  tokenId: string
  serverId: string
  keep?: ResultKeeper
}

function refused(message: string): CallToolResult {
  return familyError(message, "state")
}

/** The result as the answer carries it: JSON, secrets masked, bounded. */
function shown(
  tab: Tab,
  value: unknown,
  held: Array<{ name: string; value: string }>,
): { text: string; cut: boolean } {
  let text: string

  try {
    text = value === undefined ? "undefined" : JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }

  let masked = maskTyped(tab.page, text)

  for (const { name, value: secret } of held) {
    masked = makeRedactor([secret], { replacement: secretMask(name) }).text(
      masked,
    )
  }

  return masked.length > MAX_EVALUATE_RESULT_CHARS
    ? { text: masked.slice(0, MAX_EVALUATE_RESULT_CHARS), cut: true }
    : { text: masked, cut: false }
}

/** evaluate on the tab, in its turn (call.ts onTab). */
export async function evaluateInTab(
  scope: EvaluateScope,
  tab: Tab,
  script: string,
): Promise<CallToolResult> {
  const held = await heldSecret(tab.page)

  if (held) {
    return refused(
      `A field in tab ${tab.id} holds the secret "${held}", which PCP typed, so no script runs in the tab until the field changes or the page moves on.`,
    )
  }

  const address = tab.page.url()
  const site = scriptSiteOf(address)

  if (!site) {
    return refused(
      `Tab ${tab.id} shows no page at a site, so the script was not run. Open one with navigate first.`,
    )
  }

  const level = await decideScript(scope.vaultId, scope.tokenId, site)

  if (level === "blocked") {
    return refused(
      `The owner has blocked scripts at ${site} for this token, so the script was not run.`,
    )
  }

  if (
    level !== "allowed" &&
    !takeScriptOnce({ tokenId: scope.tokenId, tabId: tab.id, site, script })
  ) {
    throw new OwnerNeeded({
      kind: "script_use",
      input: {
        serverId: scope.serverId,
        tabId: tab.id,
        site,
        url: address,
        title: await tabTitle(tab),
        script,
      },
    })
  }

  let outcome: { value: Evaluated; reached: string[] }
  const started = Date.now()

  try {
    outcome = await keptAtSite(scope.vaultId, tab, site, () =>
      bounded(run(tab, script), EVALUATE_TIMEOUT_MS + 1_000, "evaluate"),
    )
  } catch (error) {
    await tab.cdp.send("Runtime.terminateExecution").catch(() => {})
    await tab.cdp
      .send("Runtime.releaseObjectGroup", { objectGroup: GROUP })
      .catch(() => {})
    // Chromium answers a script its timeout stopped with an internal
    // error, so the time it took says it.
    const timedOut =
      Date.now() - started >= EVALUATE_TIMEOUT_MS ||
      /Timeout \d+ms exceeded|terminated/i.test(
        error instanceof Error ? error.message : String(error),
      )

    return refused(
      timedOut
        ? `The script did not finish within ${EVALUATE_TIMEOUT_MS / 1000} seconds, so it was stopped.`
        : `The script could not run: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300)}`,
    )
  }

  const lead = [
    `Tab ${tab.id}: ran the script at ${site}.`,
    ...(outcome.reached.length > 0
      ? [
          `It reached for other sites, which were refused while it ran: ${outcome.reached.slice(0, 10).join(", ")}.`,
        ]
      : []),
  ]

  if (outcome.value.exceptionDetails) {
    await tab.cdp
      .send("Runtime.releaseObjectGroup", { objectGroup: GROUP })
      .catch(() => {})

    if (/terminated/i.test(thrown(outcome.value.exceptionDetails))) {
      return refused(
        `The script did not finish within ${EVALUATE_TIMEOUT_MS / 1000} seconds, so it was stopped.`,
      )
    }

    return familyError(
      [...lead, `It threw: ${thrown(outcome.value.exceptionDetails)}`].join(
        "\n",
      ),
      "state",
    )
  }

  const value = await valueOf(tab, outcome.value.result)
    .catch(
      () =>
        `[${outcome.value.result.description ?? outcome.value.result.type}]`,
    )
    .finally(() =>
      tab.cdp
        .send("Runtime.releaseObjectGroup", { objectGroup: GROUP })
        .catch(() => {}),
    )
  const result = shown(tab, value, (await heldValues(tab.page)).values)
  const cutNote = result.cut
    ? ` (the first ${MAX_EVALUATE_RESULT_CHARS.toLocaleString("en")} characters: the rest was dropped)`
    : ""

  if (result.text.length > EVALUATE_INLINE_CHARS && scope.keep) {
    const kept = await scope.keep({
      text: result.text,
      mediaType: "application/json",
      name: "evaluate.json",
      serverId: scope.serverId,
      toolName: "evaluate",
    })

    return textAnswer(
      [
        ...lead,
        `Its result is ${result.text.length.toLocaleString("en")} characters of JSON${cutNote}, kept for you: read it with read_result, or pass the handle where a tool takes text.`,
        JSON.stringify(handleOf(kept, result.text.slice(0, 200)), null, 2),
      ].join("\n"),
    )
  }

  return textAnswer(
    [...lead, `Result (JSON${cutNote}):`, result.text].join("\n"),
  )
}
