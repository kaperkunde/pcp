"use client"

import { useActionState } from "react"

import { AuthLink } from "@/components/auth-link"
import { FormError } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { List } from "@/components/ui/list"
import { SwitchRow } from "@/components/ui/switch"
import { UsernameField } from "@/components/username-field"
import { recoverAction, type RecoverResult } from "@/lib/actions/auth"
import { MIN_PASSWORD_LENGTH } from "@/lib/core/constants"

export function RecoverForm({ username }: { username: string }) {
  const [state, action] = useActionState<RecoverResult, FormData>(
    recoverAction,
    { status: "idle" },
  )

  return (
    <div className="flex flex-col gap-6">
      <form action={action} className="flex flex-col gap-5">
        <Card>
          <Field
            label="Recovery key"
            htmlFor="recover-key"
            hint="The one PCP showed you once, when you set it up."
          >
            <Input
              id="recover-key"
              name="recoveryKey"
              autoComplete="off"
              spellCheck={false}
              placeholder="pcp_recovery_…"
              required
            />
          </Field>
          <UsernameField id="recover-account" value={username} />
          <Field
            label="New password"
            htmlFor="recover-password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          >
            <Input
              id="recover-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
            />
          </Field>
          <Field label="Repeat new password" htmlFor="recover-confirm">
            <Input
              id="recover-confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
            />
          </Field>
        </Card>
        <List>
          <SwitchRow
            id="recover-revoke"
            name="revokeTokens"
            label="Also revoke every API token"
            description="Do this if you think someone else has had your password or a token. Your assistants will need new tokens."
          />
        </List>
        <FormError error={state.status === "error" ? state.error : null} />
        <SubmitButton size="lg" className="w-full" pendingText="Recovering…">
          Set the new password
        </SubmitButton>
      </form>
      <AuthLink href="/login">Back to sign in</AuthLink>
    </div>
  )
}
