import { STATUS_CODES } from "node:http"

import type { CallToolResult } from "@modelcontextprotocol/server"
import type { Page } from "patchright-core"

import type { VaultContext } from "../context"
import { PcpError } from "../errors"
import { CHALLENGE_LINE } from "../fetch/challenge"
import {
  isPcpSite,
  otherSite,
  presentPage,
  type FetchAnswer,
} from "../fetch/fetch"
import { MAX_FETCH_RESPONSE_BYTES } from "../fetch/limits"
import type { FetchArgs } from "../fetch/request"
import { siteKey } from "../fetch/rules"
import { chromiumExecutable } from "./executable"
import {
  CHALLENGE_WAIT_MS,
  CLEARANCE_MEMORY_MS,
  NAVIGATION_TIMEOUT_MS,
  SOLVE_TIMEOUT_MS,
} from "./limits"
import {
  closeSolvePage,
  ensureBrowser,
  openSolvePage,
  runningBrowser,
  type Solve,
  type VaultBrowser,
} from "./runtime"
import { findBrowserServer } from "./server"

/**
 * web_fetch's way past a site's check of its visitors (fetch/challenge.ts):
 * the page read again through the vault's browser, which runs the check's
 * script and waits for it to pass on its own, as FlareSolverr does, but
 * inside PCP and on every deployment. The page opens in the browser's
 * fetch context (runtime.ts openSolvePage): none of the vault's sign-ins,
 * never saved, one site only. What comes back is web_fetch's usual answer
 * (presentPage), with a note on where the text came from.
 *
 * It never reads a cookie, never touches the vault's own context (the
 * sign-ins), never runs anything in the page, and never logs an address or
 * a host: sites stay out of PCP's logs, as web_fetch's and the proxy's do.
 * A site the browser could not pass is said so in the answer, which stays
 * about the site the assistant asked for; another site a redirect pointed
 * to is named as web_fetch names it, for the assistant to ask about.
 *
 * It must not import browser/call.ts, browser/owner.ts or web-fetch.ts:
 * those import web-fetch.ts, which imports this module.
 */

/** What a solve answers when the request is not a plain GET. */
export const GET_ONLY_LINE =
  "PCP's browser can pass such a check only for a GET request: it cannot send a body or an assistant's own headers."
/** What a solve answers when the check did not pass in time. */
export const NOT_PASSED_LINE = "PCP's browser could not pass it on its own."
/** The source note on a page the browser read, after it met the check. */
export const SOURCE_AFTER_CHECK =
  "read through PCP's browser, after the site's check"
/** The source note on a page the browser read without meeting a check. */
export const SOURCE_PLAIN = "read through PCP's browser"

/**
 * Whether web_fetch can read a page through the browser here: the owner
 * added the browser (its server row, enabled) and Chromium is on the
 * machine. Neither starts it.
 */
export async function solverAvailable(ctx: VaultContext): Promise<boolean> {
  const server = await findBrowserServer(ctx)

  if (!server?.enabled) {
    return false
  }

  return (await chromiumExecutable()) !== null
}

/**
 * Whether the running browser still holds what passing a site's check gave
 * it (a solve passed one within CLEARANCE_MEMORY_MS): web_fetch then reads
 * the site through the browser first.
 */
export function hasClearance(vaultId: string, host: string): boolean {
  const vault = runningBrowser(vaultId)

  if (!vault) {
    return false
  }

  const now = Date.now()

  for (const [site, until] of vault.clearances) {
    if (until <= now) vault.clearances.delete(site)
  }

  return vault.clearances.has(host)
}

function result(text: string, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split("\n")[0] ?? "").slice(0, 300)
}

function statusText(code: number): string {
  const text = STATUS_CODES[code]
  return `HTTP ${code}${text ? ` ${text}` : ""}`
}

/** An answer about the check itself: the site checked, and the browser could not get past it. */
function unpassed(
  url: URL,
  lines: string[],
  status?: number | null,
): FetchAnswer {
  return {
    challenged: true,
    result: result(
      [
        `URL: ${url}`,
        ...(typeof status === "number"
          ? [`Status: ${statusText(status)}`]
          : []),
        CHALLENGE_LINE,
        ...lines,
      ].join("\n"),
      true,
    ),
  }
}

/** A final answer, not about a check: the plain fetch would say the same. */
function decided(text: string, isError: boolean): FetchAnswer {
  return { challenged: false, result: result(text, isError) }
}

class SolveTimeout extends Error {
  constructor() {
    super("solve timeout")
  }
}

/** Runs `work`, or gives up after `ms`; what it started goes on without us. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    return Promise.reject(new SolveTimeout())
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SolveTimeout()), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function timeoutLine(): string {
  return `PCP's browser did not get the page within ${Math.round(SOLVE_TIMEOUT_MS / 1000)} seconds.`
}

/** The page's HTML, read again once if a navigation tore the first read down. */
async function readContent(page: Page, ms: number): Promise<string> {
  try {
    return await within(page.content(), ms)
  } catch (error) {
    if (error instanceof SolveTimeout) throw error
    // "Execution context was destroyed": the check's script moved the
    // page on as we read it. Once the next document is there, read that.
    await page
      .waitForLoadState("domcontentloaded", { timeout: Math.max(1, ms) })
      .catch(() => {})
    return within(page.content(), ms)
  }
}

/** The text within web_fetch's limit, cut at a character if it is over. */
function fit(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8")

  if (bytes.length <= MAX_FETCH_RESPONSE_BYTES) {
    return { text, truncated: false }
  }

  return {
    text: bytes
      .subarray(0, MAX_FETCH_RESPONSE_BYTES)
      .toString("utf8")
      .replace(/\uFFFD$/, ""),
    truncated: true,
  }
}

