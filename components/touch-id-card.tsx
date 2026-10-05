"use client"

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react"

import {
  touchIdForget,
  touchIdSave,
  useTouchId,
} from "@/components/desktop-bridge"
import { FormError } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { UsernameField } from "@/components/username-field"
import {
  disableTouchIdAction,
  enableTouchIdAction,
  type TouchIdResult,
} from "@/lib/actions/settings"

/**
 * Touch ID in the Mac app (lib/core/device-keys.ts). Shown where it can be
 * turned on (the app, on a Mac with Touch ID) or where it is on and can be
 * turned off (anywhere). Turning it on takes the password; the app keeps
 * the new key in the macOS keychain after Touch ID confirms it is the owner.
 */
export function TouchIdCard({
  username,
  info,
}: {
  username: string
  /** The vault's Touch ID key, when there is one. */
  info: { createdAt: Date; lastUsedAt: Date | null } | null
}) {
  const { status, refresh } = useTouchId()
  const [state, action] = useActionState<TouchIdResult, FormData>(
    enableTouchIdAction,
    { status: "idle" },
  )
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const handled = useRef<TouchIdResult | null>(null)

  // The key just made goes to the app, which asks for Touch ID to keep it.
  useEffect(() => {
    if (state.status !== "ok" || handled.current === state) return
    handled.current = state
    const { deviceKey } = state

    startTransition(async () => {
      if (await touchIdSave(deviceKey)) {
        setError(null)
      } else {
        // Not kept: a key nobody holds should not stay valid.
        await disableTouchIdAction()
        setError("Touch ID did not confirm it was you, so it stays off.")
      }

      refresh()
    })
  }, [state, refresh])

  // The app holds a key PCP no longer knows (a restore, a recovery, signing
  // out everywhere, or turning it off from another browser).
  useEffect(() => {
    if (status?.saved && !info) {
      void touchIdForget().then(refresh)
    }
  }, [status?.saved, info, refresh])

  function turnOff() {
    startTransition(async () => {
      await disableTouchIdAction()
      await touchIdForget()
      refresh()
    })
  }

  if (!info && !status?.available) {
    return null
  }

  const here = Boolean(status?.saved && info)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Touch ID</CardTitle>
        <CardDescription>
          Unlock PCP in the Mac app with your fingerprint, and confirm a new API
          token, an export or a restore with it instead of your password. A new
          password or recovery key still takes your password. Recovering with
          the recovery key, or signing out everywhere, turns Touch ID off.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {info ? (
          <p className="text-sm">
            {here
              ? "On in this app."
              : status?.available
                ? "On, but this app no longer holds its key: it was reinstalled, or macOS kept the key from it. Set it up again, or turn it off."
                : "On in the Mac app."}{" "}
            <span className="text-muted-foreground">
              Set up <LocalDate value={info.createdAt} /> · last used{" "}
              <LocalDate value={info.lastUsedAt} />
            </span>
          </p>
        ) : null}
        {status?.available && !here ? (
          <form action={action} className="flex flex-col gap-4">
            <UsernameField id="touch-id-account" value={username} />
            <Field label="Your password" htmlFor="touch-id-password">
              <Input
                id="touch-id-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <FormError error={state.status === "error" ? state.error : error} />
            <div>
              <SubmitButton pendingText="Checking…">
                {info ? "Set up Touch ID again" : "Turn on Touch ID"}
              </SubmitButton>
            </div>
          </form>
        ) : (
          <FormError error={error} />
        )}
        {info ? (
          <div>
            <Button variant="outline" disabled={pending} onClick={turnOff}>
              Turn off Touch ID
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
