"use client"

import Link from "next/link"
import { useActionState } from "react"

import { FormError } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { recoverAction, type RecoverResult } from "@/lib/actions/auth"
import { MIN_PASSWORD_LENGTH } from "@/lib/core/constants"

export function RecoverForm() {
  const [state, action] = useActionState<RecoverResult, FormData>(
    recoverAction,
    { status: "idle" },
  )

  return (
    <Card>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          <Field label="Recovery key" htmlFor="recover-key">
            <Input
              id="recover-key"
              name="recoveryKey"
              autoComplete="off"
              spellCheck={false}
              placeholder="pcp_recovery_…"
              required
            />
          </Field>
          <Field label="New password" htmlFor="recover-password">
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
          <FormError error={state.status === "error" ? state.error : null} />
          <SubmitButton size="lg" pendingText="Recovering…">
            Set the new password
          </SubmitButton>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/login" className="text-primary hover:underline">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
