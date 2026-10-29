import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Work a call hands on to run once its answer has gone, inside the same
 * request: the gateway's route (/mcp) and the owner's answer to a request
 * open a scope around what they run, and run what was handed on through
 * Next's after(), once the response is sent. The work keeps what the
 * request brought (a login PCP decrypted for the call) only until it ends:
 * nothing is stored, queued or timed past the request, and work handed on
 * with no scope open, or after the scope has run, is refused, so the
 * caller does it in the call instead.
 *
 * IMAP's look for the copy in Sent (mail/imap.ts) is the one user: it
 * waits seconds for the mail server, which the answer should not.
 */

type Scope = { tasks: Array<() => Promise<void>>; done: boolean }

const current = new AsyncLocalStorage<Scope>()

export type AfterAnswerScope = {
  /** Runs `work` with the scope open: what it hands on waits for drain. */
  run<T>(work: () => Promise<T>): Promise<T>
  /**
   * Runs what was handed on, and what that hands on in turn, then closes
   * the scope. Never throws: each task's failure is its own.
   */
  drain(): Promise<void>
}

export function afterAnswerScope(): AfterAnswerScope {
  const scope: Scope = { tasks: [], done: false }

  return {
    run: (work) => current.run(scope, work),
    async drain() {
      while (scope.tasks.length > 0) {
        const batch = scope.tasks.splice(0)
        await Promise.allSettled(batch.map((task) => current.run(scope, task)))
      }

      scope.done = true
    },
  }
}

/**
 * Hands `task` on to run once the answer has gone. False when nothing will
 * run it (no scope, or its work has run): the caller then does it itself.
 */
export function afterAnswer(task: () => Promise<void>): boolean {
  const scope = current.getStore()

  if (!scope || scope.done) {
    return false
  }

  scope.tasks.push(task)
  return true
}
