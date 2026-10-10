import type { ReactNode } from "react"

import { Switch, SwitchRow } from "@/components/ui/switch"

/**
 * What a token may do besides running its tools: each is a form field of
 * the same name (`on` when ticked), read by createTokenAction,
 * updateTokenAction and the sign-in consent.
 */
export type TokenOption =
  "keepMemories" | "webFetch" | "runCode" | "manageEndpoints" | "manageWrappers"

export const TOKEN_OPTION_NAMES: readonly TokenOption[] = [
  "keepMemories",
  "webFetch",
  "runCode",
  "manageEndpoints",
  "manageWrappers",
]

/**
 * Each option's words: `label` and `caption` for a row on the assistant's
 * pages and in the connect dialog; `ask` and `detail` for the consent page,
 * where an app asks to sign in and the owner reads the whole of it.
 */
export const TOKEN_OPTIONS: Record<
  TokenOption,
  { label: string; caption: string; ask: string; detail: string }
> = {
  keepMemories: {
    label: "Keep memories",
    caption:
      "Its own notes between conversations. Sharing one with every assistant still asks you.",
    ask: "Let an assistant with this token keep memories",
    detail:
      "It can keep notes for itself between conversations, and read the memories you share with all your assistants. To share one of its own, or change a shared one, it has to ask you, and you see the whole text first. You can read, edit and delete every memory under Memories.",
  },
  webFetch: {
    label: "Read web pages",
    caption: "Each new site asks you the first time. Never with your secrets.",
    ask: "Let an assistant with this token fetch web pages",
    detail:
      "It gets a web_fetch tool that reads public web pages (as Markdown) and can send other requests. You decide per method and per site on the token's page; a site it has not reached before asks you first unless you allow that method everywhere. It never sends your secrets, and never reaches addresses on your own network.",
  },
  runCode: {
    label: "Run code",
    caption:
      "Short programs inside PCP, using only its own tools at their levels.",
    ask: "Let an assistant with this token run code that calls its tools",
    detail:
      "It gets a run_code tool: a short JavaScript program, run inside PCP, that calls this token's tools and filters or passes on what they answer, so large answers never have to pass through the assistant. Every call follows the token's levels: a tool that asks you first stops the program until you answer, and a blocked tool stays blocked. The program reaches nothing else: no network, no files, and never your secrets.",
  },
  manageEndpoints: {
    label: "Manage API endpoints",
    caption:
      "Read endpoints, and change one it proposed. It never sees or changes a secret.",
    ask: "Let an assistant with this token read and change API endpoints",
    detail:
      "It can read an endpoint, and edit one it proposed while that sends no secret and reaches public addresses only. Once it sends a secret, or you allow private addresses, the endpoint is yours: it can only read it and turn read-only on. A change it makes to its own switches the endpoint off until you enable it again. It can never see or change a secret. Leave this off unless the assistant needs it.",
  },
  manageWrappers: {
    label: "Propose wrappers",
    caption:
      "Simpler tools on top of your other tools. You read every program first.",
    ask: "Let an assistant with this token propose wrappers",
    detail:
      "A wrapper is a set of tools the assistant writes over your other tools: short programs that make a long-winded server simpler to use, and can put one of your secrets where an API wants it in its arguments. You read every program and decide; nothing changes until you agree, and a wrapper never reaches a tool the calling token could not.",
  },
}

/** One option as a row of a List: the short label, the switch at the right. */
export function TokenOptionRow({
  option,
  id,
  defaultChecked = false,
  label,
  caption,
  trailing,
  disabled,
}: {
  option: TokenOption
  id: string
  defaultChecked?: boolean
  /** In place of the option's own label (the Advanced page's wording). */
  label?: ReactNode
  caption?: ReactNode | null
  trailing?: ReactNode
  disabled?: boolean
}) {
  const words = TOKEN_OPTIONS[option]

  return (
    <SwitchRow
      id={id}
      name={option}
      label={label ?? words.label}
      description={caption === undefined ? words.caption : caption}
      defaultChecked={defaultChecked}
      trailing={trailing}
      disabled={disabled}
    />
  )
}

/**
 * One option as a field on its own, with the whole explanation under it:
 * for the page where an app signing in asks for a token.
 */
export function TokenOptionField({
  option,
  id,
  defaultChecked = false,
}: {
  option: TokenOption
  id: string
  defaultChecked?: boolean
}) {
  const words = TOKEN_OPTIONS[option]

  return (
    <div className="flex items-start gap-3.5">
      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm text-foreground">{words.ask}</span>
        <span className="text-xs leading-relaxed text-muted-foreground">
          {words.detail}
        </span>
      </label>
      <Switch id={id} name={option} defaultChecked={defaultChecked} />
    </div>
  )
}
