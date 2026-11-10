import type { VaultContext } from "./context"
import { calendarTools } from "./caldav/tools"
import { contentInstance } from "./definition-rows"
import { generateEndpointTools, storedSpec } from "./endpoints"
import { mailTools } from "./mail/tools"
import type { RegisterArgs } from "./permissions"
import {
  proposeToolAccess,
  type KnownTool,
  type ProposedAccess,
  type ToolAccessArg,
} from "./proposed-access"

/**
 * The tools a proposed server will have, where they are known before it
 * exists: an API endpoint's operations (from the schema the owner is shown),
 * a mail or calendar account's fixed tools. Null for an MCP server, whose
 * tools are known once PCP reads them.
 */
export async function knownRegisterTools(
  ctx: VaultContext,
  input: RegisterArgs,
): Promise<KnownTool[] | null> {
  if (input.endpoint) {
    // Another endpoint of a definition: the schema they share.
    const source =
      !input.endpoint.spec && input.definition
        ? await contentInstance(ctx, input.definition.id)
        : null
    const spec = source ? (await storedSpec(ctx, source.id))?.text : null

    return generateEndpointTools(spec ?? input.endpoint.spec, {
      readOnly: input.endpoint.readOnly,
      authHeaderNames: [],
      patches: input.endpoint.patches ?? [],
    }).tools.map((tool) => ({ name: tool.name, title: tool.title }))
  }

  if (input.mail) {
    // As many as the account may come to have: a tool it turns out not to
    // offer (a JMAP server that cannot send) is left alone.
    return mailTools({
      kind: input.mail.protocol,
      readOnly: input.mail.readOnly,
      canSend: input.mail.protocol === "jmap" || input.mail.smtpUrl !== null,
      canVacation: input.mail.protocol === "jmap",
    }).map((tool) => ({ name: tool.name, title: tool.title ?? null }))
  }

  if (input.calendar) {
    return calendarTools({ readOnly: input.calendar.readOnly }).map((tool) => ({
      name: tool.name,
      title: tool.title ?? null,
    }))
  }

  return null
}

/** register_server's tool_access, read against what it would add. */
export async function proposeRegisterAccess(
  ctx: VaultContext,
  input: RegisterArgs,
  arg: ToolAccessArg | undefined,
): Promise<ProposedAccess | null> {
  if (arg === undefined) {
    return null
  }

  const tools = await knownRegisterTools(ctx, input)

  return proposeToolAccess(arg, {
    ...(tools ? { tools } : {}),
    label: input.endpoint
      ? `The API ${input.name}`
      : input.mail
        ? "A mail account"
        : input.calendar
          ? "A calendar account"
          : `The server ${input.name}`,
  })
}

/** The request with what the assistant proposed for its tools, if anything. */
export async function withRegisterAccess(
  ctx: VaultContext,
  input: RegisterArgs,
  arg: ToolAccessArg | undefined,
): Promise<RegisterArgs> {
  const proposedAccess = await proposeRegisterAccess(ctx, input, arg)

  return proposedAccess ? { ...input, proposedAccess } : input
}
