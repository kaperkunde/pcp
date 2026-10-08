import { createHash } from "node:crypto"

import type { VaultContext } from "../context"
import { db } from "../db"
import { invalid, notFound, PcpError } from "../errors"
import type { GatewayServer } from "../gateway-servers"
import { newId } from "../ids"
import { canonicalJson } from "../permission-rules"
import { createSecretNamedAfter, findTextSecretByName } from "../secrets"
import { deleteServer, slugify, uniqueSlug, WRAPPER_URL } from "../servers"

import { syncWrapperTools } from "./catalogue"
import {
  definitionHash,
  readDefinition,
  resolveDefinition,
  type Reach,
  type WrapperDefinition,
  type WrapperInput,
  type WrapperToolInput,
  type SecretBindingInput,
} from "./definition"
import { MAX_WRAPPERS } from "./limits"

/**
 * Making and changing wrappers. An assistant only ever asks: create_wrapper,
 * update_wrapper and delete_wrapper each make a request (kind
 * wrapper_change) that shows the owner the whole of what would change (every
 * program, schema, call, replaced tool and secret binding, before and after)
 * and writes nothing until they agree; then it writes exactly that, to the
 * wrapper as it was when they were asked (`basis`). The owner makes and
 * changes wrappers directly in PCP.
 */

export type WrapperShownTool = {
  name: string
  /** new | changed | removed | same, against the wrapper as it was. */
  status: "new" | "changed" | "removed" | "same"
  title: string | null
  description: string
  inputSchema: string
  annotations: string | null
  program: string
  /** The program before, when it changed. */
  previousProgram: string | null
  calls: string[]
  replaces: string[]
}

export type WrapperShownSecret = {
  secret: string
  tool: string
  serverName: string
  url: string
  argument: string
  template: string
  /** The owner types its value in on the page. */
  isNew: boolean
}

/** What the owner is shown, worked out when the request is made. */
export type WrapperShown = {
  title: string
  lines: string[]
  warning: string | null
  tools: WrapperShownTool[]
  secrets: WrapperShownSecret[]
}

export type WrapperChangeAsk = {
  action: "create" | "update" | "delete"
  /** The wrapper changed or deleted; null for a new one. */
  serverId: string | null
  /** The wrapper as it was when the owner was asked; null for a new one. */
  basis: string | null
  name: string
  description: string
  definition: WrapperDefinition | null
  /** A secret PCP does not hold yet, which the owner types in. */
  newSecret: string | null
  shown: WrapperShown
}

/** What get_wrapper and the owner's form read: other tools by short name. */
export type WrapperView = {
  id: string
  name: string
  slug: string
  description: string
  enabled: boolean
  tools: Array<
    Omit<WrapperToolInput, "calls" | "replaces"> & {
      calls: string[]
      replaces: string[]
    }
  >
  secrets: Array<SecretBindingInput & { template: string }>
}

function basisOf(
  server: { name: string; description: string },
  hash: string,
): string {
  return createHash("sha256")
    .update(canonicalJson([hash, server.name, server.description]))
    .digest("hex")
}

async function slugsById(
  ctx: VaultContext,
  ids: string[],
): Promise<Map<string, { slug: string; name: string }>> {
  const rows = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, id: { in: [...new Set(ids)] } },
    select: { id: true, slug: true, name: true },
  })

  return new Map(rows.map((row) => [row.id, row]))
}

/** A definition with other tools named by short name, as people write them. */
async function toInput(
  ctx: VaultContext,
  definition: WrapperDefinition,
): Promise<Pick<WrapperView, "tools" | "secrets">> {
  const servers = await slugsById(ctx, [
    ...definition.tools.flatMap((tool) =>
      [...tool.calls, ...tool.replaces].map((ref) => ref.serverId),
    ),
    ...definition.secrets.map((binding) => binding.serverId),
  ])
  const ref = (serverId: string, tool: string) =>
    `${servers.get(serverId)?.slug ?? "(removed server)"}/${tool}`

  return {
    tools: definition.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      program: tool.program,
      calls: tool.calls.map((call) => ref(call.serverId, call.tool)),
      replaces: tool.replaces.map((call) => ref(call.serverId, call.tool)),
    })),
    secrets: definition.secrets.map((binding) => ({
      secret: binding.secret,
      tool: ref(binding.serverId, binding.tool),
      argument: binding.argument,
      template: binding.template,
    })),
  }
}

