import type { VaultContext } from "../context"
import { db } from "../db"
import {
  changeEndpoint,
  createEndpoint,
  storedSpec,
  updateEndpoint,
  type EndpointInput,
} from "../endpoints"
import { invalid, PcpError } from "../errors"
import { findTextSecretByName } from "../secrets"
import {
  createServer,
  getServer,
  renameServerSlug,
  setToolDescription,
  updateServer,
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
 * A secret is found by its name in this vault. One the vault does not have
 * is never made up: the item is saved without it (a wrapper without that
 * secret's places, an endpoint or server without that credential), and a
 * note says the owner adds it on PCP's page.
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

  if (row.slug !== document.name) {
    const clash = await findLocalItem(ctx, ref)

    if (clash && clash.id !== id) {
      throw new PcpError(
        "conflict",
        `Another server is called ${document.name} in this vault, so ${row.name} cannot take that name: nothing was changed.`,
      )
    }
  }

  return id
}

/** The row goes by the item's name, as the repository has it. */
async function settle(
  ctx: VaultContext,
  id: string,
  document: Exclude<ItemDocument, SkillDocument>,
): Promise<void> {
  const row = await getServer(ctx, id)

  if (row.slug !== document.name) {
    await renameServerSlug(ctx, id, document.name)
  }

  await db().mcpServer.update({
    where: { id },
    data: { syncVersion: document.version },
  })
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

  const saved = await saveWrapperByOwner(ctx, id, input)
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
            ? `${what} sends a secret in ${auth.header}, but the repository names none, so it was saved without a credential. Choose its secret on its page.`
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

      if (!secretId) {
        notes.push(
          auth.secret === null
            ? `${what} signs in as ${auth.username}, but the repository names no secret for it, so it was saved without a credential.`
            : missingNote(auth.secret, what),
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
): Promise<AppliedItem> {
  const notes: string[] = []
  const what = `the API endpoint ${document.displayName}`
  const ids = await secretIds(ctx, authSecrets(document.auth))
  const common = {
    name: document.displayName,
    description: document.description,
    baseUrl: document.baseUrl,
    readOnly: document.readOnly,
    publicOnly: document.publicOnly,
    patches: document.patches,
    ...credentialInput(document.auth, ids, what, notes),
  }
  let serverId: string

  if (id === null) {
    serverId = (
      await createEndpoint(ctx, {
        ...common,
        specSource: "upload",
        specText: document.spec.text,
      })
    ).id
  } else {
    const existing = await getServer(ctx, id)

    if (existing.specSource === "url" && existing.specUrl) {
      // A schema read from a URL keeps its address: the approved text
      // becomes its copy, as a new download of it would.
      const stored = await storedSpec(id)

      if (stored?.text !== document.spec.text) {
        await changeEndpoint(ctx, id, {
          fetched: { text: document.spec.text, url: existing.specUrl },
          patches: document.patches,
          readOnly: document.readOnly,
        })
      }

      await updateEndpoint(ctx, id, {
        ...common,
        specSource: "url",
        specUrl: existing.specUrl,
      })
    } else {
      await updateEndpoint(ctx, id, {
        ...common,
        specSource: "upload",
        specText: document.spec.text,
      })
    }

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
): Promise<AppliedItem> {
  const notes: string[] = []
  const what = `the server ${document.displayName}`
  const ids = await secretIds(ctx, authSecrets(document.auth))
  const credential = credentialInput(document.auth, ids, what, notes)
  const input: ServerInput = {
    name: document.displayName,
    description: document.description,
    url: document.url,
    publicOnly: document.publicOnly,
    ...credential,
    authType: credential.authType as ServerInput["authType"],
  }
  const serverId = id === null ? (await createServer(ctx, input)).id : id

  if (id !== null) {
    await updateServer(ctx, id, input)
  }

  await settle(ctx, serverId, document)

  return { id: serverId, notes }
}

/**
 * Applies an item the owner approved: onto the vault's item `id` (its
 * skill's id, or its server row's), or as a new one when `id` is null.
 * Refused, with nothing written, when a name in it is nothing in this vault
 * (resolveItem), when a new item's name is taken, or when `id` is something
 * else. The item's version goes with it: a skill's own, a server row's
 * syncVersion.
 */
export async function applyItem(
  ctx: VaultContext,
  document: ItemDocument,
  { id }: { id: string | null },
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
      return applyEndpoint(ctx, document, into)
    case "server":
      return applyServer(ctx, document, into)
  }
}
