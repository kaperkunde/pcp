import type { ImapClientLike } from "./imap"
import {
  IMAP_IDLE_MS,
  IMAP_LEASE_WAIT_MS,
  IMAP_MAX_AGE_MS,
  IMAP_MAX_CONNECTIONS,
  IMAP_REVALIDATE_AFTER_MS,
  IMAP_REVALIDATE_TIMEOUT_MS,
  MAIL_LOGOUT_TIMEOUT_MS,
} from "./limits"
import { MailTransportError } from "./types"

/**
 * The IMAP session pool: one signed-in connection per mail account, kept
 * for the calls that follow, so a call costs a command, not a TCP and TLS
 * connect, a login and a logout. After the SSH pool (ssh/client.ts):
 *
 * - A connection is opened only by a call that hands in the way to open one
 *   (the login came with that request), never in the background, and never
 *   reopened by a timer. A timer only closes an idle one.
 * - Bounded: at most `maxConnections` per account, an idle limit, a
 *   maximum age. Callers queue for a connection within the time the call
 *   has, and share it one at a time.
 * - A connection the server closed, one a command broke, one idle too
 *   long and one that does not answer a NOOP are dropped and a call opens
 *   another. A connection comes back to the pool only whole.
 * - Keyed by the account and a fingerprint of everything that would make it
 *   another connection (address, user name, password): a change starts over
 *   and closes what was open.
 *
 * Kept on globalThis, since the gateway and the Server Actions are bundled
 * apart and would otherwise each hold a pool of their own.
 */

export type SessionKey = {
  /** The mail account: the server's id. */
  account: string
  /** Hash of the address and login the connection was made with. */
  fingerprint: string
}

export type LeaseOptions = {
  maxConnections?: number
  idleMs?: number
  maxAgeMs?: number
  revalidateAfterMs?: number
  /** How long to wait for a connection others are using. */
  waitMs?: number
  now?: () => number
}

export type Lease = {
  client: ImapClientLike
  /** The connection was opened by an earlier call. */
  reused: boolean
  /** Hands it back; `broken` closes it instead. */
  release(options?: { broken?: boolean }): void
}

type Entry = {
  client: ImapClientLike
  openedAt: number
  lastUsedAt: number
  busy: boolean
  closed: boolean
  timer: NodeJS.Timeout | null
}

type Listing = { at: number; value: unknown }

type Account = {
  fingerprint: string
  retired: boolean
  entries: Set<Entry>
  /** Connections being opened, which count against the limit. */
  opening: number
  waiters: Array<() => void>
  listing: Listing | null
}

const POOL = Symbol.for("pcp.mail.imap-sessions")

function accounts(): Map<string, Account> {
  const holder = globalThis as unknown as { [POOL]?: Map<string, Account> }
  holder[POOL] ??= new Map()
  return holder[POOL]
}

function wakeAll(account: Account): void {
  for (const wake of account.waiters.splice(0)) {
    wake()
  }
}

/**
 * Closes a connection: a LOGOUT for a moment, then the socket if the
 * server has not let go. Never waits longer than `ms`.
 */
export async function closeBounded(
  client: ImapClientLike,
  ms: number = MAIL_LOGOUT_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  let loggedOut = false

  try {
    await Promise.race([
      client.logout().then(() => {
        loggedOut = true
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms)
      }),
    ])
  } catch {
    // Closed below.
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (!loggedOut) {
    try {
      client.close()
    } catch {
      // Already gone.
    }
  }
}

function dropEntry(account: Account, entry: Entry): Promise<void> {
  if (entry.closed) {
    return Promise.resolve()
  }

  entry.closed = true

  if (entry.timer) clearTimeout(entry.timer)

  entry.timer = null
  account.entries.delete(entry)
  wakeAll(account)

  return closeBounded(entry.client)
}

function accountFor(key: SessionKey): Account {
  const map = accounts()
  const found = map.get(key.account)

  if (found && found.fingerprint === key.fingerprint) {
    return found
  }

  if (found) {
    retire(found)
  }

  const fresh: Account = {
    fingerprint: key.fingerprint,
    retired: false,
    entries: new Set(),
    opening: 0,
    waiters: [],
    listing: null,
  }
  map.set(key.account, fresh)

  return fresh
}

/** An account whose login or address changed: nothing of it is reused. */
function retire(account: Account): Promise<void[]> {
  account.retired = true
  account.listing = null
  wakeAll(account)

  return Promise.all(
    [...account.entries]
      // One in a call's hands closes when the call lets go of it.
      .filter((entry) => !entry.busy)
      .map((entry) => dropEntry(account, entry)),
  )
}

