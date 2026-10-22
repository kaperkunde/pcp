import type { VaultContext } from "../context"
import { db } from "../db"
import { shareDescription, uniqueDefinitionSlug } from "../definition-rows"
import type { CloneInput } from "../definitions"
import {
  changeEndpoint,
  createEndpoint,
  storedSpec,
  type EndpointInput,
} from "../endpoints"
import { invalid, PcpError } from "../errors"
import { checkPersonalNote, setPersonalNote } from "../personal-notes"
import { findTextSecretByName } from "../secrets"
import {
  createServer,
  getServer,
  normalizeNameAndDescription,
  renameServerSlug,
  setToolDescription,
  type ExtraAuthHeaderInput,
  type ServerInput,
} from "../servers"
import { saveSkillByOwner } from "../skills"
import { saveWrapperByOwner } from "../wrappers/admin"
import {
  browserServerIds,
  splitRef,
  type WrapperInput,
} from "../wrappers/definition"

import type {
  EndpointAuthDocument,
  EndpointDocument,
  ItemDocument,
  ServerDocument,
  SkillDocument,
  WrapperDocument,
} from "./documents"
import { itemRoot, type ItemKind } from "./layout"
import { findLocalItem } from "./local"

/**
 * An item from a repository, once the owner approved it, written with the
 * owner's own paths: skills.ts for a skill, wrappers/admin.ts
 * saveWrapperByOwner for a wrapper or flow, endpoints.ts for an API
 * endpoint, servers.ts for an MCP server. Nothing here asks anyone: the
 * review and the owner's answer come first (review.ts; the request is sync's).
 *
 * A server's item is its definition (definitions.ts). Onto a server the
 * vault has, it writes what the definition holds and nothing else: the
 * definition's name, the description, the schema and its edits, the tool
 * descriptions, a wrapper's programs. Never an instance's own: its name and
 * short name, address, credential, read-only and public-only switches,
 * whether it is on, its pace, levels or note. A new one is the definition
 * and its first instance, whose own part the owner gave on the page that
 * adds it (`InstanceInput`, as cloning asks for it); without one, what a
 * format-1 document said of its server (`instance`) fills it in.
 *
 * A secret is found by its name in this vault. One the vault does not have
 * is never made up: the item is saved without it (a wrapper without that
 * secret's places, a server without that credential), and a note says the
 * owner adds it on PCP's page.
 */

export type ResolvedItem = {
  /** What stops the item from being applied here: a name with nothing to it. */
  problems: string[]
  /** Secrets it names that the vault does not hold. */
  missingSecrets: string[]
}

export type AppliedItem = {
  /** The skill's id, or the server row's. */
  id: string
  /** What the owner should know: a secret to add, say. */
  notes: string[]
}

/**
 * The first instance of a server item, as the owner gave it on the page
 * that adds it: its name, address, sign-in and note, as a clone asks for
 * them, and an endpoint's switches.
 */
export type InstanceInput = CloneInput & {
  readOnly?: boolean
  publicOnly?: boolean
}

/** A wrapper document as resolveDefinition takes it: other tools by short name. */
export function wrapperInput(document: WrapperDocument): WrapperInput {
  return {
    name: document.displayName,
    description: document.description,
    callLevels: document.callLevels,
    tools: document.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations: tool.annotations,
      program: tool.program,
      calls: tool.calls,
      replaces: tool.replaces,
    })),
    secrets: document.secrets.map((binding) => ({
      secret: binding.secret,
      tool: binding.tool,
      argument: binding.argument,
      template: binding.template,
    })),
  }
}

function authSecrets(auth: EndpointAuthDocument): string[] {
  switch (auth.kind) {
    case "none":
      return []
    case "header":
      return [
        auth.secret,
        ...auth.headers.map((header) => header.secret),
      ].filter((name): name is string => name !== null)
    case "basic":
      return auth.secret === null ? [] : [auth.secret]
    case "oauth":
      return auth.clientSecret === null ? [] : [auth.clientSecret]
  }
}

/**
 * The secrets an item names that the vault should hold: a wrapper's secret
 * places, and the secrets a format-1 server document signs in with (used
 * only for a first instance).
 */
