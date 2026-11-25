import { openOrigin, siteLabel } from "./browser-secrets"
import type { VaultContext } from "./context"
import { db } from "./db"
import { openWrapperSpec, WRAPPER_SPEC_SELECT } from "./spec-rows"
import { SERVER_META_SELECT, serverName, serverSlug } from "./server-meta"
import { openSecretDetails, type SecretKind } from "./secrets"
import { readEnvBindings } from "./services/definition"
import { readDefinition } from "./wrappers/definition"
import { readRepoState } from "./repos/store"
import {
  byName,
  openSecretMeta,
  SECRET_META_SELECT,
  secretName,
} from "./secret-meta"

/**
 * What uses each secret, the one reading of it (#162): the owner's Secrets
 * page (secrets.ts listSecrets), list_secrets (listSecretNames), what a
 * register request says a reused secret is already used by, and what
 * deleteSecret refuses under. Never a value: nothing here selects a value's
 * ciphertext or decrypts one.
 */

/** How something uses a secret. */
export type SecretUseVia =
  /** A server's own header or basic login (a mail or calendar account's too). */
  | "auth"
  /** A server's further header. */
  | "header"
  /** Its OAuth client's secret. */
  | "oauth_client"
  /** Its OAuth tokens, which PCP keeps for it. */
  | "oauth_tokens"
  /** A service's variable. */
  | "service_env"
  /** A wrapper's place for a secret. */
  | "wrapper_binding"
  /** A linked repository's sign-in to GitHub. */
  | "repo"
  /** The vault's Google sign-in: its client's secret. */
  | "google_account"

/**
 * Something that uses a secret: a server that sends it, a wrapper with a
 * place for it, a service whose variable takes it, or a linked repository
 * that signs in with it.
 */
export type SecretUse = {
  /** The server's id, or the linked repository's. */
  id: string
  name: string
  /** A server's short name, or a repository's owner/name. */
  slug: string
  /** In plain words: "server", "API endpoint", "mail account", … */
  kind: string
  via: SecretUseVia
  /** Not a server: the vault's Google sign-in, which has no server row. */
  account?: true
}

/** Everything that uses one secret, and the sites the browser types it at. */
export type SecretUsage = {
  uses: SecretUse[]
  /** "<origin>", or "<origin> and its subdomains", sorted. */
  sites: string[]
}

const KIND_WORDS: Record<string, string> = {
  mcp: "server",
  openapi: "API endpoint",
  jmap: "mail account",
  imap: "mail account",
  caldav: "calendar account",
  ssh: "SSH server",
  wrapper: "wrapper",
  service: "service",
}

export function kindWords(kind: string): string {
  return KIND_WORDS[kind] ?? "server"
}

const SERVER = { ...SERVER_META_SELECT, kind: true } as const

/** The vault's Google sign-in as something that uses a secret. */
function googleUse(id: string, via: SecretUseVia): SecretUse {
  return {
    id,
    name: "Google account",
    slug: "google",
    kind: "Google account",
    via,
    account: true,
  }
}

/**
 * What uses each of these secrets, by secret id: every server that sends
 * one or keeps its OAuth tokens or client secret in it (mail and calendar
 * accounts included), every service whose variable takes it, every
 * wrapper whose definition has a place for it, every linked repository
 * that signs in with it; and the sites the browser types it at. All of the
 * vault's secrets when `ids` is left out.
 */
