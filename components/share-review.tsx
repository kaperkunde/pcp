"use client"

import { useActionState, useEffect, useId, useState } from "react"

import { FormError } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Checkbox, Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  confirmShareAction,
  shareFixAction,
  type RepoActionResult,
} from "@/lib/actions/repos"
import type { ShareFix } from "@/lib/core/repos/share-review"

/**
 * The parts of a push's review that act (app/(dashboard)/settings/
 * repositories/[id]/share): each thing that looks personal, with what fixes
 * it here and its "fine to publish" tick, and Confirm, which pushes exactly
 * what the page shows. lib/core/repos/share-review.ts does the work.
 */

const IDLE: RepoActionResult = { status: "idle" }

/** The confirm form's id: the ticks beside each hit belong to it. */
const CONFIRM_FORM = "share-confirm"

export type HitView = {
  id: string
  label: string
  match: string
  fixes: ShareFix[]
  /** Each place it is: a link to the line, and where that is. */
  places: Array<{ href: string; text: string }>
}

type Target = {
  repoId: string
  /** "kind:id", the item under review first, then the ones waiting. */
  items: string[]
  /** An assistant's proposal this review answers (a repo_share request). */
  request?: string | null
}

function Hidden({ target }: { target: Target }) {
  return (
    <>
      <input type="hidden" name="repoId" value={target.repoId} />
      {target.items.map((item) => (
        <input key={item} type="hidden" name="item" value={item} />
      ))}
      {target.request ? (
        <input type="hidden" name="request" value={target.request} />
      ) : null}
    </>
  )
}

/** One fix, as its own small form: the review opens again once it is made. */
function FixForm({
  target,
  fix,
  children,
  label,
}: {
  target: Target
  fix: ShareFix
  children?: React.ReactNode
  label: string
}) {
  const [state, action] = useActionState<RepoActionResult, FormData>(
    shareFixAction,
    IDLE,
  )

  return (
    <form action={action} className="flex flex-col gap-2">
      <Hidden target={target} />
      <input type="hidden" name="fix" value={fix} />
      {children}
      <div>
        <SubmitButton variant="secondary" size="sm" pendingText="Saving…">
          {label}
        </SubmitButton>
      </div>
      <FormError error={state.status === "error" ? state.error : null} />
    </form>
  )
}

function Fixes({
  hit,
  target,
  item,
}: {
  hit: HitView
  target: Target
  item: { description: string; displayName: string; name: string }
}) {
  const id = useId()

  if (hit.fixes.length === 0) {
    return null
  }

  return (
    <div className="flex flex-col gap-3 border-t border-separator pt-3">
      {hit.fixes.includes("move_to_note") ? (
        <FixForm target={target} fix="move_to_note" label="Move to my note">
          <input type="hidden" name="match" value={hit.match} />
          <p className="text-xs text-muted-foreground">
            The sentence of the description that holds it goes to your note:
            private, never synced or shared.
          </p>
        </FixForm>
      ) : null}
      {hit.fixes.includes("instance_address") ? (
        <FixForm
          target={target}
          fix="instance_address"
          label="Keep the address to this server"
        >
          <p className="text-xs text-muted-foreground">
            Leaves <code>servers</code> out of the shared OpenAPI document. The
            address stays this server&apos;s own base URL, where its requests
            go; whoever adds the endpoint gives theirs.
          </p>
        </FixForm>
      ) : null}
      {hit.fixes.includes("edit_description") ? (
        <details className="group">
          <summary className="cursor-pointer text-sm text-primary">
            Edit the description
          </summary>
          <div className="pt-2">
            <FixForm
              target={target}
              fix="edit_description"
              label="Save the description"
            >
              <Field label="Description" htmlFor={`${id}-description`}>
                <Textarea
                  id={`${id}-description`}
                  name="description"
                  defaultValue={item.description}
                  rows={4}
                />
              </Field>
            </FixForm>
          </div>
        </details>
      ) : null}
      {hit.fixes.includes("rename") ? (
        <details className="group">
          <summary className="cursor-pointer text-sm text-primary">
            Rename what is shared
          </summary>
          <div className="pt-2">
            <FixForm target={target} fix="rename" label="Rename">
              <Field
                label="Name"
                htmlFor={`${id}-name`}
                hint="What it is called in the repository. Your servers keep their own names."
              >
                <Input
                  id={`${id}-name`}
                  name="name"
                  defaultValue={item.displayName}
                  autoComplete="off"
                />
              </Field>
              <Field
                label="Short name"
                htmlFor={`${id}-slug`}
                hint="Its folder or file in the repository."
              >
                <Input
                  id={`${id}-slug`}
                  name="slug"
                  defaultValue={item.name}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                />
              </Field>
            </FixForm>
          </div>
        </details>
      ) : null}
    </div>
  )
}