function secretsNamed(document: ItemDocument): string[] {
  switch (document.kind) {
    case "skill":
      return []
    case "wrapper":
    case "flow":
      return document.secrets.map((binding) => binding.secret)
    case "endpoint":
    case "server":
      return authSecrets(document.auth)
  }
}

/** Secret names to their ids in this vault, for the ones it has. */
async function secretIds(
  ctx: VaultContext,
  names: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>()

  for (const name of new Set(names)) {
    const secret = await findTextSecretByName(ctx, name)

    if (secret) {
      found.set(name, secret.id)
    }
  }

  return found
}

async function wrapperProblems(
  ctx: VaultContext,
  document: WrapperDocument,
): Promise<string[]> {
  const root = itemRoot({ kind: document.kind, name: document.name })
  const refs = new Set<string>([
    ...document.tools.flatMap((tool) => [...tool.calls, ...tool.replaces]),
    ...document.secrets.map((binding) => binding.tool),
  ])
  const slugs = [
    ...new Set(
      [...refs].flatMap((ref) => {
        const split = splitRef(ref)
        return split ? [split.slug] : []
      }),
    ),
  ]
  const servers = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, slug: { in: slugs } },
    select: { id: true, slug: true, kind: true },
  })
  const bySlug = new Map(servers.map((server) => [server.slug, server]))
  const tools = await db().mcpTool.findMany({
    where: { serverId: { in: servers.map((server) => server.id) } },
    select: { serverId: true, name: true },
  })
  const has = new Set(tools.map((tool) => `${tool.serverId}\n${tool.name}`))
  const problems: string[] = []

  for (const ref of [...refs].sort()) {
    const split = splitRef(ref)!
    const server = bySlug.get(split.slug)

    if (!server) {
      problems.push(
        `${root} uses ${ref}, but this vault has no server called ${split.slug}.`,
      )
    } else if (server.kind === "wrapper") {
      problems.push(
        `${root} uses ${ref}, a wrapper's tool; a wrapper calls other servers' tools only.`,
      )
    } else if (!has.has(`${server.id}\n${split.tool}`)) {
      problems.push(
        `${root} uses ${ref}, but ${split.slug} has no tool ${split.tool}.`,
      )
    }
  }

  const browsers = await browserServerIds(ctx)
  const drivesBrowser = document.tools.some((tool) =>
    tool.calls.some((call) => {
      const server = bySlug.get(splitRef(call)?.slug ?? "")
      return server ? browsers.has(server.id) : false
    }),
  )

  if (problems.length === 0 && drivesBrowser !== (document.kind === "flow")) {
    problems.push(
      drivesBrowser
        ? `${root} drives the browser here, so it is a flow: it belongs under flows/.`
        : `${root} calls no browser tool here, so it is a wrapper, not a flow: it belongs under wrappers/.`,
    )
  }

  return problems
}

/**
 * What an item's names are in this vault: the servers and tools a wrapper
 * calls (a name with nothing to it is a problem, never a guess) and the
 * secrets it names (one the vault lacks is listed, for the owner to add).
 */
export async function resolveItem(
  ctx: VaultContext,
  document: ItemDocument,
): Promise<ResolvedItem> {
  const names = secretsNamed(document)
  const found = await secretIds(ctx, names)
  const missingSecrets = [...new Set(names)].filter((name) => !found.has(name))
  const problems =
    document.kind === "wrapper" || document.kind === "flow"
      ? await wrapperProblems(ctx, document)
      : []

  return { problems, missingSecrets }
}

function missingNote(secret: string, what: string): string {
  return `This vault has no secret called "${secret}", so ${what} was saved without it. Add the secret under Secrets in PCP, then give it to ${what} on its page.`
}

/** The target an item is applied onto: the row it names, checked. */
async function target(
  ctx: VaultContext,
  document: ItemDocument,
  id: string | null,
): Promise<string | null> {
  const ref = { kind: document.kind, name: document.name }

  if (id === null) {
    const clash = await findLocalItem(ctx, ref)

    if (clash) {
      throw new PcpError(
        "conflict",
        `${document.kind === "skill" ? "A skill" : "A server"} called ${document.name} is in this vault already: apply ${itemRoot(ref)} onto it, or rename one.`,
      )
    }

    return null
  }

  if (document.kind === "skill") {
    return id
  }

  const row = await getServer(ctx, id)
  const kinds: Record<Exclude<ItemKind, "skill">, string> = {
    wrapper: "wrapper",
    flow: "wrapper",
    endpoint: "openapi",
    server: "mcp",
  }

  if (row.kind !== kinds[document.kind]) {
    throw invalid(`${row.name} is not a ${document.kind}: nothing was changed.`)
  }

  return id
}

