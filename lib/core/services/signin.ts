import type { CallToolResult } from "@modelcontextprotocol/server"

import type { VaultContext } from "../context"
import { invalid, PcpError } from "../errors"
import { makeRedactor } from "../openapi/redact"
import { linkLabel, linkLastText, nextMessageCheck } from "../owner-link"
import { noteOwnerAsked } from "../request-log"
import { findServer, type OpenServer } from "../server-meta"
import type { NeedsOwner, ServerState } from "../tools/outcome"
import type { ServiceSignin } from "./definition"
import { MAX_SIGNIN_CODE_CHARS, MAX_SIGNIN_URL_CHARS } from "./limits"
import { loadService, serviceBehind, type LoadedService } from "./services"

/**
 * Signing in to the account a service needs, as a step of PCP's own
 * (#163): the service's definition declares it (`signin`,
 * services/definition.ts), and PCP does the rest.
 *
 * - An assistant asks with connect_account (or meets it when a call to
 *   the service fails signed out, `signinOffer`): PCP reads the status tool,
 *   and when it is not signed in answers needs_owner with reason `signin`
 *   and a link to PCP's own sign-in page, `/servers/<id>/sign-in`, last in
 *   its text; check_server on the owner's next message says whether it is
 *   signed in now.
 * - That page is the owner's. It calls the start tool, shows the provider's
 *   address (https only: it is the service's text, so untrusted), takes the
 *   code the owner pastes, and calls the finish tool with it from
 *   upstream.ts. The code is never stored, never in arguments kept
 *   anywhere, never in an answer to an assistant and scrubbed from errors;
 *   the page's calls are the owner's own, so they go by no token's levels,
 *   and the request log (a token's calls) has no line for them.
 *
 * Nothing here reaches the service itself: every call goes through the
 * `SigninCall` the caller hands in (upstream.ts callServerTool, paced and
 * through the service's tunnel), so this module reads no secret.
 */

/** A call of one of the registered server's tools, as upstream.ts makes it. */
export type SigninCall = (
  server: OpenServer,
  tool: string,
  args: Record<string, unknown>,
) => Promise<CallToolResult>

/** A service that signs in, and the server whose tools sign it in. */
export type SigninTarget = {
  service: LoadedService
  /** The server the service registered: the sign-in's tools are its. */
  server: OpenServer
  signin: ServiceSignin
}

/** Whether it is signed in, and as whom, as its status tool says. */
export type SigninState = { signedIn: boolean; who: string | null }

/** A sign-in started: the provider's page for the owner, and until when. */
export type SigninStart = {
  url: string
  /** The address's host, shown to the owner as it is. */
  host: string
  /** When the sign-in ends (ISO), when the service says. */
  expiresAt: string | null
}

/**
 * The service that signs in behind a server: the server a service
 * registered, or the service itself. Null for any other server, or one
 * whose definition declares no sign-in.
 */
export async function signinTarget(
  ctx: VaultContext,
  server: Pick<OpenServer, "id" | "kind">,
): Promise<SigninTarget | null> {
  let service: LoadedService | null = null

  if (server.kind === "service") {
    service = await loadService(ctx, server.id)
  } else if (server.kind === "mcp" || server.kind === "openapi") {
    service = await serviceBehind(ctx, server.id)
  }

  if (!service?.definition.signin || !service.spec.registeredId) {
    return null
  }

  const registered = await findServer(ctx, {
    id: service.spec.registeredId,
    vaultId: ctx.vaultId,
  })

  return registered
    ? { service, server: registered, signin: service.definition.signin }
    : null
}

/** The tool names a sign-in uses, so a call of one is not offered one. */
export function signinTools(signin: ServiceSignin): string[] {
  return [signin.status.tool, signin.start.tool, signin.finish.tool]
}

