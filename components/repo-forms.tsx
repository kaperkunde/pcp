"use client"

import { Plus, TriangleAlert } from "lucide-react"
import { useRouter } from "next/navigation"
import { useActionState, useEffect, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { ChoiceField } from "@/components/server-form-parts"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Checkbox, Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  addItemsAction,
  answerChangeAction,
  createRepoAction,
  deleteRepoAction,
  pollGitHubSignInAction,
  pushItemsAction,
  setItemSyncAction,
  startGitHubSignInAction,
  syncItemAction,
  syncRepoAction,
  unlinkItemAction,
  updateRepoAction,
  type RepoActionResult,
  type SignInResult,
} from "@/lib/actions/repos"

/**
 * Settings → Repositories, the parts that act: linking a repository, its
 * settings, signing in to GitHub, how each linked item syncs, adding items
 * from a repository and pushing the owner's, and the answers to what sync
 * left for them. lib/actions/repos.ts does the work.
 */

const IDLE: RepoActionResult = { status: "idle" }

type SecretOption = { id: string; name: string }

type SignInChoice = "none" | "token" | "github"

type Access = "read" | "write"
type Trust = "untrusted" | "trusted"

function ResultLines({ state }: { state: RepoActionResult }) {
  if (state.status !== "ok") {
    return <FormError error={state.status === "error" ? state.error : null} />
  }

  return (
    <div className="flex flex-col gap-1" role="status">
      {state.message ? (
        <p className="text-sm text-muted-foreground">{state.message}</p>
      ) : null}
      {state.lines?.map((line, index) => (
        <p key={index} className="text-sm break-words text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  )
}

/** The warning that goes with trusting a repository, shown when it is chosen. */
function TrustWarning() {
  return (
    <p
      className="flex items-start gap-3 rounded-xl bg-warning/10 p-3 text-[13px] ring-1 ring-warning/30"
      role="note"
    >
      <TriangleAlert
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-warning"
      />
      <span>
        Sync then changes a skill&apos;s text from this repository without
        asking you: whoever can push to it can put instructions in front of your
        assistants (prompt injection). Trust only a repository you or people you
        trust control. Anything that reaches further than text still waits for
        you.
      </span>
    </p>
  )
}

/** Trust, access and sign-in: the add form's and the settings form's. */
function RepoChoices({
  secrets,
  githubOffered,
  signedIn,
  initial,
}: {
  secrets: SecretOption[]
  githubOffered: boolean
  signedIn: boolean
  initial: {
    access: Access
    trust: Trust
    signIn: SignInChoice
    secretId: string | null
  }
}) {
  const [access, setAccess] = useState<Access>(initial.access)
  const [trust, setTrust] = useState<Trust>(initial.trust)
  const [signIn, setSignIn] = useState<SignInChoice>(initial.signIn)

  return (
    <>
      <ChoiceField<Access>
        label="Access"
        name="access"
        value={access}
        onValueChange={setAccess}
        hint={
          access === "write"
            ? "A repository you can push to: you can add your items to it, and two-way sync pushes your changes. PCP checks with GitHub that the sign-in may push."
            : "Someone else's repository, or one you only read from: PCP never writes to it."
        }
        options={[
          { value: "read", label: "Read-only" },
          { value: "write", label: "Read and write" },
        ]}
      />

      <ChoiceField<Trust>
        label="Trust"
        name="trust"
        value={trust}
        onValueChange={setTrust}
        hint="Not trusted is right for most repositories: every change waits for you to read it."
        options={[
          { value: "untrusted", label: "Not trusted" },
          { value: "trusted", label: "Trusted" },
        ]}
      />
      {trust === "trusted" ? <TrustWarning /> : null}

      <ChoiceField<SignInChoice>
        label="Sign-in"
        name="signIn"
        value={signIn}
        onValueChange={setSignIn}
        hint={
          signIn === "none"
            ? "A public repository reads without one; GitHub then allows few requests an hour."
            : signIn === "token"
              ? "A fine-grained personal access token from GitHub, kept as one of your secrets. PCP sends it to GitHub's API only."
              : "PCP's own GitHub sign-in: you approve it on github.com, and it is kept as a secret of PCP's."
        }
        options={[
          { value: "none", label: "None" },
          { value: "token", label: "A token" },
          ...(githubOffered
            ? [{ value: "github" as const, label: "GitHub sign-in" }]
            : []),
        ]}
      />
      {signIn === "token" ? (
        <Field
          label="Secret"
          htmlFor="repo-secret"
          hint={
            secrets.length === 0
              ? "Add your token under Secrets first."
              : undefined
          }
        >
          <Select
            id="repo-secret"
            name="secretId"
            defaultValue={initial.secretId ?? ""}
            required
          >
            <option value="" disabled>
              Choose a secret
            </option>
            {secrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {signIn === "github" ? (
        <GitHubSignIn signedIn={signedIn} access={access} />
      ) : null}
    </>
  )
}

/** Settings → Repositories' one primary action: linking a repository. */
export function AddRepoDialog(props: {
  secrets: SecretOption[]
  githubOffered: boolean
  signedIn: boolean
}) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const [state, action] = useActionState<RepoActionResult, FormData>(
    async (previous, formData) => {
      const result = await createRepoAction(previous, formData)

      if (result.status === "ok" && result.id) {
        setOpen(false)
        router.push(`/settings/repositories/${result.id}`)
      }

      return result
    },
    IDLE,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus aria-hidden />
        Add a repository
      </DialogTrigger>
      <DialogContent>
        <form
          action={action}
          className="flex flex-col gap-5"
          aria-label="Add a repository"
        >
          <div className="flex flex-col gap-2">
            <DialogTitle>Add a repository</DialogTitle>
            <DialogDescription>
              A GitHub repository to share skills, wrappers, browser flows, API
              endpoints and MCP servers through. Nothing secret ever goes there.
            </DialogDescription>
          </div>
          <Field
            label="Repository"
            htmlFor="repo-name"
            hint="owner/name, as on GitHub."
          >
            <Input
              id="repo-name"
              name="repo"
              required
              placeholder="anthropics/skills"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field
            label="Branch"
            htmlFor="repo-branch"
            hint="Left empty: the repository's default branch."
          >
            <Input
              id="repo-branch"
              name="branch"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <RepoChoices
            {...props}
            initial={{
              access: "read",
              trust: "untrusted",
              signIn: "none",
              secretId: null,
            }}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <FormError error={state.status === "error" ? state.error : null} />
            <SubmitButton pendingText="Checking with GitHub…">
              Add repository
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A linked repository's trust, access and sign-in, changed in place. */
export function RepoSettingsForm({
  repoId,
  initial,
  ...props
}: {
  repoId: string
  secrets: SecretOption[]
  githubOffered: boolean
  signedIn: boolean
  initial: {
    access: Access
    trust: Trust
    signIn: SignInChoice
    secretId: string | null
  }
}) {
  const [state, action] = useActionState<RepoActionResult, FormData>(
    updateRepoAction.bind(null, repoId),
    IDLE,
  )

  return (
    <form
      action={action}
      className="flex flex-col gap-4"
      aria-label="Repository settings"
    >
      <RepoChoices {...props} initial={initial} />
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="secondary" pendingText="Checking with GitHub…">
          Save
        </SubmitButton>
        <ResultLines state={state} />
      </div>
    </form>
  )
}

/**
 * PCP's GitHub sign-in by device flow: a code to type in at GitHub, and the
 * page asking PCP every few seconds, while it is open, whether that was done.
 */
export function GitHubSignIn({
  signedIn,
  access = "read",
}: {
  signedIn: boolean
  access?: Access
}) {
  const router = useRouter()
  const [scope, setScope] = useState<"public_repo" | "repo">("public_repo")
  const [state, setState] = useState<SignInResult>({ status: "idle" })
  const [pending, start] = useTransition()
  const waiting = state.status === "ok" && state.state === "waiting"

  useEffect(() => {
    if (!waiting) {
      return
    }

    const timer = setInterval(() => {
      void pollGitHubSignInAction().then((next) => {
        setState(next)

        if (next.status === "ok" && next.state === "done") {
          router.refresh()
        }
      })
    }, 5000)

    return () => clearInterval(timer)
  }, [waiting, router])

  if (state.status === "ok" && state.state === "done") {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Signed in to GitHub.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl bg-field p-3 text-sm">
      {signedIn ? (
        <p className="text-muted-foreground">
          You are signed in to GitHub. Sign in again to use another account.
        </p>
      ) : null}
      {waiting ? (
        <>
          <p>
            Open{" "}
            <a
              href={state.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              {state.verificationUri}
            </a>{" "}
            and enter this code:
          </p>
          <code
            className="text-lg font-semibold tracking-widest"
            data-testid="github-user-code"
          >
            {state.userCode}
          </code>
          <p className="text-xs text-muted-foreground">
            Keep this page open: PCP checks every few seconds whether you
            approved it.
          </p>
        </>
      ) : (
        <>
          <ChoiceField<"public_repo" | "repo">
            label="Repositories it reaches"
            name="githubScope"
            value={scope}
            onValueChange={setScope}
            hint={
              scope === "repo"
                ? `GitHub's "repo" access: your private repositories as well as public ones, to read${access === "write" ? " and push" : ""}. Choose it only for a private repository.`
                : `GitHub's "public_repo" access: public repositories only, to read${access === "write" ? " and push to the ones you may" : ""}. Enough for anything public.`
            }
            options={[
              { value: "public_repo", label: "Public only" },
              { value: "repo", label: "Private too" },
            ]}
          />
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () =>
                  setState(await startGitHubSignInAction(scope)),
                )
              }
            >
              {signedIn ? "Sign in again" : "Sign in with GitHub"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The sign-in does not expire. If GitHub stops taking it, PCP says so
            and you sign in again; you can revoke it any time at
            github.com/settings/applications.
          </p>
        </>
      )}
      {state.status === "ok" && state.state === "expired" ? (
        <p className="text-destructive" role="alert">
          The code ran out. Start again.
        </p>
      ) : null}
      {state.status === "ok" && state.state === "denied" ? (
        <p className="text-destructive" role="alert">
          GitHub says you turned it down.
        </p>
      ) : null}
      <FormError error={state.status === "error" ? state.error : null} />
    </div>
  )
}

/** A button that runs one action and shows what it said. */
function ActionButton({
  label,
  pendingLabel,
  run,
  variant = "secondary",
}: {
  label: string
  pendingLabel: string
  run: () => Promise<RepoActionResult>
  variant?: "secondary" | "destructive" | "ghost" | "default"
}) {
  const [state, setState] = useState<RepoActionResult>(IDLE)
  const [pending, start] = useTransition()

  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <Button
          type="button"
          size="sm"
          variant={variant}
          disabled={pending}
          onClick={() => start(async () => setState(await run()))}
        >
          {pending ? pendingLabel : label}
        </Button>
      </div>
      <ResultLines state={state} />
    </div>
  )
}

export function SyncRepoButton({ repoId }: { repoId: string }) {
  return (
    <ActionButton
      label="Sync now"
      pendingLabel="Syncing…"
      run={() => syncRepoAction(repoId)}
    />
  )
}

export function RemoveRepoButton({ repoId }: { repoId: string }) {
  return (
    <ActionButton
      label="Remove repository"
      pendingLabel="Removing…"
      variant="destructive"
      run={() => deleteRepoAction(repoId)}
    />
  )
}

const FREQUENCIES = [
  { value: "off", label: "Off" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
] as const

/** How one linked item syncs: how often, two-way, and Sync now. */
export function ItemSyncForm({
  itemId,
  label,
  frequency,
  bidirectional,
  writable,
}: {
  itemId: string
  label: string
  frequency: string
  bidirectional: boolean
  writable: boolean
}) {
  const [state, action] = useActionState<RepoActionResult, FormData>(
    setItemSyncAction.bind(null, itemId),
    IDLE,
  )

  return (
    <div className="flex basis-full flex-col gap-3">
      <form
        action={action}
        className="flex flex-wrap items-end gap-3"
        aria-label={`How ${label} syncs`}
      >
        <Field label="Sync" htmlFor={`sync-${itemId}`}>
          <Select
            id={`sync-${itemId}`}
            name="frequency"
            defaultValue={frequency}
            className="w-36"
          >
            {FREQUENCIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        {writable ? (
          <label
            className="flex min-h-10 items-center gap-2 text-sm"
            htmlFor={`two-way-${itemId}`}
          >
            <Switch
              id={`two-way-${itemId}`}
              name="bidirectional"
              defaultChecked={bidirectional}
            />
            Two-way: push my changes
          </label>
        ) : null}
        <SubmitButton variant="secondary" size="sm" pendingText="Saving…">
          Save
        </SubmitButton>
      </form>
      <ResultLines state={state} />
      <div className="flex flex-wrap gap-3">
        <ActionButton
          label="Sync now"
          pendingLabel="Syncing…"
          run={() => syncItemAction(itemId)}
        />
        <ActionButton
          label="Unlink"
          pendingLabel="Unlinking…"
          variant="ghost"
          run={() => unlinkItemAction(itemId)}
        />
      </div>
    </div>
  )
}

/** The add page's confirm: adds exactly the items shown, at that commit. */
export function AddItemsButton({
  repoId,
  commit,
  items,
}: {
  repoId: string
  commit: string
  items: Array<{ root: string; hash: string }>
}) {
  // What it said stays on the page: refreshing would read the items again.
  return (
    <ActionButton
      variant="default"
      label={`Add ${items.length === 1 ? "this item" : `these ${items.length} items`}`}
      pendingLabel="Adding…"
      run={() => addItemsAction(repoId, commit, items)}
    />
  )
}

/** The push page: the owner's items, some or all, one commit each. */
export function PushChooser({
  repoId,
  items,
}: {
  repoId: string
  items: Array<{ kind: string; id: string; label: string; note: string | null }>
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [state, setState] = useState<RepoActionResult>(IDLE)
  const [pending, start] = useTransition()
  const key = (item: { kind: string; id: string }) => `${item.kind}:${item.id}`

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2" aria-label="Your items">
        {items.map((item) => (
          <li key={key(item)} className="flex items-start gap-3">
            <Checkbox
              id={`push-${key(item)}`}
              checked={chosen.has(key(item))}
              onChange={(event) => {
                const next = new Set(chosen)
                if (event.target.checked) next.add(key(item))
                else next.delete(key(item))
                setChosen(next)
              }}
            />
            <label
              htmlFor={`push-${key(item)}`}
              className="flex flex-col text-sm"
            >
              <span>{item.label}</span>
              {item.note ? (
                <span className="text-xs text-muted-foreground">
                  {item.note}
                </span>
              ) : null}
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="plain"
          size="sm"
          onClick={() => setChosen(new Set(items.map(key)))}
        >
          Choose all
        </Button>
        <Button
          type="button"
          disabled={pending || chosen.size === 0}
          onClick={() =>
            start(async () =>
              setState(
                await pushItemsAction(
                  repoId,
                  items
                    .filter((item) => chosen.has(key(item)))
                    .map(({ kind, id }) => ({ kind, id })),
                ),
              ),
            )
          }
        >
          {pending
            ? "Pushing…"
            : `Push ${chosen.size === 1 ? "1 item" : `${chosen.size} items`}`}
        </Button>
      </div>
      <ResultLines state={state} />
    </div>
  )
}

/** The answers to a change sync left for the owner. */
export function ChangeAnswer({
  itemId,
  sha,
  hash,
  conflict,
}: {
  itemId: string
  sha: string
  hash: string
  conflict: boolean
}) {
  const [state, setState] = useState<RepoActionResult>(IDLE)
  const [pending, start] = useTransition()
  // The answer stays on the page; the bell drops it at the next page.
  const answer = (choice: "approve" | "decline" | "keep") =>
    start(async () => {
      setState(await answerChangeAction(itemId, choice, { sha, hash }))
    })

  if (state.status === "ok") {
    return <ResultLines state={state} />
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {conflict ? (
          <>
            <Button
              variant="secondary"
              size="lg"
              disabled={pending}
              onClick={() => answer("keep")}
            >
              Keep mine
            </Button>
            <Button
              size="lg"
              disabled={pending}
              onClick={() => answer("approve")}
            >
              Take theirs
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              size="lg"
              disabled={pending}
              onClick={() => answer("decline")}
            >
              Not now
            </Button>
            <Button
              size="lg"
              disabled={pending}
              onClick={() => answer("approve")}
            >
              Approve
            </Button>
          </>
        )}
      </div>
      <FormNote message="Nothing changes until you answer." />
      <FormError error={state.status === "error" ? state.error : null} />
    </div>
  )
}