function expired(entry: Entry, now: number, idleMs: number, maxAgeMs: number) {
  return (
    entry.client.usable === false ||
    now - entry.lastUsedAt > idleMs ||
    now - entry.openedAt > maxAgeMs
  )
}

async function stillAnswers(client: ImapClientLike): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race([
      client.noop().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), IMAP_REVALIDATE_TIMEOUT_MS)
      }),
    ])
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * A connection for one call: an idle one of the account's, or a new one
 * made by `open` while the account has room, or else a place in the queue
 * (the wait ends, with an error, after `waitMs`).
 */
export async function leaseImap(
  key: SessionKey,
  open: () => Promise<ImapClientLike>,
  options: LeaseOptions = {},
): Promise<Lease> {
  const {
    maxConnections = IMAP_MAX_CONNECTIONS,
    idleMs = IMAP_IDLE_MS,
    maxAgeMs = IMAP_MAX_AGE_MS,
    revalidateAfterMs = IMAP_REVALIDATE_AFTER_MS,
    waitMs = IMAP_LEASE_WAIT_MS,
    now = Date.now,
  } = options
  const account = accountFor(key)
  const gaveUpAt = Date.now() + waitMs

  for (;;) {
    for (const entry of [...account.entries]) {
      if (!entry.busy && expired(entry, now(), idleMs, maxAgeMs)) {
        void dropEntry(account, entry)
      }
    }

    const idle = [...account.entries]
      .filter((entry) => !entry.busy)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]

    if (idle) {
      idle.busy = true

      if (idle.timer) clearTimeout(idle.timer)

      idle.timer = null

      // One that sat a while may have been cut off without a word.
      if (
        now() - idle.lastUsedAt > revalidateAfterMs &&
        !(await stillAnswers(idle.client))
      ) {
        void dropEntry(account, idle)
        continue
      }

      return lease(account, idle, true, { idleMs, maxAgeMs, now })
    }

    if (account.entries.size + account.opening < maxConnections) {
      account.opening++
      let client: ImapClientLike

      try {
        client = await open()
      } finally {
        account.opening--
        wakeAll(account)
      }

      const entry: Entry = {
        client,
        openedAt: now(),
        lastUsedAt: now(),
        busy: true,
        closed: false,
        timer: null,
      }

      // An account that changed while this opened still gets it, for this
      // one call: release closes it.
      account.entries.add(entry)

      return lease(account, entry, false, { idleMs, maxAgeMs, now })
    }

    const remaining = gaveUpAt - Date.now()

    if (remaining <= 0) {
      throw new MailTransportError(
        "This mail account is busy with other calls; try again in a moment.",
      )
    }

    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const at = account.waiters.indexOf(wake)

        if (at >= 0) account.waiters.splice(at, 1)

        resolve()
      }, remaining)

      account.waiters.push(wake)
    })
  }
}

function lease(
  account: Account,
  entry: Entry,
  reused: boolean,
  {
    idleMs,
    maxAgeMs,
    now,
  }: Required<Pick<LeaseOptions, "idleMs" | "maxAgeMs" | "now">>,
): Lease {
  let released = false

  return {
    client: entry.client,
    reused,
    release(options = {}) {
      if (released) {
        return
      }

      released = true
      entry.lastUsedAt = now()

      if (
        options.broken ||
        account.retired ||
        expired(entry, now(), Infinity, maxAgeMs)
      ) {
        void dropEntry(account, entry)
        return
      }

      entry.busy = false
      // Only closes the connection if nobody comes for it.
      entry.timer = setTimeout(() => void dropEntry(account, entry), idleMs)
      entry.timer.unref?.()
      wakeAll(account)
    },
  }
}

/** The mailbox listing an account's calls share, while it is fresh. */
export function readListing<T>(
  key: SessionKey,
  ttlMs: number,
  now: number = Date.now(),
): T | null {
  const found = accountFor(key).listing

  return found && now - found.at <= ttlMs ? (found.value as T) : null
}

export function writeListing(
  key: SessionKey,
  value: unknown,
  now: number = Date.now(),
): void {
  accountFor(key).listing = { at: now, value }
}

export function forgetListing(key: SessionKey): void {
  accountFor(key).listing = null
}

/** Closes every connection of one account, and forgets what it shared. */
export async function dropMailSession(account: string): Promise<void> {
  const found = accounts().get(account)

  if (found) {
    accounts().delete(account)
    await retire(found)
  }
}

/** Closes every session, as when PCP stops. */
export async function closeMailSessions(): Promise<void> {
  const all = [...accounts().entries()]

  accounts().clear()
  await Promise.all(all.map(([, account]) => retire(account)))
}

/** How many connections are open, for tests and the server page. */
export function mailSessionCount(): number {
  return [...accounts().values()].reduce(
    (sum, account) => sum + account.entries.size,
    0,
  )
}
