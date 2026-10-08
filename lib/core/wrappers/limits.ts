/**
 * Bounds on a wrapper (lib/core/wrappers/). Its definition comes from an
 * assistant and the owner reads all of it before agreeing, so each part is
 * kept to what a person can read; its programs run on the owner's machine
 * like run_code's, under that tool's limits (code/limits.ts) and these.
 */

/** Wrappers in one vault. */
export const MAX_WRAPPERS = 50
/** Tools one wrapper has. */
export const MAX_WRAPPER_TOOLS = 30
/** One tool's program, in characters: the owner reads it whole. */
export const MAX_PROGRAM_CHARS = 20_000
/** One tool's input schema, as JSON. */
export const MAX_WRAPPER_SCHEMA_CHARS = 20_000
/** A tool's description, in characters. */
export const MAX_WRAPPER_DESCRIPTION_CHARS = 2_000
/** The tools one wrapper tool may call. */
export const MAX_CALLS_PER_TOOL = 20
/** Places a secret may go, in one wrapper. */
export const MAX_SECRET_BINDINGS = 20
/** A secret's place: the argument's JSON Pointer, in characters. */
export const MAX_ARGUMENT_POINTER_CHARS = 200
/** How the secret is written into its argument, in characters. */
export const MAX_SECRET_TEMPLATE_CHARS = 200
/**
 * One run of a wrapper tool, from start to end, the calls it waits on
 * included. Under run_code's, so a wrapper called from a program ends first.
 */
export const WRAPPER_RUN_TIMEOUT_MS = 2 * 60_000
/** How deep a secret placeholder may sit in a call's arguments. */
export const MAX_PLACEHOLDER_DEPTH = 64
/** Values one call's arguments may have, looked through for placeholders. */
export const MAX_PLACEHOLDER_NODES = 10_000
