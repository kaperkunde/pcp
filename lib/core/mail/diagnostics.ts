import {
  DIAGNOSTIC_ACCOUNTS,
  DIAGNOSTIC_CALLS_PER_ACCOUNT,
  DIAGNOSTIC_NOTICE_CHARS,
  DIAGNOSTIC_NOTICES_PER_CALL,
} from "./limits"

/**
 * How an account's last calls went, for the owner's server page: the time
 * each phase of a call took, and the words the server put on its own
 * ([ALERT], [THROTTLED], BYE). Kept in memory only (a small ring per
 * account, a bounded number of accounts), gone when PCP restarts, never
 * written to disk, never in the request log. The texts are the server's,
 * scrubbed of the login, addresses and links, and cut short.
 */

export type MailPhase = "connect" | "login" | "select" | "command" | "logout"

export type MailCallOutcome = "ok" | "error" | "throttled"

export type MailDiagnostic = {
  /** When the call finished, ISO 8601. */
  at: string
  tool?: string
  /** Milliseconds per phase; a phase the call did not have is absent. */
  phases: Partial<Record<MailPhase, number>>
  /** What the server said on its own, scrubbed, newest last. */
  notices: string[]
  /** Whether the call used a connection an earlier call opened. */
  reused: boolean
  outcome: MailCallOutcome
}

export type MailCallRecord = Omit<MailDiagnostic, "at">

const STORE = Symbol.for("pcp.mail.diagnostics")

function store(): Map<string, MailDiagnostic[]> {
  const holder = globalThis as unknown as {
    [STORE]?: Map<string, MailDiagnostic[]>
  }
  holder[STORE] ??= new Map()
  return holder[STORE]
}

export function recordMailCall(serverId: string, call: MailCallRecord): void {
  const rows = store()
  const kept = rows.get(serverId) ?? []

  // Re-inserted last, so the accounts dropped first are the longest unused.
  rows.delete(serverId)
  kept.push({
    ...call,
    at: new Date().toISOString(),
    notices: call.notices.slice(-DIAGNOSTIC_NOTICES_PER_CALL),
  })
  rows.set(serverId, kept.slice(-DIAGNOSTIC_CALLS_PER_ACCOUNT))

  while (rows.size > DIAGNOSTIC_ACCOUNTS) {
    rows.delete(rows.keys().next().value!)
  }
}

/** An account's recent calls, newest first. */
export function mailDiagnostics(serverId: string): MailDiagnostic[] {
  return [...(store().get(serverId) ?? [])].reverse()
}

export function clearMailDiagnostics(serverId?: string): void {
  if (serverId === undefined) {
    store().clear()
  } else {
    store().delete(serverId)
  }
}

const EMAIL = /[^\s<>"']+@[^\s<>"']+/g
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g
const IPV6 = /\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}\b/gi
const HOST = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi

/**
 * A line the server sent, safe to keep and show: the credentials PCP
 * signed in with, addresses, hosts and links taken out, control
 * characters gone, and cut to a short length.
 */
export function scrubNotice(text: string, secrets: string[] = []): string {
  let scrubbed = text

  for (const secret of secrets) {
    if (secret.length >= 3) {
      scrubbed = scrubbed.split(secret).join("[hidden]")
    }
  }

  return scrubbed
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(URL_LIKE, "[link]")
    .replace(EMAIL, "[address]")
    .replace(IPV4, "[address]")
    .replace(IPV6, "[address]")
    .replace(HOST, "[address]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DIAGNOSTIC_NOTICE_CHARS)
}

/** One call's timings and notices, collected as it runs. */
export class CallTrace {
  readonly phases: Partial<Record<MailPhase, number>> = {}
  readonly notices: string[] = []
  reused = false
  private done = false

  constructor(
    readonly serverId: string,
    readonly tool: string,
  ) {}

  add(phase: MailPhase, ms: number): void {
    this.phases[phase] = (this.phases[phase] ?? 0) + Math.max(0, Math.round(ms))
  }

  async time<T>(phase: MailPhase, run: () => Promise<T>): Promise<T> {
    const started = Date.now()

    try {
      return await run()
    } finally {
      this.add(phase, Date.now() - started)
    }
  }

  notice(text: string): void {
    if (text && this.notices.length < DIAGNOSTIC_NOTICES_PER_CALL) {
      this.notices.push(text)
    }
  }

  finish(outcome: MailCallOutcome): void {
    if (this.done) {
      return
    }

    this.done = true
    recordMailCall(this.serverId, {
      tool: this.tool,
      phases: this.phases,
      notices: this.notices,
      reused: this.reused,
      outcome,
    })
  }
}

/**
 * Where a connection reports to while it is in a call's hands: the
 * connection (imap.ts defaultImapDeps.connect) fills `phases` while it
 * opens and keeps `notices` the server sends, and the call that holds it
 * collects both into its trace.
 */
export type TraceSink = {
  trace: CallTrace | null
  /** Connect and login times of the connection's opening, until collected. */
  opening: Partial<Record<MailPhase, number>> | null
  /** Notices that came between calls, scrubbed, until collected. */
  pending: string[]
}

const SINKS = new WeakMap<object, TraceSink>()

export function createTraceSink(client: object): TraceSink {
  const sink: TraceSink = { trace: null, opening: null, pending: [] }
  SINKS.set(client, sink)
  return sink
}

/** Hands a connection's reports to a call's trace; null lets go of it. */
export function bindTrace(client: object, trace: CallTrace | null): void {
  const sink = SINKS.get(client)

  if (!sink) {
    return
  }

  sink.trace = trace

  if (!trace) {
    return
  }

  for (const [phase, ms] of Object.entries(sink.opening ?? {})) {
    trace.add(phase as MailPhase, ms)
  }

  sink.opening = null

  for (const text of sink.pending.splice(0)) {
    trace.notice(text)
  }
}
