"use client"

import { Check, Copy, Lock, Plus, type LucideIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useActionState, useRef, useState, type FormEvent } from "react"

import { ChoiceCard } from "@/components/assistant-choice"
import { CopyableValue } from "@/components/copyable-value"
import { FormError } from "@/components/form-status"
import { OwnerConfirmFields } from "@/components/owner-confirm-fields"
import { ServerScopeFields } from "@/components/server-scope-fields"
import { SubmitButton } from "@/components/submit-button"
import { TokenOptionRow, TOKEN_OPTION_NAMES } from "@/components/token-options"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Disclosure } from "@/components/ui/disclosure"
import { Input, Select } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { createTokenAction, type CreateTokenResult } from "@/lib/actions/tokens"
import type { ServerKind } from "@/lib/core/servers"
import { cn } from "@/lib/utils"

type App = "claude-app" | "claude-code" | "other"

type Props = {
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  username: string
  /** PCP's address as assistants reach it (publicUrlFor, on the server). */
  publicUrl: string
}

/**
 * "Connect an assistant": a sheet in three steps. Which app, a name and what
 * it reaches (the rest folded under More options); the owner's password;
 * then the new API token, once, with what to paste into the app. Done (or
 * closing the sheet once the token exists) opens the token's page, where
 * the owner decides what it may run.
 *
 * The token travels from the action's answer to this sheet's state and
 * nowhere else: not into the URL, not into browser storage. Closed, it is
 * gone, which is the point: PCP keeps only a hash.
 */
