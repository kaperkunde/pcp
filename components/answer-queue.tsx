"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react"

import { PermissionOutcome } from "@/components/permission-outcome"
import { StatusDot } from "@/components/ui/badge"
import {
  pendingRequestsAction,
  type PendingRequestsState,
} from "@/lib/actions/permissions"
import {
  NOTHING_ANSWERING,
  repoNoticeId,
  withoutAnswered,
  type Answering,
} from "@/lib/pending-count"
import { cn } from "@/lib/utils"

/**
 * What waits for the owner, shared by every signed-in page: the bell and
 * Home's count read it, and the request pages answer through it.
 *
 * - The count is kept fresh: the layout gives the first one; it is read
 *   again on every navigation, when the bell opens, when the tab comes back
 *   into view, and every little while.
 * - An answer drops it at once and puts it back if the answer fails
 *   (`useAnswer`).
 * - Once answered, the owner is taken to the oldest thing still waiting,
 *   with what came of their answer above it, or told nothing is left. Only
 *   ever a link followed: the next request waits for its own answer.
 */

/** How often the count is read again while the page is in view. */
const REFRESH_MS = 15_000

/** What came of an answer, carried to the page the owner is taken to. */
type Carried = {
  /** The page it is shown on; any other page drops it. */
  href: string
  /** Something else waits there, or nothing is left. */
  next: boolean
  title: string | null
  message: string
  isError: boolean
  /** Remind the owner to tell the assistant (not for a repository's change). */
  tell: boolean
}

type QueueContext = {
  state: PendingRequestsState
  refresh: () => Promise<void>
  /** Takes `key` off the count until the returned function puts it back. */
  hide: (key: AnswerKey) => () => void
  carried: Carried | null
  carry: (carried: Carried | null) => void
}

const Context = createContext<QueueContext | null>(null)

/** What is being answered: a request from an assistant, or a repository's change. */
export type AnswerKey = { request: string } | { repoItem: string }

