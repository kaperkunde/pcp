"use client"

import { useActionState, useEffect, useState, useTransition } from "react"

import { Button } from "@kaperkunde/ui/button"
import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { Input } from "@kaperkunde/ui/input"
import { Field } from "@kaperkunde/ui/label"
import { List, ListRow, ListSection } from "@kaperkunde/ui/list"
import { SubmitButton } from "@kaperkunde/ui/submit-button"
import { LocalDate } from "@/components/local-date"
import {
  finishSigninAction,
  signinStatusAction,
  startSigninAction,
  type SigninStateResult,
} from "@/lib/actions/service-sign-in"

type SignedState = { signedIn: boolean; who: string | null }
type Started = {
  url: string
  host: string
  expiresAt: string | null
  msLeft: number | null
}

/**
 * The least a sign-in is waited on before the page starts another: a
 * service that says its sign-in ends sooner (or a clock that runs ahead)
 * never makes the page start one after another.
 */
const MIN_RESTART_MS = 30_000

/**
 * The sign-in itself: whether the service is signed in (read when the page
 * opens, inside this request); when it is not, Start signing in starts one
 * (never the page by itself: a reload or a second tab would end the one in
 * progress), then the provider's address, shown with its host, and the code
 * field. A sign-in that runs out is started again once by itself, counted
 * from the time left PCP's machine worked out, never this browser's clock;
 * after that the owner starts it again. The code goes to the server action
 * only; nothing here keeps it once it is sent.
 */
export function ServiceSignIn({ id, name }: { id: string; name: string }) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<SignedState | null>(null)
  const [started, setStarted] = useState<Started | null>(null)
  /** Started again by itself once already: the next time is the owner's. */
  const [restarted, setRestarted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [finished, finish] = useActionState<SigninStateResult, FormData>(
    finishSigninAction,
    { status: "idle" },
  )

  async function begin(why: string | null) {
    const result = await startSigninAction(id)

    if (result.status === "ok") {
      setStarted({
        url: result.url,
        host: result.host,
        expiresAt: result.expiresAt,
        msLeft: result.msLeft,
      })
      setError(null)
      setNote(why)
    } else if (result.status === "error") {
      setError(result.error)
    }
  }

  // Read once when the page opens: inside this request, never on a timer.
  useEffect(() => {
    startTransition(async () => {
      const read = await signinStatusAction(id)

      if (read.status === "ok") {
        setState({ signedIn: read.signedIn, who: read.who })
      } else if (read.status === "error") {
        setError(read.error)
      }
    })
  }, [id])

  // Signed in by the code just pasted.
  useEffect(() => {
    if (finished.status === "ok") {
      setState({ signedIn: finished.signedIn, who: finished.who })
      setStarted(null)
      setNote(null)
    }
  }, [finished])

  // A sign-in that runs out: started again once by itself, then the
  // owner's to start.
  useEffect(() => {
    if (started?.msLeft === null || started?.msLeft === undefined) {
      return
    }

    const timer = setTimeout(
      () => {
        if (restarted) {
          setStarted(null)
          setNote("That sign-in ran out. Start it again when you are ready.")
          return
        }

        setRestarted(true)
        startTransition(() =>
          begin("The last sign-in ran out, so PCP started a new one."),
        )
      },
      Math.max(MIN_RESTART_MS, started.msLeft),
    )
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started])

  const start = () => startTransition(() => begin(null))

  if (state?.signedIn && !started) {
    return (
      <ListSection title="Account" data-testid="service-sign-in">
        <List>
          <ListRow
            title={state.who ? `Signed in as ${state.who}` : "Signed in"}
            description={`${name}'s tools work under this account.`}
            trailing={
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={start}
              >
                Sign in again
              </Button>
            }
          />
        </List>
        <FormNote
          className="px-1"
          message={finished.status === "ok" ? "Signed in." : null}
        />
        <FormError className="px-1" error={error} />
      </ListSection>
    )
  }

  return (
    <ListSection
      title="Sign in"
      description="Open the provider's page, sign in there, and copy the code it shows you."
      data-testid="service-sign-in"
    >
      {started ? (
        <List>
          <ListRow
            title={`1. Open ${started.host}`}
            description={
              <>
                The sign-in page {name} asked for, at{" "}
                <strong className="font-medium">{started.host}</strong>
                {started.expiresAt ? (
                  <>
                    . It works until <LocalDate value={started.expiresAt} />
                  </>
                ) : null}
                .
              </>
            }
            trailing={
              <a
                className="text-sm text-primary underline-offset-4 hover:underline"
                href={started.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="sign-in-link"
              >
                Open
              </a>
            }
          />
          <div data-slot="list-row" className="px-4 py-3">
            <form action={finish} className="flex flex-col gap-3">
              <input type="hidden" name="id" value={id} />
              <Field
                label="2. Paste the code"
                htmlFor="sign-in-code"
                hint="PCP hands it to the service once and keeps it nowhere."
              >
                <Input
                  id="sign-in-code"
                  name="code"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  data-1p-ignore
                />
              </Field>
              <div className="flex justify-end">
                <SubmitButton pendingText="Signing in…">Sign in</SubmitButton>
              </div>
            </form>
          </div>
        </List>
      ) : (
        <List>
          <ListRow
            title={
              state
                ? "Not signed in"
                : error
                  ? "Whether it is signed in is not known"
                  : "Reading…"
            }
            description="Starting a sign-in ends one still waiting for its code, here or in another tab."
            trailing={
              <Button
                size="sm"
                disabled={pending || (!state && !error)}
                onClick={start}
              >
                Start signing in
              </Button>
            }
          />
        </List>
      )}
      <FormNote className="px-1" message={note} />
      <FormError
        className="px-1"
        error={finished.status === "error" ? finished.error : error}
      />
      {started && finished.status === "error" ? (
        <div className="px-1">
          <Button variant="plain" size="sm" disabled={pending} onClick={start}>
            Start the sign-in again
          </Button>
        </div>
      ) : null}
    </ListSection>
  )
}
