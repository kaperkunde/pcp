import { createHash } from "node:crypto"

import {
  bindOrigin,
  checkSecretSitesChange,
  showSecretSitesChange,
  siteLabel,
  sitesOf,
  unbindOrigin,
  type SecretSiteChangeShown,
} from "./browser-secrets"
import type { ProposedSecretSite } from "./browser/types"
import {
  DEFAULT_PASSWORD_RECIPE,
  DEFAULT_TOKEN_RECIPE,
  type PasswordRecipe,
} from "./constants"
import type { VaultContext } from "./context"
import { db } from "./db"
import { invalid, isPcpError, PcpError } from "./errors"
import {
  checkPasswordRecipe,
  describeRecipe,
  generatePassword,
} from "./generate-password"
import { hiddenCharacter, withoutPresentation } from "./memories"
import {
  openSecretMeta,
  SECRET_META_SELECT,
  secretName,
  secretNameWhere,
} from "./secret-meta"
import {
  grantSecretScope,
  readSecretScopes,
  removeFromSecretScope,
  SCOPE_KINDS,
  type SecretScopeConsumer,
} from "./secret-scope"
import {
  blockingUses,
  namesInWords,
  secretUses,
  type SecretUse,
} from "./secret-uses"
import {
  checkLoginName,
  checkSecretNote,
  deleteSecret,
  isOwnerSecretKind,
  openSecretDetails,
  secretNameTaken,
  updateSecret,
  validateSecretName,
  validateSecretValue,
} from "./secrets"
import { SERVER_META_SELECT, serverName, serverSlug } from "./server-meta"
import { openWrapperSpec, WRAPPER_SPEC_SELECT } from "./spec-rows"
import { readDefinition } from "./wrappers/definition"
import { secretLiterals } from "./wrappers/secret-literals"
import { MAX_SECRET_PURPOSE_CHARS } from "./browser/limits"

/**
 * An assistant's proposals about one of the owner's secrets (#162): edit
 * (name, description, login name, note), rotate (a new value, typed by the
 * owner or made by PCP), change its scope (sites, and the servers,
 * services and wrappers that may name it) and delete. Each is a
 * `secret_change` request that always asks, whatever the token's levels;
 * the page shows the secret before and after and what uses it, and the
 * owner's yes writes only what they were shown, while the secret is as it
 * was when asked (`basis`). The value never reaches the assistant, and
 * nothing an assistant sends writes a value or widens a scope.
 *
 * Managed secrets (an OAuth sign-in, an SSH key, a proxy password, a value
 * PCP made for a service) are PCP's own for one thing: refused before the
 * owner is asked, with what changes them.
 */

export type SecretChangeAction = "edit" | "rotate" | "scope" | "delete"

/** The tool that asked, which the request is named after. */
export type SecretChangeVia =
  | "edit_secret"
  | "rotate_secret"
  | "change_secret_scope"
  | "delete_secret"
  /** The browser's alias of change_secret_scope, for one release. */
  | "update_secret_sites"

export type SecretChangeAsk = {
  /** The browser whose update_secret_sites asked, or null for PCP's own tools. */
  serverId: string | null
  action: SecretChangeAction
  via: SecretChangeVia
  secretId: string
  /** Its name when asked. */
  secretName: string
  reason: string
  /** The secret as it was when asked (secretBasis). */
  basis: string
  /** edit: each field it changes, as it would be; null takes it away. */
  edit?: {
    name?: string
    description?: string
    loginName?: string | null
    note?: string | null
  }
  /** rotate: the value the assistant asked PCP to make, if any. */
  generate?: PasswordRecipe | null
  /** scope: sites and consumers to add or take away. */
  scope?: {
    addSites: ProposedSecretSite[]
    removeSites: string[]
    addServers: Array<{ id: string; name: string }>
    removeServers: Array<{ id: string; name: string }>
  }
}

export const MAX_SCOPE_CHANGES = 20

