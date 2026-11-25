import { z } from "zod"

import type { VaultContext } from "./context"
import { db } from "./db"
import { isPcpError } from "./errors"
import { missingResultMessage, parseHandle } from "./result-handles"
import { readSecretValueFromResult } from "./secrets"
import { SERVER_META_SELECT, serverName } from "./server-meta"
import { describeResults } from "./tool-results"

/**
 * A secret's value from a kept result (#174): request_secret's and
 * rotate_secret's `value_from`, a handle {"$result": id} of one of the
 * requesting token's own results (a pass-only one too: that is the point).
 * The request stores the handle's id and what the owner is shown of where it
 * came from, never the value; the value is read once, in secrets.ts
 * readSecretValueFromResult, inside the request that writes the secret (the
 * owner's yes, permissions.ts decidePermission), and goes nowhere else: not
 * the page, an answer, an error, the request log or the request.
 */

/** What the request keeps and the owner is shown of where a value is from. */
export type SecretValueFrom = {
  /** The kept result's id (never its content). */
  id: string
  /** The tool that made it, "server/tool", as the result recorded it. */
  source: string
  /** Characters of the value, when asked. */
  length: number
  /** The result was kept pass-only: the assistant never could read it. */
  passOnly: boolean
}

/** What the page shows: the same, and whether it is still there. */
export type SecretValueFromShown = SecretValueFrom & { expired: boolean }

/** `value_from`, as PCP's own tools take it: the handle alone. */
export function valueFromArg() {
  return z
    .strictObject({
      $result: z
        .string()
        .min(1)
        .max(64)
        .describe("The kept result's id, as a handle gave it."),
    })
    .describe(
      'Use a value PCP kept for you as the secret\'s value, so it never passes through you: a handle {"$result": "<id>"} of one of this token\'s own kept results, such as a token or password another tool answered with (a part named in keep is pass-only, which this accepts). The owner still approves on PCP\'s page, where they see which tool it came from and that you never saw it; it must be text, no control characters, not empty. Instead of generate; leave both out for the owner to type it.',
    )
}

/**
 * The handle checked for the requesting token, before the owner is asked:
 * its own live result, text that would do as the secret's value. A refusal
 * is the assistant's to fix, in words that never quote the value.
 */
export async function prepareValueFrom(
  ctx: VaultContext,
  tokenId: string,
  handle: unknown,
): Promise<{ from: SecretValueFrom } | { refused: string }> {
  let parsed: ReturnType<typeof parseHandle>

  try {
    parsed = parseHandle(handle)
  } catch (error) {
    if (isPcpError(error)) {
      return { refused: `value_from: ${error.message}` }
    }

    throw error
  }

  if (!parsed || parsed.as !== undefined) {
    return {
      refused:
        'value_from is a kept result\'s handle alone, {"$result": "<id>"}, as an answer gave it.',
    }
  }

  const [info] = await describeResults(ctx, tokenId, [parsed.$result])

  if (!info || !info.found) {
    return { refused: missingResultMessage() }
  }

  const read = await readSecretValueFromResult(ctx, tokenId, info.id)

  if (!read.ok) {
    return { refused: read.problem }
  }

  const server = info.serverId
    ? await db().mcpServer.findFirst({
        where: { id: info.serverId, vaultId: ctx.vaultId },
        select: SERVER_META_SELECT,
      })
    : null

  return {
    from: {
      id: info.id,
      source: server
        ? `${serverName(ctx, server)}/${info.toolName}`
        : info.toolName,
      length: read.value.length,
      passOnly: info.passOnly,
    },
  }
}

/** Where the page shows the value came from, and whether it is still kept. */
export async function shownValueFrom(
  ctx: VaultContext,
  tokenId: string,
  from: SecretValueFrom | null | undefined,
): Promise<SecretValueFromShown | null> {
  if (!from) {
    return null
  }

  const [info] = await describeResults(ctx, tokenId, [from.id])

  return { ...from, expired: !info || !info.found }
}