async function loadWrapper(
  ctx: VaultContext,
  where: { slug: string } | { id: string },
) {
  const server = await db().mcpServer.findFirst({
    where: { vaultId: ctx.vaultId, kind: "wrapper", ...where },
    include: { wrapperSpec: true },
  })

  if (!server || !server.wrapperSpec) {
    throw notFound(
      "slug" in where ? `A wrapper called ${where.slug}` : "That wrapper",
    )
  }

  return {
    server,
    spec: server.wrapperSpec,
    definition: readDefinition(server.wrapperSpec.definition),
  }
}

/** A wrapper as get_wrapper and the owner's pages show it. */
export async function getWrapper(
  ctx: VaultContext,
  where: { slug: string } | { id: string },
): Promise<WrapperView> {
  const { server, definition } = await loadWrapper(ctx, where)

  return {
    id: server.id,
    name: server.name,
    slug: server.slug,
    description: server.description,
    enabled: server.enabled,
    ...(await toInput(ctx, definition)),
  }
}

/** For an assistant: a tool it may name is one it sees and is not blocked from. */
export function reachOf(servers: GatewayServer[]): Reach {
  return (server, tool) => {
    const own = servers.find((entry) => entry.id === server.id)
    const found = own?.tools.find((entry) => entry.name === tool)

    return found && found.access !== "blocked"
      ? null
      : `${server.slug}/${tool} is not a tool this token may use.`
  }
}