/** Why PCP's own secrets are not the assistant's to change, by kind. */
function managedRefusal(kind: string, name: string): string {
  switch (kind) {
    case "oauth":
      return `"${name}" is the sign-in PCP keeps for a server it connected through OAuth: it changes when the owner connects that server again on its page, and goes with the server.`
    case "ssh_key":
      return `"${name}" is the key PCP made to sign in to an SSH server: the owner makes a new one on that server's page.`
    case "proxy_password":
      return `"${name}" is the password PCP made for a VPN service's exit: it changes when the owner makes the service again, and goes with it.`
    default:
      return `"${name}" is a value PCP made for a service's variable: it belongs to that service and goes with it.`
  }
}

const SECRET_ROW = {
  ...SECRET_META_SELECT,
  kind: true,
  ciphertext: true,
  loginName: true,
  note: true,
  totpCompanionId: true,
  scopeAnywhere: true,
} as const

async function loadById(ctx: VaultContext, id: string) {
  return db().secret.findFirst({
    where: { id, vaultId: ctx.vaultId },
    select: SECRET_ROW,
  })
}

type SecretRow = NonNullable<Awaited<ReturnType<typeof loadById>>>

/**
 * A key for the secret as it is now, read without opening its value: its
 * sealed name, description, login name and note, a hash of its value's
 * ciphertext, its scope and its sites. Any change to any of them (by the
 * owner or another request) changes it.
 */
export async function secretBasis(
  ctx: VaultContext,
  secretId: string,
): Promise<string | null> {
  const row = await loadById(ctx, secretId)

  if (!row) {
    return null
  }

  const [scope, sites] = await Promise.all([
    db().secretScope.findMany({
      where: { secretId },
      select: { serverId: true },
    }),
    db().secretBrowserOrigin.findMany({
      where: { secretId },
      select: { origin: true, includeSubdomains: true },
    }),
  ])
  const hex = (bytes: Uint8Array | null) =>
    bytes ? createHash("sha256").update(bytes).digest("hex") : null

  return createHash("sha256")
    .update(
      JSON.stringify([
        row.kind,
        hex(row.meta),
        row.plainName,
        row.plainDescription,
        hex(row.ciphertext),
        hex(row.loginName),
        hex(row.note),
        row.totpCompanionId,
        row.scopeAnywhere,
        scope.map((each) => each.serverId).sort(),
        sites.map((site) => [site.origin, site.includeSubdomains]).sort(),
      ]),
    )
    .digest("base64url")
    .slice(0, 22)
}

/** One of the owner's secrets by name, or a refusal in words. */
async function ownerSecret(
  ctx: VaultContext,
  name: string,
): Promise<SecretRow | string> {
  const named = name.trim()
  const row = await db().secret.findFirst({
    where: secretNameWhere(ctx, named),
    select: SECRET_ROW,
  })

  if (!row) {
    return `There is no secret called "${named}". list_secrets names the owner's secrets; request_secret asks for a new one.`
  }

  if (!isOwnerSecretKind(row.kind)) {
    return `${managedRefusal(row.kind, secretName(ctx, row))} Nothing was asked.`
  }

  return row
}

function checkReason(input: string): string {
  const reason = withoutPresentation(input).trim()
  const hidden = hiddenCharacter(reason)

  if (!reason) {
    throw invalid("Say why, in reason.")
  }

  if (hidden) {
    throw invalid(
      `The reason has a character that does not show on screen (${hidden}); write it in plain text.`,
    )
  }

  if (reason.length > MAX_SECRET_PURPOSE_CHARS) {
    throw invalid(
      `Keep the reason under ${MAX_SECRET_PURPOSE_CHARS} characters.`,
    )
  }

  return reason
}

/** Runs a prepare step: a PcpError is the assistant's to fix, in words. */
async function refusedIn<T>(
  run: () => Promise<T>,
): Promise<T | { refused: string }> {
  try {
    return await run()
  } catch (error) {
    if (isPcpError(error)) {
      return { refused: error.message }
    }

    throw error
  }
}

async function base(
  ctx: VaultContext,
  row: SecretRow,
  reason: string,
): Promise<
  Pick<SecretChangeAsk, "secretId" | "secretName" | "reason" | "basis">
> {
  return {
    secretId: row.id,
    secretName: secretName(ctx, row),
    reason: checkReason(reason),
    basis: (await secretBasis(ctx, row.id))!,
  }
}

// ---- edit_secret ----------------------------------------------------------

export type SecretEditArgs = {
  name: string
  reason: string
  new_name?: string
  description?: string
  login_name?: string
  note?: string
}