/**
 * What looks personal in the files, each with where it is, what fixes it
 * here, and its tick. For a public repository every hit is ticked or fixed
 * before Confirm; for a private one they are advice, and the ticks are not
 * needed.
 */
export function ShareHits({
  hits,
  publicRepo,
  target,
  item,
  pageHref,
}: {
  hits: HitView[]
  publicRepo: boolean
  target: Target
  item: { description: string; displayName: string; name: string }
  pageHref: string
}) {
  if (hits.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="share-hits">
        PCP found nothing in these files that looks personal: no email address,
        address of yours, IP, ID, phone number, home folder or token.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-3" data-testid="share-hits">
      {hits.map((hit) => (
        <li
          key={hit.id}
          className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-warning/30"
          data-testid="share-hit"
        >
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="warning">{hit.label}</Badge>
                <code className="break-all text-[13px]">{hit.match}</code>
              </span>
              <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                {hit.places.map((place) => (
                  <a
                    key={place.href}
                    href={place.href}
                    className="text-primary hover:underline"
                  >
                    {place.text}
                  </a>
                ))}
                <a href={pageHref} className="hover:underline">
                  Edit on its page
                </a>
              </span>
            </div>
            <label className="flex min-h-9 items-center gap-2 text-sm">
              <Checkbox
                name="acknowledged"
                value={hit.id}
                form={CONFIRM_FORM}
                aria-label={`${hit.match} is fine to publish`}
              />
              Fine to publish
            </label>
          </div>
          <Fixes hit={hit} target={target} item={item} />
        </li>
      ))}
      {!publicRepo ? (
        <li className="text-xs text-muted-foreground">
          The repository is private, so these are advice: you can push without
          ticking them.
        </li>
      ) : null}
    </ul>
  )
}

/** Confirm: pushes what the page shows, exactly; never more than that. */
export function ShareConfirm({
  target,
  basis,
  hitCount,
  publicRepo,
  label,
}: {
  target: Target
  basis: string
  hitCount: number
  publicRepo: boolean
  label: string
}) {
  const [state, action] = useActionState<RepoActionResult, FormData>(
    confirmShareAction,
    IDLE,
  )
  const [ticked, setTicked] = useState(0)

  // The ticks sit beside each hit, outside this form, and belong to it by
  // the form attribute: count them as they change.
  useEffect(() => {
    const count = () =>
      setTicked(
        document.querySelectorAll(
          `input[form="${CONFIRM_FORM}"][name="acknowledged"]:checked`,
        ).length,
      )
    count()
    document.addEventListener("change", count)
    return () => document.removeEventListener("change", count)
  }, [])

  const waiting = publicRepo ? hitCount - ticked : 0

  return (
    <form
      id={CONFIRM_FORM}
      action={action}
      className="flex flex-col items-stretch gap-2 sm:items-end"
    >
      <Hidden target={target} />
      <input type="hidden" name="basis" value={basis} />
      <SubmitButton size="lg" pendingText="Pushing…" disabled={waiting > 0}>
        {label}
      </SubmitButton>
      <p className="text-xs text-muted-foreground" role="status">
        {waiting > 0
          ? `${waiting === 1 ? "One thing still looks" : `${waiting} things still look`} personal: fix ${waiting === 1 ? "it" : "each"}, or tick it as fine to publish.`
          : "One commit, exactly what this page shows. If anything changed since it opened, nothing is pushed and the review opens again."}
      </p>
      <FormError error={state.status === "error" ? state.error : null} />
    </form>
  )
}
