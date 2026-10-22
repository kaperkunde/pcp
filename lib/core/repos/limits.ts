import { MAX_SPEC_BYTES } from "../constants"

/**
 * Bounds on what a linked repository's files can make PCP read. Every file
 * in one is untrusted input: these hold before anything parses it, and the
 * validators each kind already has (skills.ts, wrappers/definition.ts,
 * openapi/) hold after.
 */

/**
 * Files one item may have: a wrapper's wrapper.yaml and a program per tool
 * (30 at most), a skill's SKILL.md and its reference files (10).
 */
export const MAX_ITEM_FILES = 40

/** One file other than an endpoint's OpenAPI document, in UTF-8 bytes. */
export const MAX_FILE_BYTES = 256 * 1024

/** An endpoint's OpenAPI document: what PCP takes as a schema anyway. */
export const MAX_SPEC_FILE_BYTES = MAX_SPEC_BYTES

/** Everything one item's files add up to. */
export const MAX_ITEM_BYTES = MAX_SPEC_BYTES + 1024 * 1024

/** A file's path from the repository's root, in characters. */
export const MAX_PATH_CHARS = 200

/** An item's name in its path (a slug), in characters. */
export const MAX_ITEM_NAME_CHARS = 64

/** How deep a PCP document's YAML may nest. */
export const MAX_DOCUMENT_DEPTH = 64