export async function prepareSecretEdit(
  ctx: VaultContext,
  args: SecretEditArgs,
): Promise<{ ask: SecretChangeAsk } | { refused: string }> {
  const row = await ownerSecret(ctx, args.name)

  if (typeof row === "string") {
    return { refused: row }
  }

  return refusedIn(async () => {
    const meta = openSecretMeta(ctx, row)
    const details = openSecretDetails(ctx, row)
    const edit: NonNullable<SecretChangeAsk["edit"]> = {}

    if (args.new_name !== undefined) {
      const name = args.new_name.trim()
      const problem = validateSecretName(name)

      if (problem) {
        throw invalid(`The new name: ${problem}`)
      }

      if (name !== meta.name) {
        if (await secretNameTaken(ctx, name, row.id)) {
          throw new PcpError(
            "conflict",
            `A secret named "${name}" already exists.`,
          )
        }

        edit.name = name
      }
    }

    if (args.description !== undefined) {
      const description = withoutPresentation(args.description).trim()
      const hidden = hiddenCharacter(description)

      if (hidden) {
        throw invalid(
          `The description has a character that does not show on screen (${hidden}); write it in plain text.`,
        )
      }

      if (description !== meta.description) {
        edit.description = description
      }
    }

    if (args.login_name !== undefined) {
      if (row.kind === "totp") {
        throw invalid("A one-time codes secret has no login name.")
      }

      const loginName = checkLoginName(args.login_name)

      if (loginName !== details.loginName) {
        edit.loginName = loginName
      }
    }

    if (args.note !== undefined) {
      const note = checkSecretNote(args.note)

      if (note !== details.note) {
        edit.note = note
      }
    }

    if (Object.keys(edit).length === 0) {
      throw invalid(`Nothing would change: "${meta.name}" is that already.`)
    }

    return {
      ask: {
        serverId: null,
        action: "edit",
        via: "edit_secret",
        ...(await base(ctx, row, args.reason)),
        edit,
      },
    }
  })
}

// ---- rotate_secret --------------------------------------------------------

export type SecretRotateArgs = {
  name: string
  reason: string
  generate?: unknown
}

export async function prepareSecretRotate(
  ctx: VaultContext,
  args: SecretRotateArgs,
): Promise<{ ask: SecretChangeAsk } | { refused: string }> {
  const row = await ownerSecret(ctx, args.name)

  if (typeof row === "string") {
    return { refused: row }
  }

  return refusedIn(async () => {
    if (args.generate !== undefined && row.kind === "totp") {
      throw invalid(
        "One-time codes come from the site's seed: PCP does not make one. Leave generate out, and the owner types the new seed.",
      )
    }

    return {
      ask: {
        serverId: null,
        action: "rotate",
        via: "rotate_secret",
        ...(await base(ctx, row, args.reason)),
        generate:
          args.generate !== undefined
            ? checkPasswordRecipe(args.generate)
            : null,
      },
    }
  })
}

// ---- change_secret_scope --------------------------------------------------

export type SecretScopeArgs = {
  name: string
  reason: string
  add_sites?: Array<{ origin: string; subdomains?: boolean }>
  remove_sites?: string[]
  add_servers?: string[]
  remove_servers?: string[]
}

/** A server, endpoint, account, service or wrapper by short name or name. */
async function consumerNamed(ctx: VaultContext, named: string) {
  const wanted = named.trim().toLowerCase()
  const rows = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, kind: { in: [...SCOPE_KINDS] } },
    select: { ...SERVER_META_SELECT, kind: true },
  })
  const found =
    rows.find((row) => serverSlug(ctx, row).toLowerCase() === wanted) ??
    rows.find((row) => serverName(ctx, row).toLowerCase() === wanted)

  if (!found) {
    throw invalid(
      `There is no server, endpoint, mail or calendar account, service or wrapper called "${named.trim()}".`,
    )
  }

  return { id: found.id, name: serverName(ctx, found) }
}

