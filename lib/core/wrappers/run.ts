import type { CallToolResult } from "@modelcontextprotocol/server"

import type { McpServer } from "@/lib/generated/prisma/client"

import { isConnectResult } from "../connect"
import type { VaultContext } from "../context"
import { runProgram } from "../code/run"
import type { Executor } from "../code/types"
import { db } from "../db"
import { notFound, PcpError } from "../errors"
import { loadGatewayServers, type GatewayServer } from "../gateway-servers"
import {
  runCodeCall,
  type CodeCallOutcome,
  type PermissionExecutor,
} from "../permissions"
import { resourceLimits } from "../resources/state"

import {
  readDefinition,
  type WrapperDefinition,
  type WrapperTool,
} from "./definition"
import { WRAPPER_RUN_TIMEOUT_MS } from "./limits"
import type { SecretGrant } from "./placeholders"

/**
 * A call to a wrapper's tool: its program, run as run_code's are (one
 * QuickJS instance, the bridge in code/run.ts), with the caller's arguments
 * as `args`. What the program may call is narrower than what the token may:
 *
 * - only the tools the owner approved for this wrapper tool (`calls`), and
 *   never a wrapper's, so wrappers do not nest;
 * - at the calling token's own levels: a blocked tool is refused, and one
 *   that asks runs only in a call the owner allowed with its arguments in
 *   front of them (`approved`), never otherwise;
 * - a secret only as {"$secret": name}, where a binding the owner approved
 *   names that tool and argument; the value is put in by upstream.ts and
 *   taken out of the answer before the program sees it.
 */

export type WrapperEnv = {
  ctx: VaultContext
  tokenId: string
  publicUrl: string
  /** The token's servers; null for every server in the vault. */
  serverIds: string[] | null
  /**
   * The owner allowed this very call to the wrapper's tool on PCP's page:
   * the tools it calls that would ask run in this run, as often as the
   * program calls them (up to MAX_CALLS_PER_RUN in all), never asked again.
   */
  approved: boolean
  /** The token's servers and levels, when the caller has them already. */
  servers?: GatewayServer[]
  signal?: AbortSignal
  /** What runs the programs; replaced in tests. */
  codeExecutor?: Executor
}

/**
 * The executor a gateway call or an allowed request runs with: a wrapper's
 * tool runs its program, whose calls go to `base`, which runs no wrapper.
 */
export function withWrappers(
  base: PermissionExecutor,
  env: WrapperEnv,
): PermissionExecutor {
  return {
    ...base,
    callTool: (ctx, server, toolName, args, options) =>
      server.kind === "wrapper"
        ? callWrapperTool(env, base, server, toolName, args)
        : base.callTool(ctx, server, toolName, args, options),
  }
}

/** The servers a token reaches, for a request the owner answered. */
export async function tokenServerIds(
  ctx: VaultContext,
  tokenId: string,
): Promise<string[] | null> {
  const token = await db().apiToken.findFirst({
    where: { id: tokenId, vaultId: ctx.vaultId },
    select: { allowAllServers: true, servers: { select: { serverId: true } } },
  })

  if (!token) {
    throw notFound("That token")
  }

  return token.allowAllServers
    ? null
    : token.servers.map((link) => link.serverId)
}

function text(value: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
  }
}

function withLead(lead: string, result: CallToolResult): CallToolResult {
  const [first, ...rest] = result.content

  return first?.type === "text"
    ? {
        ...result,
        content: [{ ...first, text: `${lead}\n\n${first.text}` }, ...rest],
      }
    : { ...result, content: [{ type: "text", text: lead }, ...result.content] }
}

const JSON_TYPES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number",
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  object: (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  null: (value) => value === null,
}

/**
 * The arguments against the tool's schema, at its top level: the required
 * ones are there and each has its type. The program checks the rest.
 */
export function checkArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  const required = Array.isArray(schema.required) ? schema.required : []

  for (const name of required) {
    if (typeof name === "string" && !Object.hasOwn(args, name)) {
      return `The argument "${name}" is required.`
    }
  }

  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, { type?: unknown }>)
      : {}

  for (const [name, value] of Object.entries(args)) {
    const property = properties[name]

    if (!property) {
      if (schema.additionalProperties === false) {
        return `There is no argument "${name}". Arguments: ${Object.keys(properties).join(", ") || "(none)"}.`
      }

      continue
    }

    const types = (
      Array.isArray(property.type) ? property.type : [property.type]
    ).filter((type): type is string => typeof type === "string")

    if (
      types.length > 0 &&
      !types.some((type) => JSON_TYPES[type]?.(value) ?? true)
    ) {
      return `The argument "${name}" is ${types.join(" or ")}.`
    }
  }

  return null
}