/** Where the owner signs in, on PCP's own page. */
export function signinPageUrl(publicUrl: string, serverId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/servers/${serverId}/sign-in`
}

/**
 * A tool's answer as fields: its structured content, or the JSON object
 * its first text holds. Null when it has neither.
 */
export function answerFields(
  result: CallToolResult,
): Record<string, unknown> | null {
  const structured = result.structuredContent

  if (
    structured &&
    typeof structured === "object" &&
    !Array.isArray(structured)
  ) {
    return structured as Record<string, unknown>
  }

  for (const block of result.content ?? []) {
    if (block.type !== "text") {
      continue
    }

    try {
      const value = JSON.parse(block.text) as unknown

      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      // Not JSON: the next block, or none.
    }
  }

  return null
}

/** A result's text, one line, clipped: for an error the owner reads. */
export function answerText(result: CallToolResult, max = 500): string {
  const text = (result.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join(" ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()

  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** A name the service gave (who is signed in): one short line of text. */
function shownName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }

  const text = value
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g,
      "",
    )
    .trim()

  return text ? text.slice(0, 200) : null
}

/** What the status tool's answer says, as the definition names its fields. */
export function readSigninState(
  signin: ServiceSignin,
  fields: Record<string, unknown> | null,
): SigninState | null {
  const signedIn = fields?.[signin.status.signed_in]

  if (typeof signedIn !== "boolean") {
    return null
  }

  return {
    signedIn,
    who: signin.status.who ? shownName(fields?.[signin.status.who]) : null,
  }
}

/** Reads whether it is signed in, through its status tool. */
export async function readSignin(
  target: SigninTarget,
  call: SigninCall,
): Promise<SigninState> {
  const answer = await call(target.server, target.signin.status.tool, {})

  if (answer.isError === true) {
    throw new PcpError(
      "upstream",
      `${target.server.name} could not say whether it is signed in: ${answerText(answer) || "its status tool failed"}`,
    )
  }

  const state = readSigninState(target.signin, answerFields(answer))

  if (!state) {
    throw new PcpError(
      "upstream",
      `${target.server.name}'s ${target.signin.status.tool} did not say whether it is signed in (no true or false ${target.signin.status.signed_in} in its answer).`,
    )
  }

  return state
}

/**
 * The provider's address a start tool handed back, checked: an https
 * address without a user name or password in it, within bounds. It is the
 * service's text, so nothing else is opened or shown as a link.
 */
export function checkSigninUrl(value: unknown, service: string): URL {
  const refuse = () =>
    new PcpError(
      "upstream",
      `${service} handed back a sign-in address PCP does not open: only an https address is shown to you.`,
    )

  if (typeof value !== "string" || value.length > MAX_SIGNIN_URL_CHARS) {
    throw refuse()
  }

  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw refuse()
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    throw refuse()
  }

  return url
}

/** When a sign-in ends, as the service said it: an ISO time or epoch. */
export function readExpiry(value: unknown): string | null {
  const at =
    typeof value === "string"
      ? Date.parse(value)
      : typeof value === "number" && Number.isFinite(value)
        ? // Seconds or milliseconds since the epoch.
          value < 1e12
          ? value * 1000
          : value
        : Number.NaN

  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

/** Starts a sign-in: the provider's page for the owner, and until when. */
export async function startSignin(
  target: SigninTarget,
  call: SigninCall,
): Promise<SigninStart> {
  const answer = await call(target.server, target.signin.start.tool, {})

  if (answer.isError === true) {
    throw new PcpError(
      "upstream",
      `${target.server.name} could not start a sign-in: ${answerText(answer) || "its start tool failed"}`,
    )
  }

  const fields = answerFields(answer)
  const url = checkSigninUrl(
    fields?.[target.signin.start.url],
    target.server.name,
  )
  const expires = target.signin.start.expires
    ? readExpiry(fields?.[target.signin.start.expires])
    : null

  return { url: url.href, host: url.host, expiresAt: expires }
}

/**
 * The code the owner pasted, checked before anything is sent: one line of
 * printable text within bounds.
 */
export function checkSigninCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim() : ""

  if (!code) {
    throw invalid("Paste the code the sign-in page showed you.")
  }

  if (code.length > MAX_SIGNIN_CODE_CHARS) {
    throw invalid(
      `A sign-in code is at most ${MAX_SIGNIN_CODE_CHARS} characters: paste the code alone.`,
    )
  }

  if (/[\u0000-\u001f\u007f]/.test(code)) {
    throw invalid("Paste the code on one line, as the sign-in page shows it.")
  }

  return code
}

/** A text with the code taken out, wherever it shows. */
export function scrubCode(text: string, code: string): string {
  const redacted = makeRedactor([code]).text(text)

  return code.length > 0 ? redacted.split(code).join("[redacted]") : redacted
}

/**
 * The finish tool's answer to the code, read: an error's words with the
 * code scrubbed, else nothing (the status is read next).
 */
export function finishProblem(
  target: SigninTarget,
  answer: CallToolResult,
  code: string,
): string | null {
  return answer.isError === true
    ? `${target.server.name} did not take the code: ${scrubCode(answerText(answer), code) || "its finish tool failed"}`
    : null
}

/** A server as needs_owner names it, for check_server's state. */
type Named = { id: string; slug: string; name: string }

/**
 * The answer that hands the owner PCP's sign-in page: needs_owner, reason
 * `signin`, the link last, check_server on their next message.
 */
