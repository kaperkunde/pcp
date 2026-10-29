/**
 * Bounds on checking a call's arguments against a schema (validate.ts). The
 * schema comes from a server or an API PCP does not control, and the
 * arguments from an assistant, so every walk is bounded.
 */

/** Schema-and-value pairs one check may visit before it gives up. */
export const MAX_VALIDATE_STEPS = 50_000
/** How deep a value may nest and still be checked. */
export const MAX_VALIDATE_DEPTH = 64
/** References one check may follow in a row, through #/$defs and the like. */
export const MAX_REF_HOPS = 32
/** Problems named for one call: past these, the rest wait for the next try. */
export const MAX_ARGUMENT_PROBLEMS = 10
/** A schema's pattern, in characters, that PCP still compiles and runs. */
export const MAX_PATTERN_CHARS = 500
/** A string, in characters, that a pattern is still run against. */
export const MAX_PATTERN_SUBJECT_CHARS = 100_000
/** The keys listed when a key is not one an object takes. */
export const MAX_LISTED_KEYS = 30
