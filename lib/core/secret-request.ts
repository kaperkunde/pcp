import { z } from "zod"

import { checkSecretRequest } from "./browser-secrets"
import type { SecretRequestAsk } from "./browser/types"
import type { VaultContext } from "./context"
import { isPcpError } from "./errors"
import { prepareValueFrom } from "./secret-from-result"
import {
  MAX_GENERATE_EXCLUDE,
  MAX_GENERATED_LENGTH,
  MIN_GENERATED_LENGTH,
  SECRET_FORMATS,
} from "./constants"

/**
 * The recipe of a value PCP makes for a new secret, as a tool's argument
 * (request_secret's `generate`, register_server's, and env_secrets' per
 * variable): checked in full by generate-password.ts checkPasswordRecipe
 * before anything is asked. The owner sees it filled in on the request's
 * page and may change it, or type a value instead; PCP makes the value when
 * they save, and nobody else ever sees it.
 */
export function recipeArg(what: string) {
  return z
    .strictObject({
      format: z
        .enum(SECRET_FORMATS)
        .optional()
        .describe(
          "password (the default for a password, from the kinds of character below), alphanumeric (letters and digits: the default for a token), hex or base64url.",
        ),
      length: z
        .number()
        .int()
        .min(MIN_GENERATED_LENGTH)
        .max(MAX_GENERATED_LENGTH)
        .optional()
        .describe(
          `How many characters, ${MIN_GENERATED_LENGTH} to ${MAX_GENERATED_LENGTH}: 24 for a password and 48 for a token by default. Keep within the site's maximum.`,
        ),
      lowercase: z
        .boolean()
        .optional()
        .describe("A password's lower-case letters: true by default."),
      uppercase: z
        .boolean()
        .optional()
        .describe("A password's capital letters: true by default."),
      digits: z
        .boolean()
        .optional()
        .describe("A password's digits: true by default."),
      symbols: z
        .boolean()
        .optional()
        .describe(
          "A password's symbols such as !#$%&*+-.:;<=>?@^_~: true by default. false for a site that refuses them.",
        ),
      exclude: z
        .string()
        .max(MAX_GENERATE_EXCLUDE)
        .optional()
        .describe(
          "Characters to leave out of a password or of letters and digits: <>&.",
        ),
    })
    .describe(what)
}

/** request_secret's arguments, as PCP's own tool takes them. */
export type SecretRequestArgs = {
  name: string
  purpose: string
  kind?: "text" | "totp"
  username?: string
  origins?: string[]
  generate?: unknown
  /** A kept result's handle (#174, secret-from-result.ts); never with generate. */
  value_from?: unknown
}

/**
 * PCP's own request_secret (#162): the owner is asked to store a secret on
 * PCP's page, typed in or made by PCP there, its sites optional. The
 * browser's request_secret, an alias for one release, asks the same
 * (browser/call.ts). Checked before the owner is asked; a refusal is the
 * assistant's to fix, said in words.
 */
export async function prepareSecretRequest(
  ctx: VaultContext,
  args: SecretRequestArgs,
  tokenId?: string,
): Promise<{ ask: SecretRequestAsk } | { refused: string }> {
  try {
    if (args.value_from !== undefined) {
      if (args.generate !== undefined) {
        return {
          refused:
            "value_from and generate are two ways to give the value: leave one out.",
        }
      }

      if (args.kind === "totp") {
        return {
          refused:
            "One-time codes come from the site's seed, which the owner types: leave value_from out.",
        }
      }
    }

    const ask = await checkSecretRequest(ctx, null, {
      name: args.name,
      purpose: args.purpose,
      ...(args.origins ? { origins: args.origins } : {}),
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.username !== undefined ? { username: args.username } : {}),
      ...(args.generate !== undefined ? { generate: args.generate } : {}),
    })

    if (args.value_from === undefined) {
      return { ask }
    }

    // The requesting token's own kept result, checked before the owner is
    // asked; the request keeps its id and where it came from, never a value.
    const from = tokenId
      ? await prepareValueFrom(ctx, tokenId, args.value_from)
      : { refused: "value_from needs the token that asks." }

    return "refused" in from ? from : { ask: { ...ask, valueFrom: from.from } }
  } catch (error) {
    if (isPcpError(error)) {
      return { refused: error.message }
    }

    throw error
  }
}