/** Why the page did not open, in web_fetch's words. */
function notOpened(
  vault: VaultBrowser,
  solve: Solve,
  url: URL,
  error: unknown,
  since: number,
  redirect: string | null,
): FetchAnswer {
  const host = siteKey(url)

  if (solve.refused !== null) {
    // The site asked about redirected elsewhere; that site gets its own
    // decision when the assistant fetches it, as with web_fetch.
    return decided(
      otherSite(redirect ?? "Redirected", url, solve.refused),
      false,
    )
  }

  const refusal = vault.proxy.refusal(url.hostname, since)

  if (refusal === "own") {
    return decided(
      `${host} is, or resolves to, PCP's own address, which web_fetch never reaches.`,
      true,
    )
  }

  if (refusal === "private") {
    return decided(
      `${host} is, or resolves to, a private or local address, which the owner has not allowed for this token. They can allow private addresses on the token's page in PCP.`,
      true,
    )
  }

  return unpassed(url, [
    `${host} could not be opened in PCP's browser: ${firstLine(error)}`,
  ])
}

/**
 * Reads a page through the browser, for a web_fetch that met a site's
 * check (or a site the browser holds a clearance for). One deadline,
 * SOLVE_TIMEOUT_MS, covers everything from starting Chromium to the text.
 * `challenged` in the answer means the check is still in the way: the
 * caller falls back, or says what the owner can do.
 */
export async function fetchThroughBrowser(
  ctx: VaultContext,
  args: FetchArgs,
  {
    allowPrivate = false,
    publicUrl,
  }: { allowPrivate?: boolean; publicUrl?: string } = {},
): Promise<FetchAnswer> {
  const url = new URL(args.url)
  const host = siteKey(url)

  // The browser opens a page: it cannot repeat a body or an assistant's
  // headers, so only a plain read is read again this way.
  if (args.method !== "GET") {
    return {
      challenged: true,
      result: result(`${CHALLENGE_LINE}\n${GET_ONLY_LINE}`, true),
    }
  }

  if (isPcpSite(url, publicUrl)) {
    return decided(
      `${host} is PCP's own address, which web_fetch never reaches.`,
      true,
    )
  }

  const deadline = Date.now() + SOLVE_TIMEOUT_MS
  const left = () => deadline - Date.now()
  let vault: VaultBrowser

  try {
    vault = await within(ensureBrowser(ctx, { publicUrl }), left())
  } catch (error) {
    if (error instanceof PcpError) {
      return unpassed(url, [error.message])
    }

    if (error instanceof SolveTimeout) {
      return unpassed(url, [timeoutLine()])
    }

    throw error
  }

  let solve: Solve

  try {
    solve = await openSolvePage(vault, { url, privateAllowed: allowPrivate })
  } catch (error) {
    if (error instanceof PcpError) {
      return unpassed(url, [error.message])
    }

    throw error
  }

  try {
    const since = Date.now()
    let redirect: string | null = null
    // The watch (challenge.ts) keeps documents only; a redirect's status is
    // what web_fetch names when it stops at another site.
    solve.page.on("response", (response) => {
      try {
        const code = response.status()

        if (
          code >= 300 &&
          code < 400 &&
          response.frame() === solve.page.mainFrame() &&
          response.request().isNavigationRequest()
        ) {
          redirect = statusText(code)
        }
      } catch {
        // A response with no frame is not a document's.
      }
    })

    const opening = Math.min(NAVIGATION_TIMEOUT_MS, left())

    if (opening <= 0) {
      return unpassed(url, [timeoutLine()])
    }

    let failed = false
    let failure: unknown = null

    try {
      await solve.page.goto(url.href, {
        waitUntil: "domcontentloaded",
        timeout: opening,
      })
    } catch (error) {
      failed = true
      failure = error
    }

    // A redirect elsewhere is stopped by the gate, which may leave goto
    // settled either way.
    if (failed || solve.refused !== null) {
      return notOpened(vault, solve, url, failure, since, redirect)
    }

    let met = false

    if (solve.documents.challenged()) {
      met = true
      const wait = Math.min(CHALLENGE_WAIT_MS, left())
      const outcome = wait > 0 ? await solve.documents.pass(wait) : "still"

      if (outcome === "still") {
        // Whatever the browser held for the site no longer passes.
        vault.clearances.delete(host)
        return unpassed(url, [NOT_PASSED_LINE], solve.documents.status())
      }

      if (outcome === "gone") {
        return unpassed(url, [
          "The page closed in PCP's browser before the check passed.",
        ])
      }
    }

    const code = solve.documents.status()

    if (code === null) {
      return unpassed(url, [
        `${host} could not be opened in PCP's browser: no page came.`,
      ])
    }

    let html: string

    try {
      html = await readContent(solve.page, left())
    } catch (error) {
      if (error instanceof SolveTimeout) {
        return unpassed(url, [timeoutLine()])
      }

      return unpassed(url, [
        `${host} could not be read in PCP's browser: ${firstLine(error)}`,
      ])
    }

    const { text, truncated } = fit(html)
    vault.clearances.set(host, Date.now() + CLEARANCE_MEMORY_MS)

    return {
      challenged: false,
      result: presentPage(
        {
          url: solve.page.url(),
          status: statusText(code),
          ok: code >= 200 && code < 300,
          type: "text/html",
          html: true,
          text,
          bytes: Buffer.byteLength(text, "utf8"),
          truncated,
          source: met ? SOURCE_AFTER_CHECK : SOURCE_PLAIN,
        },
        args,
      ),
    }
  } finally {
    await closeSolvePage(vault, solve)
  }
}