export async function secretUses(
  ctx: VaultContext,
  ids?: string[],
  /**
   * Counts the wrapper definitions that did not read, whose uses are
   * missing from the answer: a caller that decides on "nothing uses it"
   * (secret-scope.ts) waits until they read.
   */
  report?: { unread: number },
): Promise<Map<string, SecretUsage>> {
  const rows = await db().secret.findMany({
    where: { vaultId: ctx.vaultId, ...(ids ? { id: { in: ids } } : {}) },
    select: {
      id: true,
      authFor: { select: SERVER },
      authHeaderFor: { select: { server: { select: SERVER } } },
      oauthClientFor: { select: SERVER },
      oauthTokensFor: { select: SERVER },
      repos: true,
      accountClientFor: { select: { id: true } },
      accountTokensFor: { select: { id: true } },
      browserOrigins: {
        select: {
          secretId: true,
          origin: true,
          sealed: true,
          includeSubdomains: true,
        },
      },
    },
  })
  // By secret, then by what uses it, so a server that uses one twice (a
  // header and its OAuth client) is named once.
  const uses = new Map<string, Map<string, SecretUse>>(
    rows.map((row) => [row.id, new Map()]),
  )
  const add = (secretId: string, use: SecretUse) => {
    const found = uses.get(secretId)
    const key = `${use.via === "repo" ? "repo" : use.via === "google_account" ? "account" : "server"}:${use.id}`

    if (found && !found.has(key)) {
      found.set(key, use)
    }
  }
  const server = (
    row: Parameters<typeof serverName>[1] & { kind: string },
    via: SecretUseVia,
  ): SecretUse => ({
    id: row.id,
    name: serverName(ctx, row),
    slug: serverSlug(ctx, row),
    kind: kindWords(row.kind),
    via,
  })

  for (const row of rows) {
    for (const each of row.authFor) add(row.id, server(each, "auth"))
    for (const each of row.authHeaderFor) {
      add(row.id, server(each.server, "header"))
    }
    for (const each of row.oauthClientFor) {
      add(row.id, server(each, "oauth_client"))
    }
    for (const each of row.oauthTokensFor) {
      add(row.id, server(each, "oauth_tokens"))
    }
    // The Google sign-in: not a server, so named as itself. Its tokens are
    // kept in a managed secret, which deleting disconnects (not blocking).
    for (const account of row.accountClientFor) {
      add(row.id, googleUse(account.id, "google_account"))
    }
    for (const account of row.accountTokensFor) {
      add(row.id, googleUse(account.id, "oauth_tokens"))
    }
    for (const repo of row.repos) {
      let slug: string

      try {
        const state = readRepoState(ctx, repo)
        slug = `${state.owner}/${state.name}`
      } catch {
        // One that does not open is still a use, by no name.
        slug = "a linked repository"
      }

      add(row.id, {
        id: repo.id,
        name: slug,
        slug,
        kind: "linked repository",
        via: "repo",
      })
    }
  }

  const wrappers = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, kind: "wrapper" },
    select: { ...SERVER, wrapperSpec: { select: WRAPPER_SPEC_SELECT } },
  })

  for (const wrapper of wrappers) {
    if (!wrapper.wrapperSpec) {
      continue
    }

    let bound: Array<string | null>

    try {
      bound = readDefinition(
        openWrapperSpec(ctx, wrapper.wrapperSpec).definition,
      ).secrets.map((binding) => binding.secretId)
    } catch {
      // A definition that does not read is no use of anything here; a
      // caller that needs to know is told.
      if (report) report.unread += 1
      continue
    }

    for (const secretId of bound) {
      if (secretId) {
        add(secretId, server(wrapper, "wrapper_binding"))
      }
    }
  }

  const services = await db().serviceSpec.findMany({
    where: { server: { vaultId: ctx.vaultId } },
    select: { env: true, server: { select: SERVER } },
  })

  for (const service of services) {
    for (const secretId of Object.values(readEnvBindings(service.env))) {
      add(secretId, server(service.server, "service_env"))
    }
  }

  return new Map(
    rows.map((row) => [
      row.id,
      {
        uses: [...uses.get(row.id)!.values()].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
        sites: row.browserOrigins
          .map((site) => ({
            origin: openOrigin(ctx, site),
            subdomains: site.includeSubdomains,
          }))
          .sort((a, b) =>
            a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0,
          )
          .map(siteLabel),
      },
    ]),
  )
}

/**
 * The uses a secret cannot be deleted under: all of them but the server
 * whose OAuth tokens it holds (deleting it disconnects that server), and
 * for PCP's GitHub sign-in, the linked repositories that use it (they read
 * without it, as public ones).
 */
export function blockingUses(
  usage: SecretUsage | undefined,
  kind: string,
): SecretUse[] {
  return (usage?.uses ?? []).filter(
    (use) =>
      use.via !== "oauth_tokens" && !(kind === "oauth" && use.via === "repo"),
  )
}

