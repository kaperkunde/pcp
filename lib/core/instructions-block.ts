import { MAX_INSTRUCTIONS_CHARS } from "./constants"

/**
 * How the owner's instructions for an assistant (lib/core/instructions.ts)
 * are given to it: the same block in the gateway's instructions and in
 * read_memory every. Kept apart so memories.ts can use it without the rest.
 */

/** The line the instructions stand under, wherever they are given. */
export const INSTRUCTIONS_LEAD = "The owner's instructions for this assistant:"

/** The block of instructions given to an assistant, or nothing for none. */
export function instructionsBlock(text: string | null | undefined): string[] {
  const trimmed = (text ?? "").trim()

  return trimmed
    ? [INSTRUCTIONS_LEAD, trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)]
    : []
}
