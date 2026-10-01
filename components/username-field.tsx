import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"

/**
 * The account a password belongs to, for password managers. PCP has one
 * owner and no username, but Safari decides what a password field is from
 * the form around it: without a username it guesses one (a token's name, a
 * recovery key), takes the form for a sign-up, and offers to generate a new
 * password instead of filling the saved one. A form that asks for the
 * password therefore holds this field (the owner's name, saved as the
 * username at setup) and the password, and nothing else a manager would
 * fill.
 *
 * It is shown, read-only: Safari passes over fields that are not visible.
 */
export function UsernameField({ id, value }: { id: string; value: string }) {
  return (
    <Field label="Account" htmlFor={id}>
      <Input
        id={id}
        name="username"
        type="text"
        autoComplete="username"
        value={value}
        readOnly
        className="bg-muted/40 text-muted-foreground"
      />
    </Field>
  )
}