export function signinResult(
  server: Named,
  publicUrl: string,
  {
    lead = "Not done yet",
    detail,
    state,
  }: { lead?: string; detail?: string; state?: ServerState } = {},
): CallToolResult {
  const pageUrl = signinPageUrl(publicUrl, server.id)
  const label = `Sign in to ${server.name} in PCP`
  noteOwnerAsked()
  const wait = `${nextMessageCheck(`check_server with server "${server.slug}"`, "it is still not signed in")} It says whether it is signed in now. Then try again.`
  const said = `${lead}: ${server.name} is not signed in to its account, so its tools cannot do their work.${detail ? ` It said: ${detail}` : ""} The owner opens the link below signed in to PCP, signs in at the provider's page it shows and pastes the code back there; you never see the code. ${wait}\n\n${linkLastText(pageUrl, label)}`

  const owner: NeedsOwner = {
    kind: "needs_owner",
    reason: "signin",
    url: pageUrl,
    label: linkLabel(label),
    signin: {
      serverId: server.id,
      slug: server.slug,
      name: server.name,
      pageUrl,
    },
    ...(state ? { server: state } : {}),
  }

  return {
    content: [{ type: "text", text: said }],
    structuredContent: owner,
  }
}

/**
 * A call to a service that signs in came back an error: when its status
 * tool says it is signed out, the answer becomes the sign-in link
 * (signinResult), with what the service said, so signing in again is
 * offered by itself. Null otherwise (the error stands): a call that did
 * not fail, one of the sign-in's own tools, a status that says it is
 * signed in or that cannot be read.
 */
export async function signinOffer(
  ctx: VaultContext,
  server: OpenServer,
  toolName: string,
  answer: CallToolResult,
  { call, publicUrl }: { call: SigninCall; publicUrl: string },
): Promise<CallToolResult | null> {
  if (answer.isError !== true) {
    return null
  }

  const target = await signinTarget(ctx, server).catch(() => null)

  if (
    !target ||
    target.server.id !== server.id ||
    signinTools(target.signin).includes(toolName)
  ) {
    return null
  }

  const state = await readSignin(target, call).catch(() => null)

  return state && !state.signedIn
    ? signinResult(server, publicUrl, {
        lead: "Not done",
        detail: answerText(answer, 300) || undefined,
      })
    : null
}

/**
 * connect_account: whether the service behind a server is signed in, and
 * when it is not, the link to PCP's sign-in page for the owner.
 */
export async function connectAccount(
  ctx: VaultContext,
  server: Pick<OpenServer, "id" | "kind" | "name">,
  { publicUrl, call }: { publicUrl: string; call: SigninCall },
): Promise<
  | { signedIn: true; who: string | null; server: Named; said: string }
  | { result: CallToolResult }
> {
  const target = await signinTarget(ctx, server)

  if (!target) {
    throw invalid(
      `${server.name} signs in to no account of its own: only a service whose definition declares a sign-in has one, and its server's tools are where it signs in.`,
    )
  }

  const state = await readSignin(target, call)

  if (!state.signedIn) {
    return { result: signinResult(target.server, publicUrl) }
  }

  return {
    signedIn: true,
    who: state.who,
    server: target.server,
    said: `${target.server.name} is signed in${state.who ? ` as ${state.who}` : ""}: its tools can be used.`,
  }
}

/**
 * check_server's word on a service that signs in: a line to add when it is
 * signed in (or its status cannot be read), or the sign-in link when it is
 * not. While it is not, the check waits a little for the owner, reading
 * its status every few seconds (waitForOwner), as a server being connected
 * does. Null for a server with no sign-in.
 */
export async function signinCheck(
  ctx: VaultContext,
  server: Pick<OpenServer, "id" | "kind">,
  {
    publicUrl,
    call,
    wait,
    state,
  }: {
    publicUrl: string
    call: SigninCall
    /** Holds the check while the owner may still be signing in. */
    wait: (
      ready: () => Promise<SigninState | null>,
    ) => Promise<SigninState | null>
    state?: ServerState
  },
): Promise<{ line: string } | { result: CallToolResult } | null> {
  const target = await signinTarget(ctx, server).catch(() => null)

  if (!target) {
    return null
  }

  let read: SigninState | Error

  try {
    read = await readSignin(target, call)

    if (!read.signedIn) {
      read =
        (await wait(async () => {
          const now = await readSignin(target, call).catch(() => null)
          return now?.signedIn ? now : null
        })) ?? read
    }
  } catch (error) {
    read = error instanceof Error ? error : new Error(String(error))
  }

  if (read instanceof Error) {
    return {
      line: `PCP could not read whether it is signed in: ${read.message}`,
    }
  }

  if (!read.signedIn) {
    return {
      result: signinResult(target.server, publicUrl, {
        lead: "Not signed in yet",
        ...(state ? { state } : {}),
      }),
    }
  }

  return {
    line: `It is signed in to its account${read.who ? ` as ${read.who}` : ""}.`,
  }
}
