"use client"

import { useState } from "react"

import { useAnswer } from "@/components/answer-queue"
import { FormError } from "@kaperkunde/ui/form-status"
import {
  DECISION_BUTTON,
  PermissionActions,
  QUIET_DECISION,
} from "@/components/permission-actions"
import { PermissionOutcome } from "@/components/permission-outcome"
import {
  chosenAccess,
  initialAccessRows,
  ProposedAccessEditor,
  type AccessRow,
} from "@/components/proposed-access-editor"
import { Button } from "@kaperkunde/ui/button"
import { Checkbox, Input, Select, Textarea } from "@kaperkunde/ui/input"
import { Field, Label } from "@kaperkunde/ui/label"
import { List } from "@kaperkunde/ui/list"
import { SwitchRow } from "@kaperkunde/ui/switch"
import { decidePermissionAction } from "@/lib/actions/permissions"
import type { SecretSitesShown } from "@/lib/core/browser-secrets"
import {
  ALLOW_FOR_MINUTES,
  DEFAULT_ALLOW_FOR_MINUTES,
  DEFAULT_PASSWORD_RECIPE,
  MAX_GENERATE_EXCLUDE,
  MAX_GENERATED_LENGTH,
  MIN_GENERATED_LENGTH,
  allowForLabel,
  type PasswordRecipe,
  type PermissionDecision as Decision,
} from "@/lib/core/constants"
import type { ProposedAccessShown } from "@/lib/core/proposed-access"

/** The answers that carry out the request, rather than turn it down. */
const AGREES: Decision[] = ["allow_once", "allow_for", "always"]

/** Answers that settle more than this one request, or throw it away: quiet. */
const QUIET: Decision[] = ["block", "discard"]

/**
 * The owner's buttons for something an assistant asked for. Answering runs
 * the call there and then; the page around it re-renders with the outcome.
 *
 * The main yes ("Allow once", or the kind's own) is the one teal button, last
 * at the right; the refusal and the answers that settle later calls are
 * grey buttons before it; Block and Discard are quiet text under them.
 *
 * A new server that sends a secret PCP does not hold yet asks for its value
 * here, the one place it is typed in (`secret`); with `exists`, a secret of
 * that name was added since and is used when the field is left empty. With
 * `clientId` it is that OAuth client's secret, which may be left empty
 * (`optional`) for a client without one.
 *
 * A memory to share offers a switch for reading it in every conversation
 * (`every`), on when the assistant asked for that; it holds whether the
 * owner shares the memory or keeps it for that assistant.
 *
 * A proposed MCP server or endpoint at a private address offers a switch
 * to allow private addresses (`privateAddresses`), off: left alone, it
 * reaches public addresses only, as everything an assistant proposes.
 *
 * "Allow for" comes with how long, chosen beside its button, unless the
 * kind has one length only (`allowForFixed`: a secret the browser types,
 * an hour), which its label says.
 *
 * A secret for the browser to type (request_secret) has `kind` and
 * `origins`: a TOTP seed is asked for as such, and the sites it is typed at
 * are ticked (the requested ones, read-only, so a password manager's
 * autofill has nothing to write over) or added one a line before it is
 * saved. A text one also takes its login name (`username`, filled in from
 * the request) in a form marked up for password managers: the login name
 * as `username`, the value as `new-password`, so one they suggest is saved
 * with the right login. Generate (on when the assistant asked, `generate`)
 * has PCP make the password instead, from the recipe shown, on its own
 * machine: nothing typed here, and the assistant never gets it.
 *
 * A change to a secret's sites (update_secret_sites, `sites`) lists the
 * sites it has and each change with a box, ticked unless it looks like one
 * of the sites without being it; the answer carries what was ticked and
 * the sites as shown, so it applies to nothing else.
 *
 * The answer goes through the owner's queue (components/answer-queue.tsx):
 * the count drops at once, and the owner is taken on to the next request,
 * unless `advance` is off (a token's page, which lists its own).
 *
 * `revision` is the request as the page shows it: when an assistant has
 * added to it since, the answer is refused and the owner reads it again.
 *
 * A new or changed server whose assistant proposed levels and tiers for its
 * tools (`access`) shows them filled in and editable above the buttons; the
 * yes sends what the owner left there, and nothing else writes them.
 */
