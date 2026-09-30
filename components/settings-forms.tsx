"use client"

import { useActionState, useState, useTransition } from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError, FormNote } from "@/components/form-status"
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
import {
  changePasswordAction,
  rotateRecoveryKeyAction,
  setPublicUrlAction,
  signOutEverywhereAction,
  type SettingsResult,
} from "@/lib/actions/settings"
import { MIN_PASSWORD_LENGTH } from "@/lib/core/constants"

export function PublicUrlForm({
  pinned,
  detected,
}: {
  pinned: string
  detected: string
}) {
  const [state, action] = useActionState<SettingsResult, FormData>(
    setPublicUrlAction,
    { status: "idle" },
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Public address</CardTitle>
        <CardDescription>
          Where PCP is reached from outside. It is part of the OAuth redirect
          URL sent to MCP servers and of the endpoint address shown under API
          tokens. Right now requests arrive at <code>{detected}</code>; set this
          when that is not the address others should use.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          <Field label="Public address" htmlFor="settings-public-url">
            <Input
              id="settings-public-url"
              name="publicUrl"
              type="url"
              defaultValue={pinned}
              placeholder={detected}
            />
          </Field>
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton pendingText="Saving…">Save</SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

export function ChangePasswordForm() {
  const [state, action] = useActionState<SettingsResult, FormData>(
    changePasswordAction,
    { status: "idle" },
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Re-wraps the vault key under the new password. Sessions, API tokens
          and the recovery key keep working.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          <Field label="Current password" htmlFor="settings-current">
            <Input
              id="settings-current"
              name="current"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="New password" htmlFor="settings-password">
              <Input
                id="settings-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
              />
            </Field>
            <Field label="Repeat new password" htmlFor="settings-confirm">
              <Input
                id="settings-confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
              />
            </Field>
          </div>
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton pendingText="Changing…">Change password</SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

export function RecoveryKeyCard() {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<SettingsResult>({ status: "idle" })

  function rotate() {
    if (
      !window.confirm("Make a new recovery key? The current one stops working.")
    ) {
      return
    }

    startTransition(async () => {
      setResult(await rotateRecoveryKeyAction())
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recovery key</CardTitle>
        <CardDescription>
          The key from setup. Make a new one if you did not save it, or think
          someone else has it.
        </CardDescription>
      </CardHeader>
      <CardContent className="items-start">
        {result.status === "ok" && result.recoveryKey ? (
          <>
            <CopyableValue value={result.recoveryKey} testId="recovery-key" />
            <FormNote message="Save it now; it is not stored anywhere." />
          </>
        ) : null}
        <FormError error={result.status === "error" ? result.error : null} />
        <Button variant="outline" disabled={pending} onClick={rotate}>
          {pending ? "Making a new key…" : "Make a new recovery key"}
        </Button>
      </CardContent>
    </Card>
  )
}

export function SessionsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>
          Sign every browser out, including this one. API tokens are separate:
          revoke those under API tokens.
        </CardDescription>
      </CardHeader>
      <CardContent className="items-start">
        <form action={signOutEverywhereAction}>
          <SubmitButton variant="outline" pendingText="Signing out…">
            Sign out everywhere
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  )
}
