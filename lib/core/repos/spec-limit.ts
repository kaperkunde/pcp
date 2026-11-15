import { resourceLimits } from "../resources/state"

/**
 * An endpoint's OpenAPI document: what PCP takes as a schema anyway, so the
 * owner's own limit (Settings → Resources). A repository is no more trusted
 * than an assistant's text, and the same limit and the same bounded parse
 * (openapi/) apply to it; the browse's own total (MAX_BROWSE_BYTES) still
 * caps what one read fetches.
 */
export function maxSpecFileBytes(): number {
  return resourceLimits().specBytes
}

/** Everything one item's files add up to. */
export function maxItemBytes(): number {
  return maxSpecFileBytes() + 1024 * 1024
}
