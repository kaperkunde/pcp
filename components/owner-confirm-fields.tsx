"use client"

import { Fingerprint } from "lucide-react"
import { useEffect, useRef } from "react"

import {
  touchIdForget,
  touchIdUnlock,
  useTouchId,
  whenFocused,
} from "@/components/desktop-bridge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { UsernameField } from "@/components/username-field"
import { TOUCH_ID_REJECTED } from "@/lib/core/constants"

/**
 * The owner's password again, inside a form that asks for it before a new
 * API token, a new public address, an export, a restore or deleting the
 * vault (confirmOwner in
 * lib/server/password-attempts.ts). In the Mac app with Touch ID on, Touch
 * ID answers instead: it is asked for as the step appears (`autoPrompt`) or
 * from its button, and the form is sent with the key the app hands over, in
 * place of the password.
 *
 * The fields a password manager sees stay the account and the password (see
 * UsernameField); the key travels in a hidden field that is emptied again as
 * soon as the form has read it, so a password typed after a refused key is
 * the one sent.
 */
export function OwnerConfirmFields({
  idPrefix,
  username,
  error,
  autoFocus = false,
  autoPrompt = true,
}: {
  idPrefix: string
  username: string
  /** The form's error: PCP refusing the key means the app forgets it. */
  error: string | null
  autoFocus?: boolean
  autoPrompt?: boolean
}) {
  const { status, refresh } = useTouchId()
  const password = useRef<HTMLInputElement>(null)
  const key = useRef<HTMLInputElement>(null)
  const prompted = useRef(false)

  async function confirmWithTouchId() {
    const passwordInput = password.current
    const keyInput = key.current
    const form = passwordInput?.form

    if (!passwordInput || !keyInput || !form) {
      return
    }

    // The rest of the form first (the restore's "replace everything" box):
    // a fingerprint is not spent on a form that would not be sent.
    passwordInput.required = false
    const ready = form.reportValidity()
    passwordInput.required = true

    if (!ready) {
      return
    }

    const deviceKey = await touchIdUnlock("confirm")

    if (!deviceKey) {
      return
    }

    keyInput.value = deviceKey
    passwordInput.required = false

    try {
      form.requestSubmit()
    } finally {
      keyInput.value = ""
      passwordInput.required = true
    }
  }

  useEffect(() => {
    if (!autoPrompt || !status?.saved) {
      return
    }

    return whenFocused(() => {
      if (prompted.current) return
      prompted.current = true
      void confirmWithTouchId()
    })
    // Once per step, when the app says Touch ID is on.
  }, [autoPrompt, status?.saved])

  useEffect(() => {
    if (error === TOUCH_ID_REJECTED) {
      void touchIdForget().then(refresh)
    }
  }, [error, refresh])

  return (
    <>
      <input ref={key} type="hidden" name="deviceKey" defaultValue="" />
      <UsernameField id={`${idPrefix}-account`} value={username} />
      <Field label="Your password" htmlFor={`${idPrefix}-password`}>
        <Input
          ref={password}
          id={`${idPrefix}-password`}
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus={autoFocus}
          required
        />
      </Field>
      {status?.saved ? (
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void confirmWithTouchId()}
          >
            <Fingerprint aria-hidden />
            Confirm with Touch ID
          </Button>
        </div>
      ) : null}
    </>
  )
}
