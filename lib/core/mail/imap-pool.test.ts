import { afterEach, describe, expect, it } from "vitest"

import type { ImapClientLike } from "./imap"
import {
  closeMailSessions,
  leaseImap,
  mailSessionCount,
  type SessionKey,
} from "./imap-pool"
import { MailTransportError } from "./types"

// The pooled IMAP session: one signed-in connection per mail account,
// reused by the calls that follow, opened only by a call that hands in the
// login, and dropped when it is old, broken or the account changed.

type Fake = ImapClientLike & { closed: boolean; noops: number }

function client(): Fake {
  const state = { closed: false, noops: 0 }

  return Object.assign(state, {
    secureConnection: true,
    usable: true,
    mailbox: false as const,
    capabilities: new Map(),
    async logout() {
      state.closed = true
    },
    close() {
      state.closed = true
    },
    async noop() {
      state.noops++
    },
  }) as unknown as Fake
}

const KEY: SessionKey = { account: "server-1", fingerprint: "a" }

function opener() {
  const opened: Fake[] = []
  return {
    opened,
    open: async () => {
      const made = client()
      opened.push(made)
      return made
    },
  }
}

afterEach(async () => {
  await closeMailSessions()
})

describe("the IMAP session pool", () => {
  it("hands the same signed-in connection to the next call", async () => {
    const { open, opened } = opener()

    const first = await leaseImap(KEY, open, { maxConnections: 1 })
    first.release()
    const second = await leaseImap(KEY, open, { maxConnections: 1 })

    expect(second.client).toBe(first.client)
    expect(second.reused).toBe(true)
    expect(opened).toHaveLength(1)
    second.release()
    expect(mailSessionCount()).toBe(1)
  })

  it("queues callers for a connection instead of logging in again", async () => {
    const { open, opened } = opener()
    const order: number[] = []

    await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        const lease = await leaseImap(KEY, open, { maxConnections: 1 })
        order.push(n)
        await new Promise((resolve) => setTimeout(resolve, 2))
        lease.release()
      }),
    )

    expect(opened).toHaveLength(1)
    expect(order).toEqual([1, 2, 3, 4, 5])
  })

  it("opens no more than the connections an account may have", async () => {
    const { open, opened } = opener()
    const held = await Promise.all([
      leaseImap(KEY, open, { maxConnections: 2 }),
      leaseImap(KEY, open, { maxConnections: 2 }),
    ])
    const third = leaseImap(KEY, open, { maxConnections: 2, waitMs: 1_000 })

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(opened).toHaveLength(2)
    held[0]!.release()
    expect((await third).client).toBe(held[0]!.client)
    expect(opened).toHaveLength(2)
  })

  it("gives up waiting within the time the call has", async () => {
    const { open } = opener()
    await leaseImap(KEY, open, { maxConnections: 1 })

    await expect(
      leaseImap(KEY, open, { maxConnections: 1, waitMs: 20 }),
    ).rejects.toBeInstanceOf(MailTransportError)
  })

  it("drops a broken connection and opens a new one", async () => {
    const { open, opened } = opener()
    const first = await leaseImap(KEY, open, { maxConnections: 1 })

    first.release({ broken: true })
    expect(opened[0]!.closed).toBe(true)

    const second = await leaseImap(KEY, open, { maxConnections: 1 })
    expect(second.client).not.toBe(first.client)
    expect(opened).toHaveLength(2)
  })

  it("drops one the server has closed, found before it is handed out", async () => {
    const { open, opened } = opener()
    const first = await leaseImap(KEY, open, { maxConnections: 1 })
    first.release()
    ;(opened[0] as unknown as { usable: boolean }).usable = false

    const second = await leaseImap(KEY, open, { maxConnections: 1 })
    expect(second.client).toBe(opened[1])
    expect(opened).toHaveLength(2)
  })

  it("drops one idle too long, and one that lived too long", async () => {
    const { open, opened } = opener()
    let now = 1_000
    const options = {
      maxConnections: 1,
      idleMs: 10_000,
      maxAgeMs: 60_000,
      now: () => now,
    }
    const first = await leaseImap(KEY, open, options)
    first.release()

    now += 5_000
    const again = await leaseImap(KEY, open, options)
    expect(again.client).toBe(first.client)
    again.release()

    now += 11_000
    const afterIdle = await leaseImap(KEY, open, options)
    expect(afterIdle.client).not.toBe(first.client)
    expect(opened[0]!.closed).toBe(true)
    afterIdle.release()

    // Used often, but never past its age.
    for (let i = 0; i < 8; i++) {
      now += 9_000
      const lease = await leaseImap(KEY, open, options)
      lease.release()
    }

    expect(opened.length).toBeGreaterThanOrEqual(3)
    expect(opened[1]!.closed).toBe(true)
  })

  it("checks a connection that sat a while before it trusts it", async () => {
    const { open, opened } = opener()
    let now = 0
    const options = {
      maxConnections: 1,
      revalidateAfterMs: 30_000,
      now: () => now,
    }
    const first = await leaseImap(KEY, open, options)
    first.release()

    now = 10_000
    ;(await leaseImap(KEY, open, options)).release()
    expect(opened[0]!.noops).toBe(0)

    now = 100_000
    opened[0]!.noop = async () => {
      throw new Error("stale")
    }
    const third = await leaseImap(KEY, open, options)
    expect(third.client).toBe(opened[1])
    expect(opened[0]!.closed).toBe(true)
  })

  it("starts over when the login or the server behind the account changed", async () => {
    const { open, opened } = opener()
    const first = await leaseImap(KEY, open, { maxConnections: 1 })
    first.release()

    const changed = await leaseImap({ ...KEY, fingerprint: "b" }, open, {
      maxConnections: 1,
    })
    expect(changed.client).not.toBe(first.client)
    expect(opened[0]!.closed).toBe(true)
    expect(opened).toHaveLength(2)
  })

  it("closes a connection that comes back after the account changed", async () => {
    const { open, opened } = opener()
    const old = await leaseImap(KEY, open, { maxConnections: 1 })
    ;(
      await leaseImap({ ...KEY, fingerprint: "b" }, open, { maxConnections: 2 })
    ).release()

    old.release()
    expect(opened[0]!.closed).toBe(true)
  })

  it("keeps accounts apart", async () => {
    const { open, opened } = opener()
    const a = await leaseImap(KEY, open, { maxConnections: 1 })
    const b = await leaseImap({ ...KEY, account: "server-2" }, open, {
      maxConnections: 1,
    })

    expect(a.client).not.toBe(b.client)
    expect(opened).toHaveLength(2)
  })

  it("opens nothing in the background: a failed open frees its place", async () => {
    let tries = 0
    const open = async () => {
      tries++
      if (tries === 1) throw new Error("refused")
      return client()
    }

    await expect(leaseImap(KEY, open, { maxConnections: 1 })).rejects.toThrow(
      "refused",
    )
    const lease = await leaseImap(KEY, open, { maxConnections: 1 })
    expect(lease.reused).toBe(false)
    expect(tries).toBe(2)
  })

  it("closes every session when asked", async () => {
    const { open, opened } = opener()
    ;(await leaseImap(KEY, open, { maxConnections: 1 })).release()

    await closeMailSessions()
    expect(opened[0]!.closed).toBe(true)
    expect(mailSessionCount()).toBe(0)
  })
})