export function ConnectAssistant(props: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  // A new round of steps each time the sheet opens.
  const [round, setRound] = useState(0)
  const made = useRef<string | null>(null)

  function openChange(next: boolean) {
    setOpen(next)

    if (next) {
      made.current = null
      setRound((value) => value + 1)
    }
  }

  // Leaving for the token's page once the sheet has finished closing: going
  // while it still closes leaves its inert layer over the next page.
  function closed(isOpen: boolean) {
    if (!isOpen && made.current) {
      router.push(`/tokens/${made.current}`)
    }
  }

  return (
    <Dialog open={open} onOpenChange={openChange} onOpenChangeComplete={closed}>
      <DialogTrigger className={buttonVariants()}>
        <Plus aria-hidden />
        Connect an assistant
      </DialogTrigger>
      <DialogContent>
        <ConnectSteps
          key={round}
          {...props}
          onMade={(id) => {
            made.current = id
          }}
          onDone={() => openChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function ConnectSteps({
  servers,
  username,
  publicUrl,
  onMade,
  onDone,
}: Props & { onMade: (id: string) => void; onDone: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3 | "connector">(1)
  const [app, setApp] = useState<App>("claude-app")
  // What the first step chose, while the second asks for the password.
  const [draft, setDraft] = useState<Array<[string, string]> | null>(null)
  const [state, action] = useActionState<CreateTokenResult, FormData>(
    async (previous, formData) => {
      const result = await createTokenAction(previous, formData)

      if (result.status === "ok") {
        onMade(result.id)
        setStep(3)
      }

      return result
    },
    { status: "idle" },
  )

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    // Claude's apps sign in at PCP and get their token on its consent
    // page: nothing to make here.
    if (app === "claude-app") {
      setStep("connector")
      return
    }

    const entries: Array<[string, string]> = []

    for (const [key, value] of new FormData(event.currentTarget)) {
      if (typeof value === "string" && key !== "app") entries.push([key, value])
    }

    setDraft(entries)
    setStep(2)
  }

  if (step === "connector") {
    return (
      <Connector
        endpoint={`${publicUrl}/mcp`}
        onBack={() => setStep(1)}
        onDone={onDone}
      />
    )
  }

  if (step === 3 && state.status === "ok") {
    return (
      <Ready
        app={app}
        token={state.token}
        endpoint={`${publicUrl}/mcp`}
        onDone={onDone}
      />
    )
  }

  if (step === 2 && draft) {
    return (
      // Two forms, so the one with the password holds the account and the
      // password and nothing else: next to a name field and a "Create"
      // button, Safari takes a password field for a sign-up and offers to
      // generate one, whatever its autocomplete says. The first step's
      // choices ride along as hidden fields.
      <form action={action} className="flex flex-col gap-5">
        <StepHeader
          step={2}
          icon={Lock}
          title="Confirm it's you"
          text="An API token is a lasting way into your vault, so PCP asks for your password before it makes one."
        />
        {draft.map(([key, value], index) => (
          <input key={index} type="hidden" name={key} value={value} />
        ))}
        <OwnerConfirmFields
          idPrefix="token"
          username={username}
          error={state.status === "error" ? state.error : null}
          autoFocus
        />
        <FormError error={state.status === "error" ? state.error : null} />
        <DialogFooter className="justify-between">
          <Button type="button" variant="secondary" onClick={() => setStep(1)}>
            Back
          </Button>
          <SubmitButton pendingText="Checking…">Create token</SubmitButton>
        </DialogFooter>
      </form>
    )
  }

  const chosen = (key: string) =>
    draft?.find(([name]) => name === key)?.[1] ?? null
  const ticked = (key: string) => draft?.some(([name]) => name === key) ?? false
  const moreChosen =
    TOKEN_OPTION_NAMES.some(ticked) || Boolean(chosen("expiresIn"))

  return (
    <form onSubmit={review} className="flex flex-col gap-6">
      <StepHeader
        step={1}
        of={app === "claude-app" ? 2 : 3}
        title="Connect an assistant"
        text="Each assistant gets an API token of its own, so you can see and stop each one on its own."
      />

      <fieldset className="m-0 flex flex-col gap-2">
        <legend className="mb-2 text-[13px] font-semibold text-muted-foreground">
          Which app?
        </legend>
        <ChoiceCard
          name="app"
          value="claude-app"
          checked={app === "claude-app"}
          onChoose={() => setApp("claude-app")}
          title="Claude app (desktop, web or phone)"
          caption="Add PCP as a custom connector; you allow it on PCP's page"
        />
        <ChoiceCard
          name="app"
          value="claude-code"
          checked={app === "claude-code"}
          onChoose={() => setApp("claude-code")}
          title="Claude Code"
          caption="Set up with one command in a terminal"
        />
        <ChoiceCard
          name="app"
          value="other"
          checked={app === "other"}
          onChoose={() => setApp("other")}
          title="Another MCP client"
          caption="Any app that takes an address and a bearer token"
        />
      </fieldset>

      {app === "claude-app" ? (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Claude signs in at PCP. You choose its name, what it can reach and
          what else it may do on PCP&apos;s own page when it asks, and its token
          never passes through you.
        </p>
      ) : (
        <TokenFields
          app={app}
          servers={servers}
          chosen={chosen}
          ticked={ticked}
          moreChosen={moreChosen}
          serverIds={(draft ?? [])
            .filter(([name]) => name === "serverIds")
            .map(([, value]) => value)}
        />
      )}

      <DialogFooter>
        <DialogClose className={buttonVariants({ variant: "secondary" })}>
          Cancel
        </DialogClose>
        <Button type="submit">Continue</Button>
      </DialogFooter>
    </form>
  )
}

/** The first step's fields for a token made here: name, reach, options. */
function TokenFields({
  app,
  servers,
  chosen,
  ticked,
  moreChosen,
  serverIds,
}: {
  app: App
  servers: Props["servers"]
  serverIds: string[]
  chosen: (key: string) => string | null
  ticked: (key: string) => boolean
  moreChosen: boolean
}) {
  return (
    <>
      <Field
        label="Name"
        htmlFor="token-name"
        hint="You'll see it on every request it makes."
      >
        <Input
          id="token-name"
          name="name"
          autoComplete="off"
          required
          maxLength={80}
          defaultValue={chosen("name") ?? ""}
          placeholder={
            app === "claude-code" ? "Claude Code on my laptop" : "My assistant"
          }
        />
      </Field>

      <ServerScopeFields
        servers={servers}
        allowAll={chosen("access") !== "selected"}
        selected={serverIds}
      />

      <Disclosure
        title="More options"
        description="Expiry, memories, web pages, code, API endpoints, wrappers"
        defaultOpen={moreChosen}
        className="bg-field"
        contentClassName="gap-0 divide-y divide-separator p-0"
      >
        {TOKEN_OPTION_NAMES.map((option) => (
          <TokenOptionRow
            key={option}
            option={option}
            id={`token-${option}`}
            defaultChecked={ticked(option)}
          />
        ))}
        <div className="flex min-h-14 flex-wrap items-center gap-3.5 px-4 py-2.5">
          <label
            htmlFor="token-expires"
            className="flex min-w-0 flex-1 flex-col gap-0.5"
          >
            <span className="text-[15px]">Expires</span>
            <span className="text-xs text-muted-foreground">
              You can change it later on its page.
            </span>
          </label>
          <Select
            id="token-expires"
            name="expiresIn"
            defaultValue={chosen("expiresIn") ?? ""}
            className="h-9 w-auto"
          >
            <option value="">Never</option>
            <option value="7">In 7 days</option>
            <option value="30">In 30 days</option>
            <option value="90">In 90 days</option>
            <option value="365">In a year</option>
          </Select>
        </div>
      </Disclosure>
    </>
  )
}

/**
 * For Claude's apps: PCP's address to add as a custom connector. The app
 * signs in at PCP with OAuth, and the owner makes its token on PCP's
 * consent page (app/oauth/authorize), so nothing is made here.
 */
function Connector({
  endpoint,
  onBack,
  onDone,
}: {
  endpoint: string
  onBack: () => void
  onDone: () => void
}) {
  const https = endpoint.startsWith("https://")

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        step={2}
        of={2}
        title="Add PCP to Claude"
        text="Claude signs in at PCP, so there is no token to copy."
      />
      <div className="flex flex-col gap-2">
        <p className="text-[13px] font-semibold text-muted-foreground">
          Connection address
        </p>
        <CopyableValue value={endpoint} label="Copy address" />
      </div>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-relaxed">
        <li>In Claude, add a custom connector with this address.</li>
        <li>
          Claude opens PCP&apos;s own page to ask you. Choose what it can reach
          there, and allow it with your password.
        </li>
        <li>
          It then shows up here as signed in from Claude, with a page of its
          own.
        </li>
      </ol>
      {https ? null : (
        <p
          role="note"
          className="rounded-lg bg-warning/10 px-3 py-2 text-[13px] text-warning"
        >
          Claude has to reach PCP at a public https address. Set one up under
          Settings (a pcp.gg name, or your own with HTTPS) first.
        </p>
      )}
      <DialogFooter className="justify-between">
        <Button type="button" variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  )
}

function StepHeader({
  step,
  of = 3,
  icon: Icon,
  tone = "neutral",
  title,
  text,
}: {
  step: 1 | 2 | 3
  /** How many steps this way has: 2 for a Claude app, 3 for a token. */
  of?: 2 | 3
  icon?: LucideIcon
  tone?: "neutral" | "done"
  title: string
  text: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5",
        Icon && "items-center pt-1 text-center",
      )}
    >
      {Icon ? (
        <span
          aria-hidden
          className={cn(
            "mb-2 flex size-14 items-center justify-center",
            tone === "done"
              ? "rounded-full bg-[#1f4a44] text-[#9ff0e3]"
              : "rounded-2xl bg-secondary text-foreground",
          )}
        >
          <Icon className="size-7" strokeWidth={tone === "done" ? 2.2 : 1.7} />
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground">
        Step {step} of {of}
      </span>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription className="max-w-md">{text}</DialogDescription>
    </div>
  )
}

/** The last step: the token, once, and what to paste where. */
function Ready({
  app,
  token,
  endpoint,
  onDone,
}: {
  app: App
  token: string
  endpoint: string
  onDone: () => void
}) {
  const command = `claude mcp add --transport http pcp ${endpoint} --header "Authorization: Bearer ${token}"`

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        step={3}
        icon={Check}
        tone="done"
        title="Ready to connect"
        text="Copy it now: the token is shown only once, and PCP keeps only a hash of it."
      />

      {app === "claude-code" ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-semibold text-muted-foreground">
            Run this in a terminal
          </p>
          <pre className="m-0 rounded-xl border border-separator bg-[#0d1015] px-4 py-3.5 font-mono text-[12.5px] leading-relaxed break-all whitespace-pre-wrap text-[#cfe9e5]">
            claude mcp add --transport http pcp {endpoint} --header
            &quot;Authorization: Bearer{" "}
            <span data-testid="new-token">{token}</span>&quot;
          </pre>
          <CopyButton value={command} label="Copy command" primary />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="overflow-hidden rounded-xl border border-separator bg-field">
            <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="w-16 text-xs text-muted-foreground">
                Address
              </span>
              <code className="min-w-0 flex-1 text-[13px] break-all">
                {endpoint}
              </code>
              <CopyButton value={endpoint} label="Copy address" />
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-separator px-4 py-2.5">
              <span className="w-16 text-xs text-muted-foreground">Token</span>
              <code
                className="min-w-0 flex-1 text-[13px] break-all"
                data-testid="new-token"
              >
                {token}
              </code>
              <CopyButton value={token} label="Copy token" />
            </div>
          </div>
          <p className="px-1 text-xs text-muted-foreground">
            Send it as <code>Authorization: Bearer</code> over Streamable HTTP.
          </p>
        </div>
      )}

      <p className="text-center text-xs text-muted-foreground">
        Then choose on its page what it may run. Until you do, each tool asks
        you the first time.
      </p>

      <DialogFooter>
        <Button
          type="button"
          variant={app === "claude-code" ? "secondary" : "default"}
          onClick={onDone}
        >
          Done
        </Button>
      </DialogFooter>
    </div>
  )
}

function CopyButton({
  value,
  label,
  primary = false,
}: {
  value: string
  label: string
  primary?: boolean
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked (plain http, permissions): the value is on
      // screen to select by hand.
    }
  }

  return (
    <Button
      type="button"
      variant={primary ? "default" : "secondary"}
      size={primary ? "default" : "sm"}
      onClick={copy}
      className={cn(primary && "w-full")}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "Copied" : label}
    </Button>
  )
}
