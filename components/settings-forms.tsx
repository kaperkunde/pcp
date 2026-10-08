"use client"

import { KeyRound, Link2, Lock, MonitorSmartphone } from "lucide-react"
import { useActionState, type FormEvent } from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError, FormNote } from "@/components/form-status"
import { SettingsItem } from "@/components/settings-item"
import { SubmitButton } from "@/components/submit-button"
import { Checkbox, Input } from "@/components/ui/input"
import { Field, Label } from "@/components/ui/label"
import { UsernameField } from "@/components/username-field"
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
    <SettingsItem
      id="public-address"
      title="Public address"
      icon={Link2}
      state={pinned || "Automatic"}
      about={
        <>
          Where PCP is reached from outside. It is part of the OAuth redirect
          URL sent to MCP servers and of the endpoint address shown under API
          tokens. Right now requests arrive at <code>{detected}</code>; set this
          when that is not the address others should use.
        </>
      }
    >
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
          <SubmitButton variant="secondary" pendingText="Saving…">
            Save
          </SubmitButton>
        </div>
      </form>
    </SettingsItem>
  )
}

export function ChangePasswordForm({ username }: { username: string }) {
  const [state, action] = useActionState<SettingsResult, FormData>(
    changePasswordAction,
    { status: "idle" },
  )

  return (
    <SettingsItem
      title="Password"
      icon={Lock}
      state="What unlocks PCP"
      about="Re-wraps the vault key under the new password. Sessions, API tokens and the recovery key keep working."
    >
      <form action={action} className="flex flex-col gap-4">
        <UsernameField id="settings-account" value={username} />
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
          <SubmitButton variant="secondary" pendingText="Changing…">
            Change password
          </SubmitButton>
        </div>
      </form>
    </SettingsItem>
  )
}

export function RecoveryKeyCard({ username }: { username: string }) {
  const [state, action] = useActionState<SettingsResult, FormData>(
    rotateRecoveryKeyAction,
    { status: "idle" },
  )

  function confirmRotation(event: FormEvent<HTMLFormElement>) {
    if (
      !window.confirm("Make a new recovery key? The current one stops working.")
    ) {
      event.preventDefault()
    }
  }

  return (
    <SettingsItem
      title="Recovery key"
      icon={KeyRound}
      state="The only way back in without your password"
      about="The key from setup. Make a new one if you did not save it, or think someone else has it. It opens the vault without the password, so PCP asks for your password before it makes one."
    >
      {state.status === "ok" && state.recoveryKey ? (
        <div className="flex flex-col gap-2">
          <CopyableValue value={state.recoveryKey} testId="recovery-key" />
          <FormNote message="Save it now; it is not stored anywhere." />
        </div>
      ) : null}
      <form
        action={action}
        onSubmit={confirmRotation}
        className="flex flex-col gap-4"
      >
        <UsernameField id="settings-recovery-account" value={username} />
        <Field label="Your password" htmlFor="settings-recovery-password">
          <Input
            id="settings-recovery-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <FormError error={state.status === "error" ? state.error : null} />
        <div>
          {/* Not "new": Safari can take a password form whose button
              says new or create for a sign-up, and offer a new password. */}
          <SubmitButton variant="secondary" pendingText="Replacing the key…">
            Replace the recovery key
          </SubmitButton>
        </div>
      </form>
    </SettingsItem>
  )
}

export function SessionsCard() {
  function confirmRevocation(event: FormEvent<HTMLFormElement>) {
    const revoking = new FormData(event.currentTarget).get("revokeTokens")

    if (
      revoking &&
      !window.confirm(
        "Revoke every API token too? Assistants using them stop working at once.",
      )
    ) {
      event.preventDefault()
    }
  }

  return (
    <SettingsItem
      title="Signed-in devices"
      icon={MonitorSmartphone}
      state="Sign every browser out"
      about="Sign every browser out, including this one, and turn Touch ID off. If you think someone else has had your password or a token, revoke every API token as well; your assistants will need new ones."
    >
      <form
        action={signOutEverywhereAction}
        onSubmit={confirmRevocation}
        className="flex flex-col items-start gap-4"
      >
        <Label className="font-normal">
          <Checkbox name="revokeTokens" />
          Also revoke every API token
        </Label>
        <SubmitButton variant="secondary" pendingText="Signing out…">
          Sign out everywhere
        </SubmitButton>
      </form>
    </SettingsItem>
  )
}