function prettySchema(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** What the owner reads about a change, against the wrapper as it is. */
async function describe(
  ctx: VaultContext,
  {
    action,
    name,
    description,
    before,
    after,
    previousName,
  }: {
    action: WrapperChangeAsk["action"]
    name: string
    description: string
    before: WrapperDefinition | null
    after: WrapperDefinition | null
    previousName: string | null
  },
): Promise<WrapperShown> {
  const shownAfter = after ? await toInput(ctx, after) : null
  const shownBefore = before ? await toInput(ctx, before) : null
  const servers = await slugsById(
    ctx,
    (after?.secrets ?? []).map((binding) => binding.serverId),
  )
  const tools: WrapperShownTool[] = []

  for (const tool of shownAfter?.tools ?? []) {
    const old = shownBefore?.tools.find((entry) => entry.name === tool.name)
    const same = old !== undefined && canonicalJson(old) === canonicalJson(tool)

    tools.push({
      name: tool.name,
      status: !old ? "new" : same ? "same" : "changed",
      title: tool.title ?? null,
      description: tool.description,
      inputSchema: prettySchema(tool.inputSchema),
      annotations: tool.annotations ? JSON.stringify(tool.annotations) : null,
      program: tool.program,
      previousProgram: old && old.program !== tool.program ? old.program : null,
      calls: tool.calls,
      replaces: tool.replaces,
    })
  }

  for (const old of shownBefore?.tools ?? []) {
    if (!shownAfter?.tools.some((tool) => tool.name === old.name)) {
      tools.push({
        name: old.name,
        status: "removed",
        title: old.title ?? null,
        description: old.description,
        inputSchema: prettySchema(old.inputSchema),
        annotations: old.annotations ? JSON.stringify(old.annotations) : null,
        program: old.program,
        previousProgram: null,
        calls: old.calls,
        replaces: old.replaces,
      })
    }
  }

  const secrets: WrapperShownSecret[] = (after?.secrets ?? []).map(
    (binding, index) => ({
      secret: binding.secret,
      tool: shownAfter!.secrets[index]!.tool,
      serverName: servers.get(binding.serverId)?.name ?? "(removed server)",
      url: binding.url,
      argument: binding.argument,
      template: binding.template,
      isNew: binding.secretId === null,
    }),
  )
  const replaced = [
    ...new Set(
      tools.flatMap((tool) => (tool.status === "removed" ? [] : tool.replaces)),
    ),
  ]
  const changed = tools.filter((tool) => tool.status !== "same")

  const title =
    action === "create"
      ? `Add the wrapper ${name}?`
      : action === "delete"
        ? `Delete the wrapper ${previousName ?? name}?`
        : `Change the wrapper ${previousName ?? name}?`

  const lines = [
    ...(action === "delete"
      ? [
          `Its tools stop working for every assistant, and the tools it stands in for show in search again.`,
        ]
      : [
          ...(previousName && previousName !== name
            ? [`New name: ${name}`]
            : []),
          ...(description ? [`Description: ${description}`] : []),
          `Tools: ${tools
            .filter((tool) => tool.status !== "removed")
            .map((tool) => tool.name)
            .join(", ")}`,
          ...(action === "update"
            ? [
                changed.length > 0
                  ? `Changed: ${changed.map((tool) => `${tool.name} (${tool.status})`).join(", ")}`
                  : "No tool changes.",
              ]
            : []),
          ...(replaced.length > 0
            ? [
                `Left out of search for every assistant, as the wrapper stands in for them (still callable): ${replaced.join(", ")}`,
              ]
            : []),
          "Each tool runs its program in PCP, with the arguments it is called with, and calls only the tools listed for it, at the calling token's own levels.",
        ]),
  ]

  const warning =
    secrets.length > 0
      ? `PCP will put ${secrets
          .map(
            (binding) =>
              `your secret "${binding.secret}"${binding.isNew ? " (new: you type its value in below)" : ""} into the argument ${binding.argument} of ${binding.tool} (${binding.serverName}, ${binding.url})`,
          )
          .join(
            "; ",
          )}. The programs never see it and PCP takes it out of what that tool answers, but what the tool does with it is up to the tool: allow it only where that argument is meant for a credential.`
      : null

  return { title, lines, warning, tools, secrets }
}

/**
 * The request for a new wrapper, checked as if it were being made: every
 * name it uses, every program, every secret's place.
 */
export async function proposeWrapper(
  ctx: VaultContext,
  input: WrapperInput,
  servers: GatewayServer[],
): Promise<WrapperChangeAsk> {
  await assertRoomForWrapper(ctx)
  const resolved = await resolveDefinition(ctx, input, {
    reach: reachOf(servers),
    allowNewSecret: true,
  })

  return {
    action: "create",
    serverId: null,
    basis: null,
    name: resolved.name,
    description: resolved.description,
    definition: resolved.definition,
    newSecret: resolved.newSecret,
    shown: await describe(ctx, {
      action: "create",
      name: resolved.name,
      description: resolved.description,
      before: null,
      after: resolved.definition,
      previousName: null,
    }),
  }
}

/** What update_wrapper takes: only what changes. */
export type WrapperChanges = {
  name?: string
  description?: string
  /** Tools to add, or to replace whole, by name. */
  tools?: WrapperToolInput[]
  /** Tools to take out, by name. */
  removeTools?: string[]
  /** Every place a secret goes, replacing the ones it has. */
  secrets?: SecretBindingInput[]
}

export async function proposeWrapperChange(
  ctx: VaultContext,
  slug: string,
  changes: WrapperChanges,
  servers: GatewayServer[],
): Promise<WrapperChangeAsk> {
  const { server, spec, definition } = await loadWrapper(ctx, { slug })
  const current = await toInput(ctx, definition)
  const removed = new Set(changes.removeTools ?? [])
  const upserts = changes.tools ?? []

  for (const name of removed) {
    if (!current.tools.some((tool) => tool.name === name)) {
      throw invalid(`${slug} has no tool called ${name}.`)
    }
  }

  const tools = [
    ...current.tools
      .filter((tool) => !removed.has(tool.name))
      .map((tool) => upserts.find((entry) => entry.name === tool.name) ?? tool),
    ...upserts.filter(
      (entry) => !current.tools.some((tool) => tool.name === entry.name),
    ),
  ]
  const resolved = await resolveDefinition(
    ctx,
    {
      name: changes.name ?? server.name,
      description: changes.description ?? server.description,
      tools,
      secrets: changes.secrets ?? current.secrets,
    },
    {
      reach: reachOf(servers),
      allowNewSecret: true,
      exceptServerId: server.id,
    },
  )

  // A binding the owner approved keeps its secret, even renamed since.
  resolved.definition.secrets = resolved.definition.secrets.map((binding) => {
    const kept = definition.secrets.find(
      (old) =>
        old.secret === binding.secret &&
        old.serverId === binding.serverId &&
        old.tool === binding.tool &&
        old.argument === binding.argument,
    )
    return kept?.secretId ? { ...binding, secretId: kept.secretId } : binding
  })

  if (resolved.definition.secrets.every((binding) => binding.secretId)) {
    resolved.newSecret = null
  }

  if (
    definitionHash(resolved.definition) === spec.hash &&
    resolved.name === server.name &&
    resolved.description === server.description
  ) {
    throw invalid(`That would not change ${slug}.`)
  }

  return {
    action: "update",
    serverId: server.id,
    basis: basisOf(server, spec.hash),
    name: resolved.name,
    description: resolved.description,
    definition: resolved.definition,
    newSecret: resolved.newSecret,
    shown: await describe(ctx, {
      action: "update",
      name: resolved.name,
      description: resolved.description,
      before: definition,
      after: resolved.definition,
      previousName: server.name,
    }),
  }
}

export async function proposeWrapperDelete(
  ctx: VaultContext,
  slug: string,
): Promise<WrapperChangeAsk> {
  const { server, spec, definition } = await loadWrapper(ctx, { slug })

  return {
    action: "delete",
    serverId: server.id,
    basis: basisOf(server, spec.hash),
    name: server.name,
    description: server.description,
    definition: null,
    newSecret: null,
    shown: await describe(ctx, {
      action: "delete",
      name: server.name,
      description: server.description,
      before: definition,
      after: null,
      previousName: server.name,
    }),
  }
}

async function assertRoomForWrapper(ctx: VaultContext): Promise<void> {
  const count = await db().mcpServer.count({
    where: { vaultId: ctx.vaultId, kind: "wrapper" },
  })

  if (count >= MAX_WRAPPERS) {
    throw invalid(
      `This vault has ${MAX_WRAPPERS} wrappers, as many as PCP keeps. Delete one first.`,
    )
  }
}

/**
 * The bindings' secrets, each by its id: the one the owner typed in, saved
 * now, or one by that name added since the request was made.
 */
async function withSecretIds(
  ctx: VaultContext,
  definition: WrapperDefinition,
  {
    newSecret,
    secretValue,
    wrapperName,
  }: {
    newSecret: string | null
    secretValue: string | undefined
    wrapperName: string
  },
): Promise<WrapperDefinition> {
  if (!definition.secrets.some((binding) => binding.secretId === null)) {
    return definition
  }

  let id: string | null = null

  if (secretValue) {
    id = (
      await createSecretNamedAfter(ctx, {
        base: newSecret ?? "Secret",
        value: secretValue,
        description: `Put by the wrapper ${wrapperName} into the calls the owner allowed.`,
      })
    ).id
  } else if (newSecret) {
    id = (await findTextSecretByName(ctx, newSecret))?.id ?? null
  }

  if (!id) {
    throw invalid(`Enter the value of the secret "${newSecret ?? "?"}".`)
  }

  return {
    ...definition,
    secrets: definition.secrets.map((binding) =>
      binding.secretId === null ? { ...binding, secretId: id } : binding,
    ),
  }
}

/** Every bound server is still at the address the owner was shown. */
async function checkBoundAddresses(
  ctx: VaultContext,
  definition: WrapperDefinition,
): Promise<void> {
  const servers = await db().mcpServer.findMany({
    where: {
      vaultId: ctx.vaultId,
      id: { in: definition.secrets.map((binding) => binding.serverId) },
    },
    select: { id: true, url: true, name: true },
  })

  for (const binding of definition.secrets) {
    const server = servers.find((entry) => entry.id === binding.serverId)

    if (!server || server.url !== binding.url) {
      throw new PcpError(
        "state",
        `The server the secret "${binding.secret}" goes to has been removed or moved since this was asked, so nothing changed. Ask again.`,
      )
    }
  }
}

/**
 * The owner agreed: the change is made as they saw it, or not at all when
 * the wrapper changed since. Returns what the assistant is told.
 */
export async function applyWrapperChange(
  ctx: VaultContext,
  ask: WrapperChangeAsk,
  { tokenId, secretValue }: { tokenId: string; secretValue?: string },
): Promise<string> {
  if (ask.action === "create") {
    await assertRoomForWrapper(ctx)
    const definition = await withSecretIds(ctx, ask.definition!, {
      newSecret: ask.newSecret,
      secretValue,
      wrapperName: ask.name,
    })
    await checkBoundAddresses(ctx, definition)
    const id = await createWrapperRow(
      ctx,
      ask.name,
      ask.description,
      definition,
    )
    const token = await db().apiToken.findUnique({
      where: { id: tokenId },
      select: { allowAllServers: true },
    })

    // A token that reaches only some servers reaches the wrapper it asked for.
    if (token && !token.allowAllServers) {
      await db().apiTokenServer.create({ data: { tokenId, serverId: id } })
    }

    const { slug } = await db().mcpServer.findUniqueOrThrow({
      where: { id },
      select: { slug: true },
    })

    return `The wrapper ${ask.name} was added as ${slug}, with ${definition.tools.length} tool${definition.tools.length === 1 ? "" : "s"}: ${definition.tools.map((tool) => `${slug}/${tool.name}`).join(", ")}.`
  }

  const { server, spec } = await loadWrapper(ctx, { id: ask.serverId! })

  if (basisOf(server, spec.hash) !== ask.basis) {
    throw new PcpError(
      "state",
      `${server.name} has changed since this was asked, so nothing changed. Read it again with get_wrapper and ask again.`,
    )
  }

  if (ask.action === "delete") {
    await deleteServer(ctx, server.id)
    return `The wrapper ${server.name} was deleted.`
  }

  const definition = await withSecretIds(ctx, ask.definition!, {
    newSecret: ask.newSecret,
    secretValue,
    wrapperName: ask.name,
  })
  await checkBoundAddresses(ctx, definition)
  await writeWrapper(ctx, server.id, ask.name, ask.description, definition)

  return `The wrapper ${ask.name} (${server.slug}) was changed as asked.`
}

async function createWrapperRow(
  ctx: VaultContext,
  name: string,
  description: string,
  definition: WrapperDefinition,
): Promise<string> {
  const id = newId()

  await db().$transaction([
    db().mcpServer.create({
      data: {
        id,
        vaultId: ctx.vaultId,
        kind: "wrapper",
        name,
        slug: await uniqueSlug(ctx.vaultId, slugify(name)),
        description,
        url: WRAPPER_URL,
        authType: "none",
      },
    }),
    db().wrapperSpec.create({
      data: {
        serverId: id,
        definition: JSON.stringify(definition),
        hash: definitionHash(definition),
      },
    }),
  ])
  await syncWrapperTools({ id })

  return id
}

async function writeWrapper(
  ctx: VaultContext,
  id: string,
  name: string,
  description: string,
  definition: WrapperDefinition,
): Promise<void> {
  await db().$transaction([
    db().mcpServer.update({ where: { id }, data: { name, description } }),
    db().wrapperSpec.update({
      where: { serverId: id },
      data: {
        definition: JSON.stringify(definition),
        hash: definitionHash(definition),
      },
    }),
  ])
  await syncWrapperTools({ id })
}

/**
 * The owner's own save, from PCP's pages: checked as an assistant's request
 * is, against every tool in the vault, with secrets the owner already holds.
 */
export async function saveWrapperByOwner(
  ctx: VaultContext,
  id: string | null,
  input: WrapperInput,
): Promise<{ id: string }> {
  const existing = id ? await loadWrapper(ctx, { id }) : null

  if (!existing) {
    await assertRoomForWrapper(ctx)
  }

  const resolved = await resolveDefinition(ctx, input, {
    allowNewSecret: false,
    ...(existing ? { exceptServerId: existing.server.id } : {}),
  })

  if (existing) {
    await writeWrapper(
      ctx,
      existing.server.id,
      resolved.name,
      resolved.description,
      resolved.definition,
    )
    return { id: existing.server.id }
  }

  return {
    id: await createWrapperRow(
      ctx,
      resolved.name,
      resolved.description,
      resolved.definition,
    ),
  }
}

/** Wrappers that stand in for a server's tools, by tool, for its page. */
export async function replacedTools(
  ctx: VaultContext,
  serverId: string,
): Promise<Map<string, Array<{ id: string; name: string; tool: string }>>> {
  const wrappers = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, kind: "wrapper" },
    include: { wrapperSpec: true },
  })
  const found = new Map<
    string,
    Array<{ id: string; name: string; tool: string }>
  >()

  for (const wrapper of wrappers) {
    if (!wrapper.wrapperSpec) {
      continue
    }

    for (const tool of readDefinition(wrapper.wrapperSpec.definition).tools) {
      for (const replaced of tool.replaces) {
        if (replaced.serverId === serverId) {
          const list = found.get(replaced.tool) ?? []
          list.push({ id: wrapper.id, name: wrapper.name, tool: tool.name })
          found.set(replaced.tool, list)
        }
      }
    }
  }

  return found
}

/**
 * The owner shows a replaced tool in search again: it is taken out of what
 * every wrapper's tools replace, each wrapper otherwise as it was.
 */
export async function showReplacedTool(
  ctx: VaultContext,
  serverId: string,
  toolName: string,
): Promise<void> {
  const wrappers = await db().mcpServer.findMany({
    where: { vaultId: ctx.vaultId, kind: "wrapper" },
    include: { wrapperSpec: true },
  })

  for (const wrapper of wrappers) {
    if (!wrapper.wrapperSpec) {
      continue
    }

    const definition = readDefinition(wrapper.wrapperSpec.definition)
    let changed = false
    const tools = definition.tools.map((tool) => {
      const replaces = tool.replaces.filter(
        (ref) => !(ref.serverId === serverId && ref.tool === toolName),
      )
      changed ||= replaces.length !== tool.replaces.length
      return { ...tool, replaces }
    })

    if (changed) {
      await writeWrapper(ctx, wrapper.id, wrapper.name, wrapper.description, {
        ...definition,
        tools,
      })
    }
  }
}