/** "A, B and C", or "A, B, C and 4 more" past `max`. */
export function namesInWords(names: string[], max = 5): string {
  const shown = names.slice(0, max)
  const more = names.length - shown.length

  if (more > 0) {
    return `${shown.join(", ")} and ${more} more`
  }

  return shown.length <= 1
    ? (shown[0] ?? "")
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`
}

export const MAX_LISTED_SECRETS = 100
export const MAX_LISTED_USES = 20
export const MAX_SECRET_QUERY = 100

const KIND_SHOWN: Record<SecretKind, string> = {
  text: "text",
  totp: "one-time codes (TOTP), typed by the browser only",
  oauth: "OAuth sign-in (kept by PCP for a server)",
  ssh_key: "SSH key (PCP's own, for an SSH server)",
  proxy_password: "proxy password (PCP's own, for a VPN service's exit)",
  generated: "a value PCP made for a service (PCP's own)",
}

export type ListedSecret = {
  name: string
  description: string
  kind: string
  /** Whether naming it in register_server sends it rather than a new one. */
  reusable: boolean
  usedBy: Array<Pick<SecretUse, "name" | "slug" | "kind">>
  /** Further uses past MAX_LISTED_USES. */
  moreUses?: number
  /**
   * The sites the browser may type it at (SecretBrowserOrigin): an origin,
   * or "<origin> and its subdomains".
   */
  sites?: string[]
  /** The owner's login name for the sign-in it is the password of. */
  login_name?: string
  /** The owner's note on it. */
  note?: string
  /** The TOTP secret whose code goes with it, by name. */
  totp?: string
}

/**
 * The vault's secrets as a token that manages endpoints sees them: names,
 * descriptions, kinds and what uses each, and for the owner's own the
 * sign-in they belong to, where the owner said. Never a value or a date.
 */
export async function listSecretNames(
  ctx: VaultContext,
  query?: string,
): Promise<{ secrets: ListedSecret[]; more: number }> {
  const needle = query?.trim().toLowerCase().slice(0, MAX_SECRET_QUERY) ?? ""
  const rows = (
    await db().secret.findMany({
      where: { vaultId: ctx.vaultId },
      select: {
        ...SECRET_META_SELECT,
        kind: true,
        loginName: true,
        note: true,
        totpCompanion: { select: SECRET_META_SELECT },
      },
    })
  )
    .map((row) => ({ ...row, ...openSecretMeta(ctx, row) }))
    // Kind descending, then name: sorted here, since the names are sealed.
    .sort((a, b) =>
      a.kind === b.kind ? byName(a, b) : a.kind < b.kind ? 1 : -1,
    )
    .filter(
      (row) =>
        !needle ||
        row.name.toLowerCase().includes(needle) ||
        row.description.toLowerCase().includes(needle),
    )
  const shown = rows.slice(0, MAX_LISTED_SECRETS)
  const uses = await secretUses(
    ctx,
    shown.map((row) => row.id),
  )

  return {
    secrets: shown.map((row) => {
      const usage = uses.get(row.id)
      // As list_secrets has always named them: by name, short name and kind.
      const usedBy = (usage?.uses ?? []).map(({ name, slug, kind }) => ({
        name,
        slug,
        kind,
      }))
      const kind = (row.kind in KIND_SHOWN ? row.kind : "text") as SecretKind
      const { loginName, note } = openSecretDetails(ctx, row)
      const sites = usage?.sites ?? []

      return {
        name: row.name,
        description: row.description,
        kind: KIND_SHOWN[kind],
        reusable: kind === "text",
        usedBy: usedBy.slice(0, MAX_LISTED_USES),
        ...(usedBy.length > MAX_LISTED_USES
          ? { moreUses: usedBy.length - MAX_LISTED_USES }
          : {}),
        ...(sites.length > 0 ? { sites } : {}),
        ...(loginName ? { login_name: loginName } : {}),
        ...(note ? { note } : {}),
        ...(row.totpCompanion
          ? { totp: secretName(ctx, row.totpCompanion) }
          : {}),
      }
    }),
    more: rows.length - shown.length,
  }
}
