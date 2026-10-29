"use client"

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react"

/**
 * The servers of the definition the page's server is an instance of, by
 * short name, this one among them: set by the server page, read by the
 * forms that change what they share (the description, an endpoint's schema
 * and edits, a wrapper's programs, tool descriptions), so the owner is told
 * before a change reaches the others. Empty, or one name, when nothing is
 * shared.
 */
const SharedInstances = createContext<string[]>([])

export function SharedInstancesProvider({
  instances,
  children,
}: {
  instances: string[]
  children: ReactNode
}) {
  return (
    <SharedInstances.Provider value={instances}>
      {children}
    </SharedInstances.Provider>
  )
}

export function useSharedInstances(): string[] {
  return useContext(SharedInstances)
}

/** "This changes 2 servers: gaaf, plekde" */
export function changesServers(instances: string[]): string {
  return `This changes ${instances.length} servers: ${instances.join(", ")}`
}

/** The fields of a server's forms that its definition holds. */
const SHARED_FIELDS = [
  "description",
  "specSource",
  "specUrl",
  "specFile",
  "patches",
  "definition",
  "callLevels",
]

function valueOf(data: FormData, name: string): string {
  return data
    .getAll(name)
    .map((value) =>
      typeof value === "string" ? value : value.size > 0 ? value.name : "",
    )
    .join("\n")
}

/** What the shared fields of a form say now, to tell a change from. */
export function sharedSnapshot(form: HTMLFormElement): Record<string, string> {
  const data = new FormData(form)
  return Object.fromEntries(
    SHARED_FIELDS.map((name) => [name, valueOf(data, name)]),
  )
}

/**
 * Asks before a form changes what other servers share: true to go on. A
 * form that changes none of it, or a server that shares nothing, goes on
 * without asking.
 */
export function confirmSharedChange(
  form: HTMLFormElement,
  before: Record<string, string> | null,
  instances: string[],
): boolean {
  if (instances.length < 2 || !before) {
    return true
  }

  const now = sharedSnapshot(form)
  const changed = SHARED_FIELDS.some((name) => now[name] !== before[name])

  return (
    !changed ||
    window.confirm(
      `${changesServers(instances)}. Save it for all of them? To change this server alone, cancel and choose Detach under About first.`,
    )
  )
}

/**
 * For a form that edits a server: a ref for the form and its onSubmit,
 * which asks before a change to what other servers share is saved. What the
 * shared fields say is taken when the form appears.
 */
export function useSharedChangeGuard(active: boolean) {
  const instances = useSharedInstances()
  const ref = useRef<HTMLFormElement>(null)
  const before = useRef<Record<string, string> | null>(null)

  useEffect(() => {
    if (active && ref.current) {
      before.current = sharedSnapshot(ref.current)
    }
  }, [active])

  return {
    ref,
    onSubmit(event: FormEvent<HTMLFormElement>) {
      if (
        active &&
        !confirmSharedChange(event.currentTarget, before.current, instances)
      ) {
        event.preventDefault()
      }
    },
  }
}

/** The line a shared server's settings start with. */
export function SharedDefinitionNote({
  instances,
  kind,
}: {
  instances: string[]
  kind: string
}) {
  if (instances.length < 2) {
    return null
  }

  const shared =
    kind === "openapi"
      ? "the description, schema, edits and tool descriptions"
      : kind === "wrapper"
        ? "the description, programs and tool descriptions"
        : "the description and tool descriptions"

  return (
    <p className="rounded-lg bg-field px-3 py-2.5 text-[13px] leading-relaxed text-warning">
      {changesServers(instances)} when you change {shared}: they share them.
      Detach this server under About to change it alone.
    </p>
  )
}
