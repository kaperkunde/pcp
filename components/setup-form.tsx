"use client"

import { useActionState } from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { ButtonLink } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { setupAction, type SetupResult } from "@/lib/actions/auth"
import { MIN_PASSWORD_LENGTH } from "@/lib/core/constants"

export function SetupForm({ alreadySetUp }: { alreadySetUp: boolean }) {
  const [state, action] = useActionState<SetupResult, FormData>(setupAction, {
    status: "idle",
  })

  if (alreadySetUp && state.status !== "ok") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>PCP is already set up</CardTitle>
          <CardDescription>
            There is one owner, and you are signed in as them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ButtonLink href="/servers" size="lg">
            Open PCP
          </ButtonLink>
        </CardContent>
      </Card>
    )
  }

  if (state.status === "ok") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Save your recovery key</CardTitle>
          <CardDescription>
            This is the only way back in if you forget your password. PCP cannot
            show it again: it is not stored anywhere.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CopyableValue value={state.recoveryKey} testId="recovery-key" />
          <p className="text-sm text-muted-foreground">
            Put it in your password manager now. Losing both the password and
            this key means the secrets in PCP can never be read again — that is
            the point of how they are stored.
          </p>
          <ButtonLink href="/setup/network" size="lg">
            I have saved it — continue
          </ButtonLink>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          <Field label="Your name" htmlFor="setup-name">
            {/* The account the password is saved under; every later form
                that asks for it names the same one (UsernameField). */}
            <Input
              id="setup-name"
              name="name"
              autoComplete="username"
              required
              maxLength={80}
            />
          </Field>
          <Field
            label="Password"
            htmlFor="setup-password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters. It encrypts everything PCP stores, so make it a good one.`}
          >
            <Input
              id="setup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
            />
          </Field>
          <Field label="Repeat password" htmlFor="setup-confirm">
            <Input
              id="setup-confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
            />
          </Field>
          <FormError error={state.status === "error" ? state.error : null} />
          <SubmitButton size="lg" pendingText="Creating your vault…">
            Create my PCP
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  )
}
