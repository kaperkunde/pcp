"use client"

import Link from "next/link"
import { useActionState } from "react"

import { FormError } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { loginAction, type LoginResult } from "@/lib/actions/auth"

export function LoginForm() {
  const [state, action] = useActionState<LoginResult, FormData>(loginAction, {
    status: "idle",
  })

  return (
    <Card>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
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
          <FormError error={state.status === "error" ? state.error : null} />
          <SubmitButton size="lg" pendingText="Unlocking…">
            Unlock
          </SubmitButton>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          Forgot it?{" "}
          <Link href="/recover" className="text-primary hover:underline">
            Use your recovery key
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