export async function prepareSecretScopeChange(
  ctx: VaultContext,
  serverId: string | null,
  args: SecretScopeArgs,
  via: "change_secret_scope" | "update_secret_sites" = "change_secret_scope",
): Promise<{ ask: SecretChangeAsk } | { refused: string }> {
  const row = await ownerSecret(ctx, args.name)

  if (typeof row === "string") {
    return { refused: row }
  }

  return refusedIn(async () => {
    const name = secretName(ctx, row)
    const reason = checkReason(args.reason)
    const sitesNamed =
      (args.add_sites?.length ?? 0) + (args.remove_sites?.length ?? 0) > 0
    // The sites' own checks: lookalikes are the page's, the rest here.
    const sites = sitesNamed
      ? await checkSecretSitesChange(ctx, serverId ?? "", {
          name,
          reason,
          ...(args.add_sites ? { add: args.add_sites } : {}),
          ...(args.remove_sites ? { remove: args.remove_sites } : {}),
        })
      : { add: [], remove: [] }
    const scope = (await readSecretScopes(ctx, [row.id])).get(row.id)!
    const inScope = (id: string) =>
      scope.consumers.find((consumer) => consumer.id === id)
    const addServers: Array<{ id: string; name: string }> = []
    const removeServers: Array<{ id: string; name: string }> = []

    if (
      (args.add_servers?.length ?? 0) + (args.remove_servers?.length ?? 0) >
      MAX_SCOPE_CHANGES
    ) {
      throw invalid(`Name at most ${MAX_SCOPE_CHANGES} servers at a time.`)
    }

    for (const named of args.add_servers ?? []) {
      const consumer = await consumerNamed(ctx, named)

      if (addServers.some((each) => each.id === consumer.id)) {
        throw invalid(`${consumer.name} is named twice in add_servers.`)
      }

      if (!inScope(consumer.id)) {
        addServers.push(consumer)
      }
    }

    for (const named of args.remove_servers ?? []) {
      const consumer = await consumerNamed(ctx, named)
      const current = inScope(consumer.id)

      if (addServers.some((each) => each.id === consumer.id)) {
        throw invalid(`${consumer.name} is both added and taken away.`)
      }

      if (!current) {
        throw invalid(`${consumer.name} is not in the scope of "${name}".`)
      }

      if (current.inUse) {
        throw invalid(
          `${consumer.name} uses "${name}" now, so it stays in its scope while it does.`,
        )
      }

      removeServers.push(consumer)
    }

    if (
      sites.add.length +
        sites.remove.length +
        addServers.length +
        removeServers.length ===
      0
    ) {
      throw invalid(
        `Nothing would change: ${scopeWords(scope.anywhere, scope.consumers)}.`,
      )
    }

    return {
      ask: {
        serverId,
        action: "scope",
        via,
        secretId: row.id,
        secretName: name,
        reason,
        basis: (await secretBasis(ctx, row.id))!,
        scope: {
          addSites: sites.add,
          removeSites: sites.remove,
          addServers,
          removeServers,
        },
      },
    }
  })
}

function scopeWords(
  anywhere: boolean,
  consumers: readonly SecretScopeConsumer[],
): string {
  if (anywhere) {
    return "it may be used anywhere"
  }

  return consumers.length > 0
    ? `it may be used by ${namesInWords(consumers.map((each) => each.name))}`
    : "no server, service or wrapper may use it yet"
}

// ---- delete_secret --------------------------------------------------------

export type SecretDeleteArgs = { name: string; reason: string }

export async function prepareSecretDelete(
  ctx: VaultContext,
  args: SecretDeleteArgs,
): Promise<{ ask: SecretChangeAsk } | { refused: string }> {
  const row = await ownerSecret(ctx, args.name)

  if (typeof row === "string") {
    return { refused: row }
  }

  return refusedIn(async () => ({
    ask: {
      serverId: null,
      action: "delete",
      via: "delete_secret",
      ...(await base(ctx, row, args.reason)),
    },
  }))
}

// ---- What the owner reads -------------------------------------------------

/** A wrapper whose programs or places name a secret by its name. */
export type NamingWrapper = { id: string; name: string; tools: string[] }

/**
 * The wrappers and browser flows whose programs type the secret by its
 * name as written (secret-literals.ts), or whose places for a secret name
 * it: a rename leaves them naming a secret PCP no longer has.
 */