/**
 * The definition goes by the item's short name and name, as the repository
 * has them, and every instance carries the item's version. A short name
 * another definition has keeps the definition's own.
 */
async function settle(
  ctx: VaultContext,
  id: string,
  document: Exclude<ItemDocument, SkillDocument>,
): Promise<void> {
  const row = await getServer(ctx, id)

  if (row.definitionId) {
    const free =
      (await uniqueDefinitionSlug(
        db(),
        ctx.vaultId,
        document.name,
        row.definitionId,
      )) === document.name

    await db().serverDefinition.update({
      where: { id: row.definitionId },
      data: {
        name: document.displayName,
        ...(free ? { slug: document.name } : {}),
      },
    })
  }

  await db().mcpServer.updateMany({
    where: row.definitionId
      ? { definitionId: row.definitionId, vaultId: ctx.vaultId }
      : { id },
    data: { syncVersion: document.version },
  })
}

/** A new first instance takes the item's short name when it was given none. */
async function firstName(
  ctx: VaultContext,
  id: string,
  document: Exclude<ItemDocument, SkillDocument>,
  named: boolean,
): Promise<void> {
  const row = await getServer(ctx, id)

  if (!named && row.slug !== document.name) {
    const taken = await db().mcpServer.findUnique({
      where: { vaultId_slug: { vaultId: ctx.vaultId, slug: document.name } },
      select: { id: true },
    })

    if (!taken) {
      await renameServerSlug(ctx, id, document.name)
    }
  }
}

/** The description every instance carries, written as the definition's. */
async function writeDescription(
  ctx: VaultContext,
  id: string,
  description: string,
): Promise<void> {
  const row = await getServer(ctx, id)
  const text = normalizeNameAndDescription({
    name: row.name,
    description,
  }).description

  if (row.description !== text) {
    await db().mcpServer.update({ where: { id }, data: { description: text } })
  }

  await shareDescription(id)
}

async function applySkill(
  ctx: VaultContext,
  document: SkillDocument,
  id: string | null,
): Promise<AppliedItem> {
  const saved = await saveSkillByOwner(ctx, id, {
    name: document.name,
    description: document.description,
    body: document.body,
    tools: document.tools,
    files: document.files,
    extra: document.extra,
    version: document.version,
  })

  return { id: saved.id, notes: [] }
}

async function applyWrapper(
  ctx: VaultContext,
  document: WrapperDocument,
  id: string | null,
  missing: string[],
): Promise<AppliedItem> {
  const input = wrapperInput(document)
  const notes = missing.map((secret) =>
    missingNote(secret, `the wrapper ${document.displayName}`),
  )

  input.secrets = (input.secrets ?? []).filter(
    (binding) => !missing.includes(binding.secret),
  )

  if (id !== null) {
    // The wrapper keeps its own name: only what it does is the definition's.
    input.name = (await getServer(ctx, id)).name
  }

  const saved = await saveWrapperByOwner(ctx, id, input)

  if (id === null) {
    await firstName(ctx, saved.id, document, false)
  }

  await settle(ctx, saved.id, document)

  return { id: saved.id, notes }
}

/** An item's credential as the owner's form gives it, secrets by id. */
function credentialInput(
  auth: EndpointAuthDocument,
  ids: Map<string, string>,
  what: string,
  notes: string[],
): Pick<
  EndpointInput,
  | "authType"
  | "authHeaderName"
  | "authValueTemplate"
  | "authSecretId"
  | "authUsername"
  | "authExtraHeaders"
  | "oauthClientId"
  | "oauthClientSecretId"
  | "oauthScope"
  | "oauthAuthorizeParams"
