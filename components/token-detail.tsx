"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { PermissionDecision } from "@/components/permission-decision"
import { ServerScopeFields } from "@/components/server-scope-fields"
import { ShownInFull } from "@/components/shown-in-full"
import { TokenOptionRow } from "@/components/token-options"
import {
  TokenSettingsForm,
  type TokenSettings,
} from "@/components/token-settings-form"
import { CountBadge } from "@/components/ui/badge"
import { Button, ButtonLink } from "@/components/ui/button"
import { Select } from "@/components/ui/input"
import { List, ListRow, ListSection } from "@/components/ui/list"
import {
  copyTokenAccessAction,
  deleteTokenAction,
  endAllowanceAction,
  revokeTokenAction,
} from "@/lib/actions/tokens"
import type { PermissionDecision as Decision } from "@/lib/core/constants"
import type { ShownText } from "@/lib/core/permission-rules"
import type { ServerKind } from "@/lib/core/servers"
import type { ActionState } from "@/lib/server/action-state"

export type WaitingRequest = {
  id: string
  /** Proposed tool levels are reviewed and saved on their own page. */
  review: boolean
  title: string
  lines: string[]
  /** Everything it carries, when the lines cut it short. */
  full: ShownText[] | null
  warning: string | null
  decisions: Array<{ value: Decision; label: string }>
  /** A new server's secret, typed in when agreeing to it. */
  secret: {
    name: string
    exists: boolean
    optional: boolean
    clientId: string | null
  } | null
  /** A memory to share: the toggle for reading it in every conversation. */
  every: { asked: boolean } | null
}

/** A tool or a site allowed for a while, as the page is handed it. */
export type AllowanceItem =
  | {
      kind: "tool"
      serverId: string
      serverName: string
      toolName: string
      until: string
    }
  | { kind: "site"; host: string; until: string }

/**
 * What an assistant using this token asked for and still waits on, first on
 * its page: each with the buttons that settle it.
 */