export async function wrappersNamingSecret(
  ctx: VaultContext,
  name: string,
): Promise<NamingWrapper[]> {
  const rows = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, kind: "wrapper" },
    select: {
      ...SERVER_META_SELECT,
      wrapperSpec: { select: WRAPPER_SPEC_SELECT },
    },
  })
  const found: NamingWrapper[] = []

  for (const row of rows) {
    if (!row.wrapperSpec) {
      continue
    }

    try {
      const definition = readDefinition(
        openWrapperSpec(ctx, row.wrapperSpec).definition,
      )
      const tools = new Set<string>()

      for (const tool of definition.tools) {
        if (
          secretLiterals(tool.program).some((literal) => literal.name === name)
        ) {
          tools.add(tool.name)
        }
      }

      for (const binding of definition.secrets) {
        if (binding.secret === name) {
          tools.add(binding.tool)
        }
      }

      if (tools.size > 0) {
        found.push({
          id: row.id,
          name: serverName(ctx, row),
          tools: [...tools].sort(),
        })
      }
    } catch {
      // A definition that does not read names nothing.
    }
  }

  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** One line of before and after. */
export type SecretChangeRow = { label: string; before: string; after: string }

/** A change to the scope, for the owner to tick or leave. */
export type SecretScopeChangeShown = {
  /** "site:add:<origin>", "server:remove:<id>", …: what the answer names. */
  key: string
  action: "add" | "remove"
  what: "site" | "server"
  label: string
  /** A site that looks like one of the secret's without being it. */
  lookalike: string | null
  newDomain: boolean
  /** Already so. */
  noop: boolean
}

export type SecretChangeShown = {
  action: SecretChangeAction
  via: SecretChangeVia
  secretName: string
  /** False once the secret is gone. */
  exists: boolean
  /** The secret changed since the assistant asked: nothing can apply. */
  stale: boolean
  kind: string
  reason: string
  rows: SecretChangeRow[]
  /** What uses it now: what a new value reaches, or what breaks. */
  uses: Array<Pick<SecretUse, "id" | "name" | "kind" | "via">>
  /** delete: the uses it cannot be deleted under, until changed. */
  blocking: Array<Pick<SecretUse, "id" | "name" | "kind" | "via">>
  sites: string[]
  scope: { anywhere: boolean; consumers: SecretScopeConsumer[] }
  changes: SecretScopeChangeShown[]
  /** edit (a rename), delete: what still names it by its name. */
  namedBy: NamingWrapper[]
  /** rotate: what PCP makes, if the owner has it make the value. */
  generate: PasswordRecipe | null
  defaultRecipe: PasswordRecipe | null
}

function valueWords(value: string | null | undefined): string {
  return value ? value : "none"
}