async function callWrapperTool(
  env: WrapperEnv,
  base: PermissionExecutor,
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const spec = await db().wrapperSpec.findUnique({
    where: { serverId: server.id },
  })

  if (!spec) {
    throw new PcpError("state", `${server.name} has no definition.`)
  }

  const definition = readDefinition(spec.definition)
  const tool = definition.tools.find((entry) => entry.name === toolName)

  if (!tool) {
    throw notFound(`${server.slug}/${toolName}`)
  }

  const problem = checkArgs(tool.inputSchema, args)

  if (problem) {
    return text(`${server.slug}/${toolName}: ${problem}`, true)
  }

  const servers = env.servers ?? (await loadGatewayServers(env))
  const label = `${server.slug}/${toolName}`
  const run = await runProgram(
    env,
    { code: tool.program, input: JSON.stringify(args), label: "wrapper" },
    {
      call: (input) => innerCall(env, base, servers, tool, input, definition),
      ...(env.signal ? { signal: env.signal } : {}),
      ...(env.codeExecutor ? { executor: env.codeExecutor } : {}),
      timeoutMs: WRAPPER_RUN_TIMEOUT_MS,
    },
  )

  if ("busy" in run) {
    throw new PcpError("state", run.busy)
  }

  const { result, stop } = run

  if (result.kind === "stopped" && stop) {
    return withLead(
      isConnectResult(stop.result)
        ? `${label} calls ${stop.at}, which the owner has to connect first; nothing after that call ran. Once they have (check_server says when), call ${label} again.`
        : `${label} calls ${stop.at}, which needs the owner first; nothing after that call ran. Once they have answered below, call ${label} again.`,
      stop.result,
    )
  }

  if (result.kind === "done") {
    if (result.returned === null) {
      return text(`${label} finished and returned nothing.`)
    }

    let value: unknown

    try {
      value = JSON.parse(result.returned)
    } catch {
      value = result.returned
    }

    return text(typeof value === "string" ? value : result.returned)
  }

  const printed = result.output.trim()

  return text(
    [
      `${label} failed: ${result.kind === "error" ? result.message : "it was stopped."}`,
      ...(printed ? [`It printed:\n${printed.slice(0, 4_000)}`] : []),
    ].join("\n\n"),
    true,
  )
}

/** One call a wrapper tool's program makes. */
async function innerCall(
  env: WrapperEnv,
  base: PermissionExecutor,
  servers: GatewayServer[],
  tool: WrapperTool,
  {
    server: slug,
    tool: name,
    args,
    ...shape
  }: Parameters<Parameters<typeof runProgram>[2]["call"]>[0],
  definition: Pick<WrapperDefinition, "secrets">,
): Promise<CodeCallOutcome> {
  const target = servers.find((entry) => entry.slug === slug)
  const declared =
    target &&
    tool.calls.some((call) => call.serverId === target.id && call.tool === name)

  if (!target || !declared || target.kind === "wrapper") {
    return {
      ok: false,
      error: `${tool.name} may call only the tools the owner approved for it, and ${slug}/${name} is not one of them.`,
    }
  }

  const level = target.tools.find((entry) => entry.name === name)?.access

  if (level === undefined || level === "blocked") {
    return {
      ok: false,
      error: `${slug}/${name} is blocked for this token, so ${tool.name} cannot call it.`,
    }
  }

  if (level === "ask" && !env.approved) {
    return {
      ok: false,
      error: `${slug}/${name} asks the owner first for this token. Call the wrapper's tool again: it asks the owner for the whole call.`,
    }
  }

  const secrets: SecretGrant = definition.secrets.flatMap((binding) =>
    binding.serverId === target.id &&
    binding.tool === name &&
    binding.secretId !== null
      ? [
          {
            pointer: binding.argument,
            name: binding.secret,
            secretId: binding.secretId,
            template: binding.template,
            url: binding.url,
          },
        ]
      : [],
  )

  return runCodeCall(env.ctx, target, name, args, {
    publicUrl: env.publicUrl,
    tokenId: env.tokenId,
    max: resourceLimits().answerChars,
    executor: base,
    ...(secrets.length > 0 ? { secrets } : {}),
    ...shape,
  })
}