export function TokenWaiting({ waiting }: { waiting: WaitingRequest[] }) {
  return (
    <ListSection
      title={
        <span className="flex items-center gap-2 text-[17px] text-foreground">
          Waiting for you
          <CountBadge count={waiting.length} />
        </span>
      }
      description="An assistant using this token asked for these. Nothing runs until you answer."
    >
      <List as="ul" className="ring-1 ring-warning/25">
        {waiting.map((item) => (
          <li key={item.id} className="flex flex-col gap-3 px-4 py-4">
            <span className="text-[15px] font-medium break-words">
              {item.title}
            </span>
            {item.lines.length > 0 ? (
              <ul className="flex list-disc flex-col gap-1 pl-5 break-words whitespace-pre-wrap text-muted-foreground">
                {item.lines.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            ) : null}
            {item.full ? <ShownInFull parts={item.full} /> : null}
            {item.warning ? (
              <p
                className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive"
                role="note"
              >
                {item.warning}
              </p>
            ) : null}
            {item.review ? (
              <div>
                <ButtonLink href={`/permissions/${item.id}`}>
                  Review and save
                </ButtonLink>
              </div>
            ) : (
              <PermissionDecision
                id={item.id}
                decisions={item.decisions}
                secret={item.secret}
                every={item.every}
              />
            )}
          </li>
        ))}
      </List>
    </ListSection>
  )
}

/** Tools and sites the owner allowed for a while, each with "End now". */
export function TokenAllowances({
  tokenId,
  allowances,
}: {
  tokenId: string
  allowances: AllowanceItem[]
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionState>({ status: "idle" })

  function end(allowance: AllowanceItem) {
    startTransition(async () => {
      setResult(
        await endAllowanceAction(
          tokenId,
          allowance.kind === "site"
            ? { kind: "site", host: allowance.host }
            : {
                kind: "tool",
                serverId: allowance.serverId,
                toolName: allowance.toolName,
              },
        ),
      )
    })
  }

  return (
    <ListSection
      title="Allowed for now"
      description="What you allowed for a while when an assistant using this token asked. Until then it goes ahead without asking you; afterwards its levels decide again. A blocked tool or site stays blocked."
      footer={result.status === "error" ? result.error : undefined}
    >
      <List as="ul">
        {allowances.map((allowance) => (
          <ListRow
            as="li"
            key={
              allowance.kind === "site"
                ? `site:${allowance.host}`
                : `tool:${allowance.serverId}/${allowance.toolName}`
            }
            title={
              <span className="break-words">
                {allowance.kind === "site"
                  ? allowance.host
                  : `${allowance.serverName} · ${allowance.toolName}`}
              </span>
            }
            description={
              <>
                {allowance.kind === "site" ? "Site" : "Tool"}, until{" "}
                <LocalDate value={allowance.until} />
              </>
            }
            trailing={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => end(allowance)}
              >
                End now
              </Button>
            }
          />
        ))}
      </List>
    </ListSection>
  )
}

/**
 * "Reaches" and "Can also": the servers a token reaches and what it may do
 * besides running tools, saved together with one button.
 */
export function TokenReachForm({
  token,
  servers,
  locked,
  sites,
}: {
  token: TokenSettings
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  locked: boolean
  /** Where its web sites are listed, and how many; null when it has none. */
  sites: { href: string; count: number } | null
}) {
  return (
    <TokenSettingsForm
      token={token}
      shows={["scope", "keepMemories", "webFetch", "runCode"]}
      locked={locked}
      className="gap-8"
    >
      <ListSection title="Reaches">
        <List>
          <ServerScopeFields
            variant="rows"
            servers={servers}
            allowAll={token.allowAllServers}
            selected={token.servers.map((server) => server.id)}
          />
        </List>
      </ListSection>
      <ListSection title="Can also">
        <List>
          <TokenOptionRow
            option="keepMemories"
            id="token-memories"
            defaultChecked={token.keepMemories}
          />
          <TokenOptionRow
            option="webFetch"
            id="token-fetch"
            defaultChecked={token.webFetch}
            trailing={
              sites ? (
                <Link
                  href={sites.href}
                  className="shrink-0 text-[13px] text-primary"
                >
                  {sites.count === 0
                    ? "Sites"
                    : sites.count === 1
                      ? "1 site"
                      : `${sites.count} sites`}
                </Link>
              ) : null
            }
          />
          <TokenOptionRow
            option="runCode"
            id="token-code"
            defaultChecked={token.runCode}
          />
        </List>
      </ListSection>
    </TokenSettingsForm>
  )
}

/**
 * The last thing on a token's page: revoking it while it works, deleting
 * it from the list once it no longer does.
 */
export function TokenEnd({
  token,
}: {
  token: {
    id: string
    name: string
    revoked: boolean
    expired: boolean
    oauthClient: string | null
  }
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const dead = token.revoked || token.expired

  function revoke() {
    if (
      !window.confirm(
        token.oauthClient
          ? `Revoke "${token.name}"? ${token.oauthClient} is signed out at once.`
          : `Revoke "${token.name}"? Clients using it stop working at once.`,
      )
    ) {
      return
    }

    startTransition(async () => {
      const result = await revokeTokenAction(token.id)
      setError(result.status === "error" ? result.error : null)
      router.refresh()
    })
  }

  function remove() {
    startTransition(async () => {
      const result = await deleteTokenAction(token.id)

      if (result.status === "error") {
        setError(result.error)
      } else {
        router.push("/tokens")
      }
    })
  }

  return (
    <div className="flex flex-col items-center gap-1 pt-2 text-center">
      {dead ? (
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={remove}
        >
          Delete
        </Button>
      ) : (
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={revoke}
        >
          Revoke access
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {dead
          ? "It no longer works. Deleting it takes it off the list."
          : token.oauthClient
            ? `${token.oauthClient} is signed out at once. This can't be undone.`
            : "It stops working at once. This can't be undone."}
      </p>
      <FormError error={error} />
    </div>
  )
}

/** Gives this token another one's servers, tool levels and web settings. */
export function TokenCopyAccess({
  tokenId,
  otherTokens,
}: {
  tokenId: string
  otherTokens: Array<{ id: string; name: string }>
}) {
  const [source, setSource] = useState(otherTokens[0]?.id ?? "")
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionState>({ status: "idle" })

  function copy() {
    const name = otherTokens.find((token) => token.id === source)?.name ?? ""

    if (
      !window.confirm(
        `Replace this token's servers, tool access and web fetch settings with those of "${name}"?`,
      )
    ) {
      return
    }

    startTransition(async () => {
      setResult(await copyTokenAccessAction(tokenId, source))
    })
  }

  return (
    <ListRow
      title="Copy access from another token"
      description="Its servers, tool levels and web settings replace this one's. Levels for all tokens stay as they are."
      trailing={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Token to copy from"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="h-8 w-auto max-w-56 text-[13px]"
          >
            {otherTokens.map((token) => (
              <option key={token.id} value={token.id}>
                {token.name}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending || !source}
            onClick={copy}
          >
            {pending ? "Copying…" : "Copy access"}
          </Button>
          <FormError error={result.status === "error" ? result.error : null} />
          <FormNote message={result.status === "ok" ? "Copied." : null} />
        </div>
      }
    />
  )
}