export function OwnerQueueProvider({
  initial,
  children,
}: {
  initial: PendingRequestsState
  children: ReactNode
}) {
  const [server, setServer] = useState(initial)
  const [answering, setAnswering] = useState<Answering>(NOTHING_ANSWERING)
  const [carried, setCarried] = useState<Carried | null>(null)
  const pathname = usePathname()

  // The layout read again (after an answer, say) has the newest count.
  useEffect(() => {
    setServer(initial)
  }, [initial])

  const refresh = useCallback(async () => {
    try {
      setServer(await pendingRequestsAction())
    } catch {
      // Keep what is shown; the next read tries again.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [pathname, refresh])

  // What an answer carried belongs to the page it was carried to.
  useEffect(() => {
    setCarried((current) =>
      current && current.href !== pathname ? null : current,
    )
  }, [pathname])

  useEffect(() => {
    const visible = () => document.visibilityState === "visible"
    const timer = setInterval(() => {
      if (visible()) void refresh()
    }, REFRESH_MS)
    const onVisible = () => {
      if (visible()) void refresh()
    }

    document.addEventListener("visibilitychange", onVisible)

    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh])

  const hide = useCallback((key: AnswerKey) => {
    const field = "request" in key ? "requests" : "notices"
    const id = "request" in key ? key.request : repoNoticeId(key.repoItem)

    setAnswering((current) => ({
      ...current,
      [field]: [...current[field], id],
    }))

    let shown = true

    return () => {
      if (!shown) {
        return
      }

      shown = false
      setAnswering((current) => {
        const index = current[field].indexOf(id)

        return index < 0
          ? current
          : {
              ...current,
              [field]: current[field].filter((_, at) => at !== index),
            }
      })
    }
  }, [])

  const value = useMemo<QueueContext>(
    () => ({
      state: withoutAnswered(server, answering),
      refresh,
      hide,
      carried,
      carry: setCarried,
    }),
    [server, answering, refresh, hide, carried],
  )

  return <Context.Provider value={value}>{children}</Context.Provider>
}

function useQueue(): QueueContext {
  const queue = useContext(Context)

  if (!queue) {
    throw new Error("OwnerQueueProvider is missing above this component.")
  }

  return queue
}

/** What is waiting for the owner, for the bell and Home's count. */
export function usePendingRequests(): Pick<QueueContext, "state" | "refresh"> {
  const { state, refresh } = useQueue()

  return { state, refresh }
}

/** What an answer came to, as the component that sent it shows it. */
export type Answered = {
  message: string
  isError: boolean
  title?: string | null
  /** The oldest thing still waiting, or null when nothing is. */
  next: string | null
  /** The answered page still needs the owner: stay on it. */
  stay?: boolean
}

/** Said when the answer never came back: it may or may not have arrived. */
const NO_REPLY =
  "PCP did not reply, so your answer may not have arrived. Reload the page to see."

/**
 * One answer to something waiting for the owner, the same for every kind:
 * the count drops as it is sent and comes back with the error if it fails;
 * once it is in, the owner is taken to the next thing waiting (`advance`;
 * not where the page lists them all, as a token's does), with the outcome
 * carried there, or told on this page that nothing is left.
 */
export function useAnswer(
  key: AnswerKey,
  { advance = true, tell = true }: { advance?: boolean; tell?: boolean } = {},
) {
  const queue = useQueue()
  const router = useRouter()
  const pathname = usePathname()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<Answered | null>(null)
  // One answer at a time, whatever is clicked while one is on its way.
  const sending = useRef(false)

  function submit(perform: () => Promise<Answered | { error: string }>) {
    if (sending.current) {
      return
    }

    sending.current = true
    setError(null)
    const restore = queue.hide(key)

    startTransition(async () => {
      let result: Answered | { error: string }

      try {
        result = await perform()
      } catch {
        result = { error: NO_REPLY }
      }

      sending.current = false

      if ("error" in result) {
        restore()
        setError(result.error)
        void queue.refresh()
        return
      }

      setDone(result)
      // Read again, then trust what PCP says rather than the guess.
      void queue.refresh().finally(restore)

      if (!advance) {
        return
      }

      if (result.stay) {
        // This page's own outcome says what is left to do; the one before
        // it is done with.
        queue.carry(null)
        return
      }

      const carried = {
        title: result.title ?? null,
        message: result.message,
        isError: result.isError,
        tell,
      }

      if (result.next) {
        queue.carry({ ...carried, href: result.next, next: true })
        router.push(result.next)
      } else {
        queue.carry({ ...carried, href: pathname, next: false })
      }
    })
  }

  return { submit, pending, error, setError, done }
}

/**
 * Above the request the owner was taken to: what came of the one they
 * answered before it. `alone` on a page that shows nothing of its own once
 * answered (a repository's change), so the outcome and the all-clear stay
 * in view there.
 */
export function AnsweredBefore({
  alone = false,
  className,
}: {
  alone?: boolean
  className?: string
}) {
  const { carried } = useQueue()
  const pathname = usePathname()

  if (!carried || carried.href !== pathname || (!carried.next && !alone)) {
    return null
  }

  return (
    <section
      aria-label="Your last answer"
      className={cn("flex flex-col gap-2", className)}
    >
      <PermissionOutcome
        status={carried.title ? `You answered: ${carried.title}` : null}
        tone={carried.isError ? "error" : "ok"}
        outcome={carried.message}
        outcomeIsError={carried.isError}
        tell={carried.tell}
      />
      {carried.next ? (
        <p className="px-1 text-[13px] text-muted-foreground">
          Next, the oldest still waiting for you.
        </p>
      ) : (
        <AllClear />
      )}
    </section>
  )
}

/**
 * Under the request the owner just answered, when nothing else waits: the
 * queue is done.
 */
export function AllClearAfter({ className }: { className?: string }) {
  const { carried } = useQueue()
  const pathname = usePathname()

  if (!carried || carried.next || carried.href !== pathname) {
    return null
  }

  return <AllClear className={className} />
}

function AllClear({ className }: { className?: string }) {
  return (
    <p
      role="status"
      className={cn("flex flex-wrap items-center gap-x-2.5 px-1", className)}
    >
      <StatusDot tone="ok" />
      <span className="font-medium">Nothing else is waiting for you.</span>
      <Link href="/home" className="text-primary">
        Back to Home
      </Link>
    </p>
  )
}
