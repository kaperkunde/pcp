"use client"

import { Plus } from "lucide-react"
import { useActionState, useEffect, useRef, useState } from "react"

import { FormError } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input, Select, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  createSecretAction,
  type SecretActionResult,
} from "@/lib/actions/secrets"

/**
 * Adding a secret: the Secrets page's primary action, a sheet over the
 * page. It closes when the secret is saved.
 */
export function SecretAddDialog() {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus aria-hidden />
        Add a secret
      </DialogTrigger>
      <DialogContent>
        <AddSecretForm onSaved={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function AddSecretForm({ onSaved }: { onSaved: () => void }) {
  const [kind, setKind] = useState<"text" | "totp">("text")
  // What was last sent: React resets a form's fields once its action
  // returns, and a refused save would otherwise lose what the owner typed.
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [state, action] = useActionState<SecretActionResult, FormData>(
    async (previous, formData) => {
      setTyped({
        name: String(formData.get("name") ?? ""),
        description: String(formData.get("description") ?? ""),
        value: String(formData.get("value") ?? ""),
        origins: String(formData.get("origins") ?? ""),
      })
      const result = await createSecretAction(previous, formData)

      if (result.status === "ok") {
        onSaved()
      }

      return result
    },
    { status: "idle" },
  )
  const kindField = useRef<HTMLSelectElement>(null)

  // The reset sets the select back to its first option on screen, while the
  // kind chosen (and sent, below) stays: show it again.
  useEffect(() => {
    if (kindField.current) {
      kindField.current.value = kind
    }
  }, [state, kind])

  return (
    <form action={action} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <DialogTitle>Add a secret</DialogTitle>
        <DialogDescription>
          An API key, a personal access token, a password: whatever an MCP
          server needs to be sent, or the browser types into a page. It is
          encrypted, and only ever sent to the server that uses it or typed at
          the sites you name.
        </DialogDescription>
      </div>
      <Field label="Name" htmlFor="secret-name">
        <Input
          id="secret-name"
          name="name"
          defaultValue={typed.name}
          required
          maxLength={100}
          placeholder="GitHub token"
        />
      </Field>
      <Field label="Description (optional)" htmlFor="secret-description">
        <Input
          id="secret-description"
          name="description"
          defaultValue={typed.description}
          maxLength={500}
          placeholder="Personal access token, repo scope"
        />
      </Field>
      <Field
        label="Kind"
        htmlFor="secret-kind"
        hint={
          kind === "totp"
            ? "The seed of a sign-in's one-time codes. The browser types the code of the moment; you can see it here with Code."
            : undefined
        }
      >
        <Select
          id="secret-kind"
          ref={kindField}
          value={kind}
          onChange={(event) =>
            setKind(event.target.value === "totp" ? "totp" : "text")
          }
        >
          <option value="text">A value (a key, a token, a password)</option>
          <option value="totp">One-time codes (TOTP)</option>
        </Select>
        {/* Sent from here, not the select: the form's reset after a refused
            save sets a select back to its first option. */}
        <input type="hidden" name="kind" value={kind} />
      </Field>
      <Field
        label={kind === "totp" ? "Seed" : "Value"}
        htmlFor="secret-value"
        hint={
          kind === "totp"
            ? "The base32 text, or the otpauth:// link of the QR code, that the site showed when you set up its codes."
            : undefined
        }
      >
        <Textarea
          id="secret-value"
          name="value"
          defaultValue={typed.value}
          required
          autoComplete="off"
          spellCheck={false}
          className="min-h-16 font-mono"
        />
      </Field>
      <Field
        label="Sites for the browser (optional)"
        htmlFor="secret-origins"
        hint="Where the browser may type it into a page, one a line: https://example.com. Each token still needs your yes there."
      >
        <Textarea
          id="secret-origins"
          name="origins"
          defaultValue={typed.origins}
          autoComplete="off"
          spellCheck={false}
          className="min-h-12 font-mono"
        />
      </Field>
      <FormError error={state.status === "error" ? state.error : null} />
      <DialogFooter>
        <DialogClose render={<Button variant="secondary" />}>
          Cancel
        </DialogClose>
        <SubmitButton pendingText="Saving…">Save secret</SubmitButton>
      </DialogFooter>
    </form>
  )
}
