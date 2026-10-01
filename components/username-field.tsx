/**
 * The account a password belongs to, for password managers. PCP has one
 * owner and no username, but Safari classifies a password form by the field
 * it takes for the username: without one it guesses (a token's name, a
 * recovery key), finds no saved password for that "account", and offers to
 * generate a new one instead of filling the saved one. Naming the account
 * (the owner's name, as at setup) in every form that asks for the password
 * keeps it to one saved password, filled wherever PCP asks for it.
 *
 * Hidden from view and from the tab order, not with `hidden` or
 * display:none: Safari skips fields that are not rendered.
 */
export function UsernameField({ value }: { value: string }) {
  return (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={value}
      readOnly
      tabIndex={-1}
      aria-hidden
      className="sr-only"
    />
  )
}