/** A secret change as the owner reads it: before, after and what it touches. */
export async function showSecretChange(
  ctx: VaultContext,
  ask: SecretChangeAsk,
): Promise<SecretChangeShown> {
  const row = await loadById(ctx, ask.secretId)
  const name = row ? secretName(ctx, row) : ask.secretName
  const meta = row ? openSecretMeta(ctx, row) : null
  const details = row
    ? openSecretDetails(ctx, row)
    : { loginName: null, note: null }
  const stale = !row || (await secretBasis(ctx, row.id)) !== ask.basis
  const usage = row ? (await secretUses(ctx, [row.id])).get(row.id) : undefined
  const scope = row
    ? (await readSecretScopes(ctx, [row.id])).get(row.id)!
    : { anywhere: false, consumers: [] }
  const pick = (use: SecretUse) => ({
    id: use.id,
    name: use.name,
    kind: use.kind,
    via: use.via,
  })
  const rows: SecretChangeRow[] = []

  if (ask.action === "edit" && ask.edit) {
    const edit = ask.edit

    if (edit.name !== undefined) {
      rows.push({ label: "Name", before: name, after: edit.name })
    }

    if (edit.description !== undefined) {
      rows.push({
        label: "Description",
        before: valueWords(meta?.description),
        after: valueWords(edit.description),
      })
    }

    if (edit.loginName !== undefined) {
      rows.push({
        label: "Login name",
        before: valueWords(details.loginName),
        after: valueWords(edit.loginName),
      })
    }

    if (edit.note !== undefined) {
      rows.push({
        label: "Note",
        before: valueWords(details.note),
        after: valueWords(edit.note),
      })
    }
  }

  if (ask.action === "rotate") {
    rows.push({
      label: row?.kind === "totp" ? "Seed" : "Value",
      before: "the one it has now",
      after: ask.generate
        ? `a new one PCP makes: ${describeRecipe(ask.generate)}`
        : "a new one you type below",
    })
  }

  if (ask.action === "delete") {
    rows.push({ label: "Secret", before: name, after: "deleted" })
  }

  let changes: SecretScopeChangeShown[] = []

  if (ask.action === "scope" && ask.scope) {
    const scopeAsk = ask.scope
    const siteChanges: SecretSiteChangeShown[] =
      row && scopeAsk.addSites.length + scopeAsk.removeSites.length > 0
        ? (
            await showSecretSitesChange(ctx, {
              serverId: ask.serverId ?? "",
              secretName: name,
              reason: ask.reason,
              add: scopeAsk.addSites,
              remove: scopeAsk.removeSites,
            })
          ).changes
        : []
    const consumerIn = (id: string) =>
      scope.consumers.some((consumer) => consumer.id === id)

    changes = [
      ...siteChanges.map((change): SecretScopeChangeShown => ({
        key: `site:${change.key}`,
        action: change.action,
        what: "site",
        label: `${change.action === "add" ? "Type it at" : "No longer type it at"} ${change.label}`,
        lookalike: change.lookalike,
        newDomain: change.newDomain,
        noop: change.noop,
      })),
      ...scopeAsk.addServers.map((server): SecretScopeChangeShown => ({
        key: `server:add:${server.id}`,
        action: "add",
        what: "server",
        label: `Let ${server.name} use it`,
        lookalike: null,
        newDomain: false,
        noop: consumerIn(server.id),
      })),
      ...scopeAsk.removeServers.map((server): SecretScopeChangeShown => ({
        key: `server:remove:${server.id}`,
        action: "remove",
        what: "server",
        label: `No longer let ${server.name} use it`,
        lookalike: null,
        newDomain: false,
        noop: !consumerIn(server.id),
      })),
    ]
  }

  const renamed =
    ask.action === "edit" && ask.edit?.name !== undefined ? ask.edit.name : null

  return {
    action: ask.action,
    via: ask.via,
    secretName: name,
    exists: row !== null,
    stale,
    kind: row?.kind ?? "text",
    reason: ask.reason,
    rows,
    uses: (usage?.uses ?? []).map(pick),
    blocking: row ? blockingUses(usage, row.kind).map(pick) : [],
    sites: usage?.sites ?? [],
    scope,
    changes,
    namedBy:
      row && (renamed !== null || ask.action === "delete")
        ? await wrappersNamingSecret(ctx, name)
        : [],
    generate: ask.generate ?? null,
    defaultRecipe:
      ask.action === "rotate" && row?.kind !== "totp"
        ? (ask.generate ??
          (details.loginName ? DEFAULT_PASSWORD_RECIPE : DEFAULT_TOKEN_RECIPE))
        : null,
  }
}

/** The request's lines, for the bell, the assistant and check_permission. */
export function describeSecretChangeAsk(
  ask: SecretChangeAsk,
  shown?: SecretChangeShown,
): { title: string; lines: string[]; warning: string | null } {
  const name = ask.secretName
  const title =
    ask.action === "edit"
      ? `Change the secret "${name}"`
      : ask.action === "rotate"
        ? `Give the secret "${name}" a new value`
        : ask.action === "scope"
          ? `Change where the secret "${name}" may be used`
          : `Delete the secret "${name}"`
  const lines = [`Why: ${ask.reason}`]

  for (const row of shown?.rows ?? []) {
    lines.push(`${row.label}: ${row.before} → ${row.after}`)
  }

  if (ask.action === "scope" && ask.scope) {
    for (const site of ask.scope.addSites) {
      lines.push(`Add the site ${siteLabel(site)}`)
    }

    for (const origin of ask.scope.removeSites) {
      lines.push(`Take away the site ${origin}`)
    }

    for (const server of ask.scope.addServers) {
      lines.push(`Let ${server.name} use it`)
    }

    for (const server of ask.scope.removeServers) {
      lines.push(`No longer let ${server.name} use it`)
    }
  }

  if (shown && shown.uses.length > 0) {
    lines.push(
      `Used by: ${namesInWords(
        shown.uses.map((use) => use.name),
        10,
      )}`,
    )
  }

  return {
    title,
    lines,
    warning:
      ask.action === "rotate"
        ? "Type the new value here, on PCP's page, never in the conversation. Everything that uses the secret gets the new value; a service that takes it is made again with it."
        : ask.action === "delete"
          ? "Deleting it cannot be undone. Whatever uses it has to be changed first."
          : ask.action === "edit" && ask.edit?.name !== undefined
            ? "A wrapper or browser flow that names the secret by its old name stops finding it."
            : null,
  }
}