> {
  const id = (name: string | null) => (name === null ? null : ids.get(name))

  switch (auth.kind) {
    case "none":
      return { authType: "none" }

    case "header": {
      const first = id(auth.secret)

      if (!first) {
        notes.push(
          auth.secret === null
            ? `${what} sends a secret in ${auth.header}, so it was saved without a credential until you choose its secret on its page.`
            : missingNote(auth.secret, what),
        )
        return { authType: "none" }
      }

      const headers: ExtraAuthHeaderInput[] = []

      for (const header of auth.headers) {
        const secretId = id(header.secret)

        if (!secretId) {
          notes.push(
            header.secret === null
              ? `${what}'s ${header.header} header names no secret, so it was left out. Add it on its page.`
              : missingNote(header.secret, `${what}'s ${header.header} header`),
          )
          continue
        }

        headers.push({
          secretId,
          headerName: header.header,
          valueTemplate: header.template,
        })
      }

      return {
        authType: "header",
        authHeaderName: auth.header,
        authValueTemplate: auth.template,
        authSecretId: first,
        authExtraHeaders: headers,
      }
    }

    case "basic": {
      const secretId = id(auth.secret)

      if (!secretId || auth.username === null) {
        notes.push(
          auth.secret !== null && !secretId
            ? missingNote(auth.secret, what)
            : `${what} signs in with a user name and password, so it was saved without a credential until you give it yours on its page.`,
        )
        return { authType: "none" }
      }

      return {
        authType: "basic",
        authUsername: auth.username,
        authSecretId: secretId,
      }
    }

    case "oauth": {
      const clientSecretId = id(auth.clientSecret)

      if (auth.clientSecret !== null && !clientSecretId) {
        notes.push(missingNote(auth.clientSecret, `${what}'s OAuth client`))
      }

      return {
        authType: "oauth",
        oauthClientId: auth.clientId,
        oauthClientSecretId: clientSecretId ?? null,
        oauthScope: auth.scope,
        oauthAuthorizeParams: auth.authorizeParams,
      }
    }
  }
}

/** What the owner gave for the first instance, as the server forms take it. */
function instanceCredential(
  instance: InstanceInput,
): Pick<
  EndpointInput,
  | "authType"
  | "authHeaderName"
  | "authValueTemplate"
  | "authSecretId"
  | "authSecretName"
  | "authSecretValue"
  | "authUsername"
  | "authExtraHeaders"
  | "oauthClientId"
  | "oauthClientSecretId"
  | "oauthClientSecretValue"
  | "oauthScope"
  | "oauthAuthorizeParams"
> {
  return {
    authType: instance.authType,
    authHeaderName: instance.authHeaderName,
    authValueTemplate: instance.authValueTemplate,
    authSecretId: instance.authSecretId,
    authSecretName: instance.authSecretName,
    authSecretValue: instance.authSecretValue,
    authUsername: instance.authUsername,
    authExtraHeaders: instance.authExtraHeaders,
    oauthClientId: instance.oauthClientId,
    oauthClientSecretId: instance.oauthClientSecretId,
    oauthClientSecretValue: instance.oauthClientSecretValue,
    oauthScope: instance.oauthScope,
    oauthAuthorizeParams: instance.oauthAuthorizeParams,
  }
}

function addressOf(
  document: EndpointDocument | ServerDocument,
  instance: InstanceInput | undefined,
): string {
  const url = instance ? instance.url.trim() : (document.instance?.url ?? "")

  if (!url) {
    throw invalid(
      document.kind === "endpoint"
        ? `${itemRoot(document)} has no base URL of its own: enter the one your server's requests go to.`
        : `${itemRoot(document)} has no address of its own: enter the MCP server's address.`,
    )
  }

  return url
}

async function setToolDescriptions(
  ctx: VaultContext,
  id: string,
  wanted: Record<string, string>,
): Promise<void> {
  const tools = await db().mcpTool.findMany({
    where: { serverId: id },
    select: { name: true, descriptionOverride: true },
  })

  for (const tool of tools) {
    const description = wanted[tool.name] ?? null

    if (tool.descriptionOverride !== description) {
      await setToolDescription(ctx, id, tool.name, description)
    }
  }
}

