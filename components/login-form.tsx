"use client"

import { Fingerprint } from "lucide-react"
import {
  startTransition,
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

import {
  touchIdForget,
  touchIdSave,
  touchIdUnlock,
  useTouchId,
  whenFocused,
} from "@/components/desktop-bridge"
import { AuthLink } from "@/components/auth-link"
import { FormError, FormNote } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { List } from "@/components/ui/list"
import { SwitchRow } from "@/components/ui/switch"
import { UsernameField } from "@/components/username-field"
import {
  loginAction,
  touchIdLoginAction,
  type LoginResult,
  type TouchIdLoginResult,
} from "@/lib/actions/auth"
import { TOUCH_ID_REJECTED } from "@/lib/core/constants"

/**
 * The password, and in the Mac app Touch ID: with it on, the fingerprint is
 * asked for as the page opens and the password stays below for when it is
 * not given. With it available but off, a box under the password turns it
 * on with that sign-in.
 *
 * After a restore the vault's Touch ID key is gone with the rest of it, so
 * the app's copy is forgotten rather than offered (`restored`).
 *
 * `next` is where to go on to once unlocked (an assistant's sign-in page),
 * sent along with whichever way the owner unlocks.
 */
export function LoginForm({
  username,
  restored,
  next = null,
}: {
  username: string
  restored: boolean
  next?: string | null
}) {
  const [state, action] = useActionState<LoginResult, FormData>(loginAction, {
    status: "idle",
  })
  const [keyState, signInWithKey] = useActionState<
    TouchIdLoginResult,
    FormData
  >(touchIdLoginAction, { status: "idle" })
  const { status, refresh } = useTouchId()
  const [touchIdNote, setTouchIdNote] = useState<string | null>(null)
  const handled = useRef<LoginResult | null>(null)

  useEffect(() => {
    if (restored) {
      void touchIdForget().then(refresh)
    }
  }, [restored, refresh])

  // Touch ID ticked: the password made a key instead of signing in. The app
  // keeps it (after Touch ID), and the page signs in with it; a key the app
  // did not keep signs in this once and is gone after, so none is left that
  // nobody holds.
  useEffect(() => {
    if (state.status !== "ok" || !state.deviceKey || handled.current === state)
      return
    handled.current = state
    const deviceKey = state.deviceKey

    void touchIdSave(deviceKey).then((kept) => {
      const data = new FormData()
      data.set("deviceKey", deviceKey)
      if (!kept) data.set("once", "on")
      if (next) data.set("next", next)
      startTransition(() => signInWithKey(data))
    })
  }, [state, signInWithKey, next])

  const rejected = useCallback(() => {
    setTouchIdNote(TOUCH_ID_REJECTED)
    void touchIdForget().then(refresh)
  }, [refresh])

  return (
    <div className="flex flex-col gap-6">
      {status?.saved && !restored ? (
        <TouchIdUnlock onRejected={rejected} next={next} />
      ) : null}
      <FormNote message={touchIdNote} />
      <form action={action} className="flex flex-col gap-5">
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <Card>
          <UsernameField id="login-account" value={username} />
          <Field label="Password" htmlFor="login-password">
            <Input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
            />
          </Field>
        </Card>
        {status?.available && !status.saved ? (
          <List>
            <SwitchRow
              id="login-touch-id"
              name="touchId"
              label="Unlock with Touch ID from now on"
              description="Your fingerprint is asked for when this page opens."
            />
          </List>
        ) : null}
        <FormError
          error={
            state.status === "error"
              ? state.error
              : keyState.status === "error"
                ? keyState.error
                : null
          }
        />
        <FormNote
          message={
            state.status === "ok" && keyState.status !== "error"
              ? "Turning on Touch ID…"
              : null
          }
        />
        <SubmitButton size="lg" className="w-full" pendingText="Unlocking…">
          Unlock
        </SubmitButton>
      </form>
      <AuthLink href="/recover" prompt="Forgot it?">
        Use your recovery key
      </AuthLink>
    </div>
  )
}

/** Touch ID, asked for once as the page opens and again from its button. */
function TouchIdUnlock({
  onRejected,
  next,
}: {
  onRejected: () => void
  next: string | null
}) {
  const [state, action, pending] = useActionState<TouchIdLoginResult, FormData>(
    touchIdLoginAction,
    { status: "idle" },
  )
  const [asking, setAsking] = useState(false)
  const prompted = useRef(false)

  async function unlock() {
    setAsking(true)
    const deviceKey = await touchIdUnlock("unlock")
    setAsking(false)

    if (!deviceKey) {
      return
    }

    const data = new FormData()
    data.set("deviceKey", deviceKey)
    if (next) data.set("next", next)
    // Not from a <form action>, so React is told it is an action's work.
    startTransition(() => action(data))
  }

  useEffect(
    () =>
      whenFocused(() => {
        if (prompted.current) return
        prompted.current = true
        void unlock()
      }),
    // Once, as the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const error = state.status === "error" ? state.error : null

  useEffect(() => {
    if (error === TOUCH_ID_REJECTED) {
      onRejected()
    }
  }, [error, onRejected])

  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        disabled={asking || pending}
        onClick={() => void unlock()}
      >
        <Fingerprint aria-hidden />
        {pending ? "Unlocking…" : "Unlock with Touch ID"}
      </Button>
      <FormError error={error === TOUCH_ID_REJECTED ? null : error} />
      <p className="text-center text-sm text-muted-foreground">
        Or use your password.
      </p>
    </div>
  )
}
