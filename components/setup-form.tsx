"use client"

import { useActionState } from "react"

import { AuthShell } from "@/components/auth-shell"
import { RestoreInsteadLink } from "@/components/backup-cards"
import { CopyableValue } from "@/components/copyable-value"
import { FormError } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { ButtonLink } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { setupAction, type SetupResult } from "@/lib/actions/auth"
import { MIN_PASSWORD_LENGTH } from "@/lib/core/constants"

/**
 * The whole first-visit page in its three states: the form that makes the
 * owner, the recovery key shown once, and (for a signed-in owner who comes
 * back) the note that setup is one-shot. It holds the page's shell because
 * the title and the words under it change with the state.
 */
export function SetupForm({ alreadySetUp }: { alreadySetUp: boolean }) {
  const [state, action] = useActionState<SetupResult, FormData>(setupAction, {
    status: "idle",
  })

  if (alreadySetUp && state.status !== "ok") {
    return (
      <AuthShell
        title="PCP is already set up"
        intro={<p>There is one owner, and you are signed in as them.</p>}
      >
        <ButtonLink href="/home" size="lg" className="w-full">
          Open PCP
        </ButtonLink>
      </AuthShell>
    )
  }

  if (state.status === "ok") {
    return (
      <AuthShell
        title="Save your recovery key"
        intro={
          <p>
            This is the only way back in if you forget your password. PCP cannot
            show it again: it is not stored anywhere.
          </p>
        }
      >
        <CopyableValue value={state.recoveryKey} testId="recovery-key" />
        <p className="text-sm leading-relaxed text-muted-foreground">
          Put it in your password manager now. Losing both the password and this
          key means the secrets in PCP can never be read again — that is the
          point of how they are stored.
        </p>
        <ButtonLink href="/setup/network" size="lg" className="w-full">
          I have saved it — continue
        </ButtonLink>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Welcome to PCP"
      intro={
        <p>
          Choose the password that will lock your vault. Everything PCP keeps —
          secrets, connections, tokens — is encrypted with a key only your
          password can unlock, so the server itself cannot read it.
        </p>
      }
    >
      <form action={action} className="flex flex-col gap-5">
        <Card>
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
        </Card>
        <FormError error={state.status === "error" ? state.error : null} />
        <SubmitButton
          size="lg"
          className="w-full"
          pendingText="Creating your vault…"
        >
          Create my PCP
        </SubmitButton>
      </form>
      <RestoreInsteadLink />
    </AuthShell>
  )
}