async function applyEndpoint(
  ctx: VaultContext,
  document: EndpointDocument,
  id: string | null,
  instance: InstanceInput | undefined,
): Promise<AppliedItem> {
  const notes: string[] = []
  const what = `the API endpoint ${document.displayName}`
  let serverId: string

  if (id === null) {
    const note = checkPersonalNote(instance?.note)
    const credential = instance
      ? instanceCredential(instance)
      : credentialInput(
          document.auth,
          await secretIds(ctx, authSecrets(document.auth)),
          what,
          notes,
        )

    serverId = (
      await createEndpoint(ctx, {
        name: instance?.name.trim() || document.displayName,
        description: document.description,
        baseUrl: addressOf(document, instance),
        readOnly: instance?.readOnly ?? document.instance?.readOnly ?? true,
        publicOnly:
          instance?.publicOnly ?? document.instance?.publicOnly ?? false,
        patches: document.patches,
        specSource: "upload",
        specText: document.spec.text,
        ...credential,
      })
    ).id

    if (note) {
      await setPersonalNote(ctx, "server", serverId, note)
    }

    await firstName(ctx, serverId, document, !!instance?.name.trim())
  } else {
    // What the definition holds, and nothing of the instance's own.
    const existing = await getServer(ctx, id)
    const stored = await storedSpec(id)
    const newText = stored?.text !== document.spec.text

    await changeEndpoint(ctx, id, {
      description: document.description,
      patches: document.patches,
      ...(newText
        ? existing.specSource === "url" && existing.specUrl
          ? // A schema read from a URL keeps its address: the approved text
            // becomes its copy, as a new download of it would.
            { fetched: { text: document.spec.text, url: existing.specUrl } }
          : { specText: document.spec.text }
        : {}),
    })
    serverId = id
  }

  await setToolDescriptions(ctx, serverId, document.toolDescriptions)
  await settle(ctx, serverId, document)

  return { id: serverId, notes }
}

async function applyServer(
  ctx: VaultContext,
  document: ServerDocument,
  id: string | null,
  instance: InstanceInput | undefined,
): Promise<AppliedItem> {
  const notes: string[] = []
  const what = `the server ${document.displayName}`
  let serverId: string

  if (id === null) {
    const note = checkPersonalNote(instance?.note)

    if (instance?.authType === "basic") {
      throw invalid(
        "An MCP server signs in with a secret in a header or with OAuth.",
      )
    }

    const credential = instance
      ? instanceCredential(instance)
      : credentialInput(
          document.auth,
          await secretIds(ctx, authSecrets(document.auth)),
          what,
          notes,
        )
    const input: ServerInput = {
      name: instance?.name.trim() || document.displayName,
      description: document.description,
      url: addressOf(document, instance),
      publicOnly:
        instance?.publicOnly ?? document.instance?.publicOnly ?? false,
      ...credential,
      authType: credential.authType as ServerInput["authType"],
    }

    serverId = (await createServer(ctx, input)).id

    if (note) {
      await setPersonalNote(ctx, "server", serverId, note)
    }

    await firstName(ctx, serverId, document, !!instance?.name.trim())
  } else {
    await writeDescription(ctx, id, document.description)
    serverId = id
  }

  await settle(ctx, serverId, document)

  return { id: serverId, notes }
}

/**
 * Applies an item the owner approved: onto the vault's item `id` (its
 * skill's id, or the server row standing for its definition), or as a new
 * one when `id` is null, with `instance` the first instance of a new server
 * or endpoint. Refused, with nothing written, when a name in it is nothing
 * in this vault (resolveItem), when a new item's name is taken, or when
 * `id` is something else. The item's version goes with it: a skill's own,
 * a server's syncVersion on every instance.
 */
export async function applyItem(
  ctx: VaultContext,
  document: ItemDocument,
  { id, instance }: { id: string | null; instance?: InstanceInput },
): Promise<AppliedItem> {
  const { problems, missingSecrets } = await resolveItem(ctx, document)

  if (problems.length > 0) {
    throw invalid(problems.join(" "))
  }

  const into = await target(ctx, document, id)

  switch (document.kind) {
    case "skill":
      return applySkill(ctx, document, into)
    case "wrapper":
    case "flow":
      return applyWrapper(ctx, document, into, missingSecrets)
    case "endpoint":
      return applyEndpoint(ctx, document, into, instance)
    case "server":
      return applyServer(ctx, document, into, instance)
  }
}