export function PermissionDecision({
  id,
  decisions,
  secret,
  every,
  privateAddresses = false,
  advance = true,
  allowForFixed = false,
  revision,
  access = null,
  sites = null,
}: {
  advance?: boolean
  id: string
  revision?: string
  decisions: Array<{ value: Decision; label: string }>
  allowForFixed?: boolean
  secret?: {
    name: string
    exists: boolean
    optional?: boolean
    clientId?: string | null
    /** The user name this is the password for (basic authentication). */
    login?: string | null
    /** A secret for the browser: "totp" for a one-time codes seed. */
    kind?: "text" | "totp"
    /** The sites a secret for the browser is typed at, to confirm. */
    origins?: string[]
    /** A secret for the browser: the login name it goes with. */
    username?: string | null
    /** A secret for the browser: the password PCP was asked to make. */
    generate?: PasswordRecipe | null
  } | null
  every?: { asked: boolean } | null
  privateAddresses?: boolean
  access?: ProposedAccessShown | null
  sites?: SecretSitesShown | null
}) {
  const { submit, pending, error, setError, done } = useAnswer(
    { request: id },
    { advance },
  )
  const [chosen, setChosen] = useState<Decision | null>(null)
  const [secretValue, setSecretValue] = useState("")
  const [always, setAlways] = useState(every?.asked === true)
  const [allowPrivate, setAllowPrivate] = useState(false)
  const [minutes, setMinutes] = useState<number>(DEFAULT_ALLOW_FOR_MINUTES)
  const browserSecret = secret?.origins !== undefined
  // A new text secret for the browser: its login name and Generate.
  const credential = browserSecret && secret?.kind !== "totp" && !secret?.exists
  const [kept, setKept] = useState<string[]>(secret?.origins ?? [])
  const [moreOrigins, setMoreOrigins] = useState("")
  const [username, setUsername] = useState(secret?.username ?? "")
  const [generate, setGenerate] = useState(
    credential && Boolean(secret?.generate),
  )
  const [recipe, setRecipe] = useState<PasswordRecipe>(
    secret?.generate ?? DEFAULT_PASSWORD_RECIPE,
  )
  const [siteKeep, setSiteKeep] = useState<string[]>(() =>
    (sites?.changes ?? [])
      .filter((change) => !change.noop && !change.lookalike)
      .map((change) => change.key),
  )
  const [accessRows, setAccessRows] = useState<AccessRow[]>(() =>
    access ? initialAccessRows(access) : [],
  )

  function decide(value: Decision) {
    const agrees = AGREES.includes(value)

    if (
      secret &&
      agrees &&
      !secret.exists &&
      !secret.optional &&
      !secretValue &&
      !(credential && generate)
    ) {
      setError(
        secret.login
          ? `Enter the password for ${secret.login} first.`
          : secret.kind === "totp"
            ? `Enter the seed of "${secret.name}" first.`
            : `Enter the value of the secret "${secret.name}" first.`,
      )
      return
    }

    if (sites && agrees && siteKeep.length === 0) {
      setError("Tick at least one change, or answer Not now.")
      return
    }

    setChosen(value)

    submit(async () => {
      const result = await decidePermissionAction(
        id,
        value,
        secret && agrees && secretValue && !(credential && generate)
          ? secretValue
          : undefined,
        every ? always : undefined,
        value === "allow_for" && !allowForFixed ? minutes : undefined,
        browserSecret && agrees
          ? [
              ...kept,
              ...moreOrigins
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            ]
          : undefined,
        revision,
        privateAddresses && agrees ? allowPrivate : undefined,
        access && agrees ? chosenAccess(accessRows) : undefined,
        agrees && (credential || sites)
          ? {
              ...(credential ? { loginName: username } : {}),
              ...(credential && generate ? { generate: recipe } : {}),
              ...(sites
                ? { sites: { basis: sites.basis, keep: siteKeep } }
                : {}),
            }
          : undefined,
      )

      return result.status === "ok"
        ? result
        : { error: result.status === "error" ? result.error : "Not sent." }
    })
  }

  if (done) {
    return (
      <PermissionOutcome
        outcome={done.message}
        outcomeIsError={done.isError}
        tone={done.isError ? "error" : "ok"}
      />
    )
  }

  function labelOf(decision: { value: Decision; label: string }): string {
    return pending && chosen === decision.value
      ? "Working…"
      : decision.value === "allow_for" && !allowForFixed
        ? `${decision.label} ${allowForLabel(minutes)}`
        : decision.label
  }

  const primary = decisions.find((decision) => decision.value === "allow_once")
  const allowFor = allowForFixed
    ? undefined
    : decisions.find((decision) => decision.value === "allow_for")
  // The grey buttons, refusal first: Not now, Allow for (when it has one
  // length), Always allow.
  const order: Decision[] = ["decline", "allow_for", "always"]
  const others = decisions
    .filter(
      (decision) =>
        decision !== primary &&
        decision !== allowFor &&
        !QUIET.includes(decision.value),
    )
    .sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value))
  const quiet = decisions.filter((decision) => QUIET.includes(decision.value))

  function setRecipeField<K extends keyof PasswordRecipe>(
    key: K,
    value: PasswordRecipe[K],
  ) {
    setRecipe((current) => ({ ...current, [key]: value }))
  }

  const valueField = secret ? (
    <Field
      label={
        secret.clientId
          ? `Client secret of the OAuth client "${secret.clientId}"`
          : secret.login
            ? `Password for ${secret.login}`
            : secret.kind === "totp"
              ? `Seed of the one-time codes "${secret.name}"`
              : `Value of the secret "${secret.name}"`
      }
      htmlFor={`permission-${id}-secret`}
      hint={
        secret.origins && secret.exists
          ? `You have added a secret named "${secret.name}" since; leave this empty to use it. Nothing is written over it.`
          : secret.origins
            ? secret.kind === "totp"
              ? `The base32 text, or the otpauth:// link of the QR code, that the site showed when you set up its codes. It is saved under Secrets as "${secret.name}", encrypted; PCP types only the code of the moment, and only at the sites below. The assistant never sees it.`
              : `It is saved under Secrets as "${secret.name}", encrypted, and typed only at the sites below. The assistant never sees it.`
            : secret.exists
              ? `You have added a secret named "${secret.name}" since; leave this empty to use it, or enter a value to save a new one.`
              : secret.clientId
                ? `From the provider's developer settings, where you created the client. It is saved under Secrets as "${secret.name}", encrypted, and sent only to the token address above; the assistant never sees it. Leave it empty for a client without a secret.`
                : secret.login
                  ? `An app password, if the server offers them, rather than your own. It is saved under Secrets as "${secret.name}", encrypted, and sent only to the address above; the assistant never sees it.`
                  : "The key or token itself. It is saved under Secrets, encrypted, and sent only to the address above; the assistant never sees it."
      }
    >
      <Input
        id={`permission-${id}-secret`}
        type="password"
        // A browser password: what a password manager offers to make
        // or fill, saved with the login name above.
        name={credential ? "new-password" : undefined}
        autoComplete={credential ? "new-password" : "off"}
        value={secretValue}
        onChange={(event) => setSecretValue(event.target.value)}
        disabled={pending}
      />
    </Field>
  ) : null

  return (
    <div className="flex flex-col gap-5">
      {credential ? (
        // The login name and the password together, for a password manager
        // to save as one sign-in; the sites stay outside, out of its reach.
        <form
          className="flex flex-col gap-5"
          autoComplete="on"
          onSubmit={(event) => event.preventDefault()}
        >
          <Field
            label="Login name"
            htmlFor={`permission-${id}-username`}
            hint="The user name or email address it signs in with, kept with the secret. An assistant types it with the password's name and part username, at the same sites; leave it empty for none."
          >
            <Input
              id={`permission-${id}-username`}
              name="username"
              autoComplete="username"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={pending}
            />
          </Field>
          <List>
            <SwitchRow
              id={`permission-${id}-generate`}
              label="Have PCP make a new password"
              description={
                <>
                  {secret?.generate ? "The assistant asked for this. " : null}
                  For a sign-up or a password change: PCP makes it when you
                  save, nobody sees it on the way, and you can reveal it under
                  Secrets to keep a copy.
                </>
              }
              checked={generate}
              onChange={(event) => setGenerate(event.target.checked)}
              disabled={pending}
            />
          </List>
          {generate ? (
            <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
              <legend className="mb-2 text-sm font-medium">
                The password PCP makes
              </legend>
              <Field label="Length" htmlFor={`permission-${id}-length`}>
                <Input
                  id={`permission-${id}-length`}
                  type="number"
                  inputMode="numeric"
                  autoComplete="off"
                  min={MIN_GENERATED_LENGTH}
                  max={MAX_GENERATED_LENGTH}
                  value={recipe.length}
                  onChange={(event) =>
                    setRecipeField("length", Number(event.target.value))
                  }
                  className="w-28"
                  disabled={pending}
                />
              </Field>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {(
                  [
                    ["lowercase", "Lower-case letters"],
                    ["uppercase", "Capital letters"],
                    ["digits", "Digits"],
                    ["symbols", "Symbols"],
                  ] as const
                ).map(([key, label]) => (
                  <Label key={key} className="font-normal">
                    <Checkbox
                      checked={recipe[key]}
                      onChange={(event) =>
                        setRecipeField(key, event.target.checked)
                      }
                      disabled={pending}
                    />
                    {label}
                  </Label>
                ))}
              </div>
              <Field
                label="Leave out"
                htmlFor={`permission-${id}-exclude`}
                hint="Characters the site refuses, if any."
              >
                <Input
                  id={`permission-${id}-exclude`}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={MAX_GENERATE_EXCLUDE}
                  value={recipe.exclude}
                  onChange={(event) =>
                    setRecipeField("exclude", event.target.value)
                  }
                  className="font-mono"
                  disabled={pending}
                />
              </Field>
            </fieldset>
          ) : (
            valueField
          )}
        </form>
      ) : (
        valueField
      )}
      {browserSecret ? (
        // Not a form field a password manager fills: boxes for the sites
        // asked for, and a box of its own for more.
        <fieldset
          className="m-0 flex flex-col gap-3 border-0 p-0"
          data-1p-ignore
          data-lpignore="true"
        >
          <legend className="mb-2 text-sm font-medium">Sites</legend>
          <p className="m-0 text-sm text-muted-foreground">
            Where the browser may type it. Untick a site to leave it out.
          </p>
          {(secret?.origins ?? []).map((origin) => (
            <Label key={origin} className="font-normal">
              <Checkbox
                checked={kept.includes(origin)}
                onChange={(event) =>
                  setKept((current) =>
                    event.target.checked
                      ? [...current, origin]
                      : current.filter((other) => other !== origin),
                  )
                }
                disabled={pending}
              />
              <code className="break-all">{origin}</code>
            </Label>
          ))}
          <Field
            label="More sites (optional)"
            htmlFor={`permission-${id}-origins`}
            hint="One a line: https://example.com."
          >
            <Textarea
              id={`permission-${id}-origins`}
              value={moreOrigins}
              onChange={(event) => setMoreOrigins(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              className="min-h-16 font-mono"
              disabled={pending}
            />
          </Field>
        </fieldset>
      ) : null}
      {sites ? (
        <fieldset
          className="m-0 flex flex-col gap-3 border-0 p-0"
          data-1p-ignore
          data-lpignore="true"
        >
          <legend className="mb-2 text-sm font-medium">
            Changes to the sites of &quot;{sites.secretName}&quot;
          </legend>
          {sites.changes.map((change) => (
            <div key={change.key} className="flex flex-col gap-1">
              <Label className="items-start font-normal">
                <Checkbox
                  className="mt-0.5"
                  checked={siteKeep.includes(change.key)}
                  onChange={(event) =>
                    setSiteKeep((current) =>
                      event.target.checked
                        ? [...current, change.key]
                        : current.filter((key) => key !== change.key),
                    )
                  }
                  disabled={pending || change.noop || !sites.exists}
                />
                <span className="break-all">
                  {change.action === "add" ? "Add " : "Take away "}
                  <code>{change.origin}</code>
                  {change.subdomains ? " and its subdomains" : null}
                  {change.noop ? " (already so)" : null}
                </span>
              </Label>
              {change.lookalike ? (
                <p className="m-0 ml-6 text-sm text-destructive">
                  {change.lookalike}
                </p>
              ) : change.newDomain ? (
                <p className="m-0 ml-6 text-sm text-muted-foreground">
                  Another domain than its sites so far.
                </p>
              ) : null}
            </div>
          ))}
        </fieldset>
      ) : null}
      {access ? (
        <ProposedAccessEditor
          shown={access}
          rows={accessRows}
          onChange={setAccessRows}
          disabled={pending}
        />
      ) : null}
      {every ? (
        <List>
          <SwitchRow
            id={`permission-${id}-always`}
            label="Read in every conversation"
            description={
              <>
                {every.asked ? "The assistant asked for this. " : null}
                It comes with PCP&apos;s instructions, as your own words, so an
                assistant follows it from its first reply: every assistant if
                you share it, only this one if you keep it for this assistant.
              </>
            }
            checked={always}
            onChange={(event) => setAlways(event.target.checked)}
            disabled={pending}
          />
        </List>
      ) : null}
      {privateAddresses ? (
        <List>
          <SwitchRow
            id={`permission-${id}-private`}
            label="Allow private addresses"
            description="Its address is on your own network, or this machine's. Off, it reaches public addresses only and its calls are refused; turn it on only for a server you trust. You can change it later on its page, under Public addresses only."
            checked={allowPrivate}
            onChange={(event) => setAllowPrivate(event.target.checked)}
            disabled={pending}
          />
        </List>
      ) : null}
      <FormError error={error} />
      <PermissionActions
        note="Nothing runs until you answer. Then tell the assistant you have."
        others={others.map((decision) => (
          <Button
            key={decision.value}
            type="button"
            size="lg"
            variant="secondary"
            className={DECISION_BUTTON}
            disabled={pending}
            onClick={() => decide(decision.value)}
          >
            {labelOf(decision)}
          </Button>
        ))}
        beside={
          allowFor ? (
            <div className="flex gap-2 sm:items-center">
              <Button
                type="button"
                variant="secondary"
                className="flex-1 sm:flex-none"
                disabled={pending}
                onClick={() => decide(allowFor.value)}
              >
                {labelOf(allowFor)}
              </Button>
              <Select
                aria-label="How long"
                value={String(minutes)}
                onChange={(event) => setMinutes(Number(event.target.value))}
                disabled={pending}
                className="h-9 w-auto"
              >
                {ALLOW_FOR_MINUTES.map((option) => (
                  <option key={option} value={option}>
                    {allowForLabel(option)}
                  </option>
                ))}
              </Select>
            </div>
          ) : undefined
        }
        primary={
          primary ? (
            <Button
              type="button"
              size="lg"
              className={DECISION_BUTTON}
              disabled={pending}
              onClick={() => decide(primary.value)}
            >
              {labelOf(primary)}
            </Button>
          ) : undefined
        }
        quiet={quiet.map((decision) => (
          <Button
            key={decision.value}
            type="button"
            variant="plain"
            className={QUIET_DECISION}
            disabled={pending}
            onClick={() => decide(decision.value)}
          >
            {labelOf(decision)}
          </Button>
        ))}
      />
    </div>
  )
}