// ---- The owner's answer ---------------------------------------------------

export type SecretChangeAnswer = {
  /** scope: the changes the owner ticked, by key. */
  keep?: string[]
  /** rotate: the value the owner typed. */
  value?: string
  /** rotate: "Have PCP make it", the recipe; wins over a typed value. */
  generate?: unknown
}

/**
 * What is wrong with the owner's answer before anything is written: the
 * secret gone or changed since the assistant asked, a rotate with no value,
 * a scope change with nothing ticked, a delete while something uses it.
 * Null when it will do.
 */
export async function checkSecretChangeAnswer(
  ctx: VaultContext,
  ask: SecretChangeAsk,
  answer: SecretChangeAnswer,
): Promise<string | null> {
  const row = await loadById(ctx, ask.secretId)

  if (!row) {
    return `The secret "${ask.secretName}" is no longer in PCP, so there is nothing to change.`
  }

  if ((await secretBasis(ctx, row.id)) !== ask.basis) {
    return `The secret "${secretName(ctx, row)}" changed since the assistant asked, so nothing was changed. The assistant can ask again.`
  }

  if (!isOwnerSecretKind(row.kind)) {
    return managedRefusal(row.kind, secretName(ctx, row))
  }

  if (ask.action === "rotate") {
    if (answer.generate !== undefined && answer.generate !== null) {
      if (row.kind === "totp") {
        return "One-time codes come from the site's seed: PCP does not make one."
      }

      try {
        checkPasswordRecipe(answer.generate)
      } catch (error) {
        if (isPcpError(error)) {
          return error.message
        }

        throw error
      }

      return null
    }

    return validateSecretValue(answer.value ?? "", row.kind)
  }

  if (ask.action === "scope") {
    const shown = await showSecretChange(ctx, ask)
    const chosen = answer.keep ?? []

    if (
      chosen.some((key) => !shown.changes.some((change) => change.key === key))
    ) {
      return "That is not one of the changes asked for."
    }

    return chosen.length === 0
      ? "Tick at least one change, or answer Not now."
      : null
  }

  if (ask.action === "delete") {
    const blocking = blockingUses(
      (await secretUses(ctx, [row.id])).get(row.id),
      row.kind,
    )

    if (blocking.length > 0) {
      return `"${secretName(ctx, row)}" is used by ${namesInWords(
        blocking.map((use) => use.name),
      )}. Change those first, then answer again.`
    }
  }

  return null
}

/** What PCP does when a secret's value changed: services remade, results. */
export type RemakeServices = (
  ctx: VaultContext,
  secretId: string,
) => Promise<Array<{ id: string; ok: boolean; message: string }>>

/**
 * The owner's yes: only what they were shown, to the secret as it was when
 * asked; refused with nothing written otherwise. Says what was done, never
 * the value.
 */
