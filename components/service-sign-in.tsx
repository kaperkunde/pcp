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
type Started = { url: string; host: string; expiresAt: string | null }

/** The longest a browser's timer waits (about 24 days). */
const LONGEST_TIMER_MS = 2 ** 31 - 1

/**
 * The sign-in itself: whether the service is signed in (read when the page
 * opens, inside this request), and when it is not, a sign-in started at
 * once: the provider's address, shown with its host, and the code field.
 * A sign-in that runs out is started again by itself. The code goes to the
 * server action only; nothing here keeps it once it is sent.
 */
export function ServiceSignIn({ id, name }: { id: string; name: string }) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<SignedState | null>(null)
  const [started, setStarted] = useState<Started | null>(null)
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

        if (!read.signedIn) {
          await begin(null)
        }
      } else if (read.status === "error") {
        setError(read.error)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Signed in by the code just pasted.
  useEffect(() => {
    if (finished.status === "ok") {
      setState({ signedIn: finished.signedIn, who: finished.who })
      setStarted(null)
      setNote(null)
    }
  }, [finished])

  // A sign-in that runs out is started again, with a new address.
  useEffect(() => {
    if (!started?.expiresAt) {
      return
    }

    const left = Date.parse(started.expiresAt) - Date.now()

    if (left > LONGEST_TIMER_MS) {
      return
    }

    const timer = setTimeout(
      () => {
        startTransition(() =>
          begin("The last sign-in ran out, so PCP started a new one."),
        )
      },
      Math.max(0, left),
    )
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started])

  const again = () => startTransition(() => begin(null))

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
                onClick={again}
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
            title={error ? "No sign-in started" : "Starting a sign-in…"}
            trailing={
              error ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={again}
                >
                  Try again
                </Button>
              ) : null
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
          <Button variant="plain" size="sm" disabled={pending} onClick={again}>
            Start the sign-in again
          </Button>
        </div>
      ) : null}
    </ListSection>
  )
}
