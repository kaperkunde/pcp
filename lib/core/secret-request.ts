import { z } from "zod"

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