export async function applySecretChange(
  ctx: VaultContext,
  ask: SecretChangeAsk,
  answer: SecretChangeAnswer,
  options: { remakeServices: RemakeServices },
): Promise<string> {
  const problem = await checkSecretChangeAnswer(ctx, ask, answer)

  if (problem) {
    throw new PcpError("conflict", problem)
  }

  const row = (await loadById(ctx, ask.secretId))!
  const name = secretName(ctx, row)

  switch (ask.action) {
    case "edit": {
      const edit = ask.edit ?? {}
      const namedBy =
        edit.name !== undefined ? await wrappersNamingSecret(ctx, name) : []

      await updateSecret(ctx, row.id, {
        ...(edit.name !== undefined ? { name: edit.name } : {}),
        ...(edit.description !== undefined
          ? { description: edit.description }
          : {}),
        ...(edit.loginName !== undefined ? { loginName: edit.loginName } : {}),
        ...(edit.note !== undefined ? { note: edit.note } : {}),
      })

      const changed = [
        edit.name !== undefined ? `renamed it "${edit.name}"` : null,
        edit.description !== undefined ? "changed its description" : null,
        edit.loginName !== undefined
          ? edit.loginName
            ? `set its login name to ${edit.loginName}`
            : "took its login name away"
          : null,
        edit.note !== undefined
          ? edit.note
            ? "changed its note"
            : "took its note away"
          : null,
      ].filter((part): part is string => part !== null)

      return [
        `The owner ${namesInWords(changed)} of the secret "${name}". Its value did not change.`,
        ...(namedBy.length > 0
          ? [
              `${namesInWords(namedBy.map((each) => each.name))} still name it "${name}": propose changing them with update_wrapper.`,
            ]
          : []),
      ].join(" ")
    }
    case "rotate": {
      const generated =
        answer.generate !== undefined && answer.generate !== null
      const value = generated
        ? generatePassword(checkPasswordRecipe(answer.generate))
        : answer.value!

      // Every server, account and service that sends it gets the new
      // value from here; their alerts about it are cleared there.
      await updateSecret(ctx, row.id, { value })

      const remade = await options.remakeServices(ctx, row.id)
      const failed = remade.filter((each) => !each.ok)

      return [
        `The owner gave the secret "${name}" a new value${generated ? " that PCP made itself" : ""}; you never get it.`,
        "Everything that uses it sends the new one from now on.",
        ...(remade.length > 0
          ? [
              `Made again with it: ${remade.length - failed.length} of ${remade.length} services.`,
              ...failed.map((each) => each.message),
            ]
          : []),
      ].join(" ")
    }
    case "scope": {
      const chosen = new Set(answer.keep ?? [])
      const scopeAsk = ask.scope!
      const done: string[] = []
      const left: string[] = []

      for (const origin of scopeAsk.removeSites) {
        if (chosen.has(`site:remove:${origin}`)) {
          await unbindOrigin(ctx, row.id, origin)
          done.push(`took away the site ${origin}`)
        } else {
          left.push(`taking away ${origin}`)
        }
      }

      for (const site of scopeAsk.addSites) {
        if (chosen.has(`site:add:${site.origin}`)) {
          await bindOrigin(ctx, row.id, site.origin, {
            subdomains: site.subdomains,
          })
          done.push(`added the site ${siteLabel(site)}`)
        } else {
          left.push(`adding ${siteLabel(site)}`)
        }
      }

      for (const server of scopeAsk.removeServers) {
        if (chosen.has(`server:remove:${server.id}`)) {
          await removeFromSecretScope(ctx, row.id, server.id)
          done.push(`took away ${server.name}`)
        } else {
          left.push(`taking away ${server.name}`)
        }
      }

      for (const server of scopeAsk.addServers) {
        if (chosen.has(`server:add:${server.id}`)) {
          await grantSecretScope(ctx, row.id, server.id)
          done.push(`let ${server.name} use it`)
        } else {
          left.push(`letting ${server.name} use it`)
        }
      }

      const sites = (await sitesOf(ctx, row.id)).map(siteLabel)
      const scope = (await readSecretScopes(ctx, [row.id])).get(row.id)!

      return [
        `The owner changed where "${name}" may be used: ${namesInWords(done, 20)}.`,
        ...(left.length > 0 ? [`Not done: ${left.join("; ")}.`] : []),
        `Now ${scopeWords(scope.anywhere, scope.consumers)}; the browser types it at ${sites.join(", ") || "no site"}.`,
      ].join(" ")
    }
    case "delete": {
      await deleteSecret(ctx, row.id)

      return `The owner deleted the secret "${name}".`
    }
  }
}

/** The yes on a secret_change page, by what it does. */
export const SECRET_CHANGE_YES: Record<SecretChangeAction, string> = {
  edit: "Apply the changes",
  rotate: "Save the new value",
  scope: "Apply ticked changes",
  delete: "Delete it",
}
