import type { VaultContext } from "./context"
import { keyedHash, sha256Hex } from "./crypto"
import { canonicalJson } from "./permission-rules"
import {
  groupSelect,
  readFields,
  sealFields,
  type SealedGroup,
} from "./sealed-fields"

/**
 * What a server is built from, sealed (#96): an endpoint's schema text and
 * edits (openapi_spec), a wrapper's definition (wrapper_spec) and a
 * service's (service_spec), each under the vault's key as
 * "<table>:<server id>:<column>". Their `hash` is a keyed hash under the
 * vault's key, so equal content is still found equal (an instance's copy,
 * a request's basis) without the hash saying what the content is.
 *
 * A row from before holds the content in plain text, nothing sealed and a
 * plain SHA-256 as its hash, until the vault's rows are converted
 * (lib/core/sealing/convert.ts). Readers take either form, and the hash
 * they compare is the keyed one, worked out for a row from before.
 */

export const SPEC_TEXT: SealedGroup<
  { text: string },
  "sealedText",
  "serverId"
> = {
  column: "sealedText",
  idKey: "serverId",
  aad: (id) => `openapi_spec:${id}:sealedText`,
  blank: { text: "" },
}

export const SPEC_PATCHES: SealedGroup<
  { patches: string },
  "sealedPatches",
  "serverId"
> = {
  column: "sealedPatches",
  idKey: "serverId",
  aad: (id) => `openapi_spec:${id}:sealedPatches`,
  blank: { patches: "" },
}

export const WRAPPER_DEFINITION: SealedGroup<
  { definition: string },
  "sealedDefinition",
  "serverId"
> = {
  column: "sealedDefinition",
  idKey: "serverId",
  aad: (id) => `wrapper_spec:${id}:sealedDefinition`,
  blank: { definition: "" },
}

export const SERVICE_DEFINITION: SealedGroup<
  { definition: string },
  "sealedDefinition",
  "serverId"
> = {
  column: "sealedDefinition",
  idKey: "serverId",
  aad: (id) => `service_spec:${id}:sealedDefinition`,
  blank: { definition: "" },
}

/** The columns a reader selects for an endpoint's schema, edits and hash. */
export const SPEC_SELECT = {
  ...groupSelect(SPEC_TEXT),
  ...groupSelect(SPEC_PATCHES),
  hash: true,
} as const

/** … for a wrapper's definition and hash. */
export const WRAPPER_SPEC_SELECT = {
  ...groupSelect(WRAPPER_DEFINITION),
  hash: true,
} as const

/** … for a service's definition and hash. */
export const SERVICE_SPEC_SELECT = {
  ...groupSelect(SERVICE_DEFINITION),
  hash: true,
} as const

export type ContentKind = "openapi" | "wrapper" | "service"

/** The keyed hash of a server's content: a schema's text, a definition's JSON. */
export function contentHash(
  ctx: VaultContext,
  kind: ContentKind,
  text: string,
): string {
  return keyedHash(ctx.dek, `pcp ${kind} content`, text)
}

/**
 * Whether `hash` is the content's: its keyed hash, or the plain SHA-256 a
 * request asked before the vault's rows were sealed held.
 */
export function contentHashMatches(
  ctx: VaultContext,
  kind: ContentKind,
  text: string,
  hash: string,
): boolean {
  return hash === contentHash(ctx, kind, text) || hash === sha256Hex(text)
}

type SpecRow = {
  serverId: string
  plainText: string
  plainPatches: string
  sealedText: Uint8Array | null
  sealedPatches: Uint8Array | null
  hash: string
}

/** An endpoint's schema text, edits (as JSON) and keyed hash, opened. */
export function openSpec(
  ctx: VaultContext,
  row: SpecRow,
): { text: string; patches: string; hash: string } {
  const { text } = readFields(ctx.dek, SPEC_TEXT, row)
  const { patches } = readFields(ctx.dek, SPEC_PATCHES, row)

  return {
    text,
    patches,
    hash: row.sealedText ? row.hash : contentHash(ctx, "openapi", text),
  }
}

/** What an openapi_spec row stores for its text and hash. */
export function sealedSpecText(
  ctx: VaultContext,
  serverId: string,
  text: string,
): { sealedText: Uint8Array<ArrayBuffer>; plainText: string; hash: string } {
  return {
    ...(sealFields(ctx.dek, SPEC_TEXT, serverId, { text }) as {
      sealedText: Uint8Array<ArrayBuffer>
      plainText: string
    }),
    hash: contentHash(ctx, "openapi", text),
  }
}

/** What an openapi_spec row stores for its edits. */
export function sealedSpecPatches(
  ctx: VaultContext,
  serverId: string,
  patches: string,
): { sealedPatches: Uint8Array<ArrayBuffer>; plainPatches: string } {
  return sealFields(ctx.dek, SPEC_PATCHES, serverId, { patches }) as {
    sealedPatches: Uint8Array<ArrayBuffer>
    plainPatches: string
  }
}

type DefinitionRow = {
  serverId: string
  plainDefinition: string
  sealedDefinition: Uint8Array | null
  hash: string
}

function openDefinitionRow(
  ctx: VaultContext,
  group: typeof WRAPPER_DEFINITION,
  kind: "wrapper" | "service",
  row: DefinitionRow,
): { definition: string; hash: string } {
  const { definition } = readFields(ctx.dek, group, row)

  return {
    definition,
    hash: row.sealedDefinition
      ? row.hash
      : contentHash(ctx, kind, canonicalOf(definition)),
  }
}

/** A definition's canonical JSON, what its hash is of. */
export function canonicalOf(json: string): string {
  try {
    return canonicalJson(JSON.parse(json))
  } catch {
    return json
  }
}

/** A wrapper's definition (JSON) and keyed hash, opened. */
export function openWrapperSpec(ctx: VaultContext, row: DefinitionRow) {
  return openDefinitionRow(ctx, WRAPPER_DEFINITION, "wrapper", row)
}

/** A service's definition (JSON) and keyed hash, opened. */
export function openServiceSpec(ctx: VaultContext, row: DefinitionRow) {
  return openDefinitionRow(ctx, SERVICE_DEFINITION, "service", row)
}

function sealedDefinition(
  ctx: VaultContext,
  group: typeof WRAPPER_DEFINITION,
  kind: "wrapper" | "service",
  serverId: string,
  json: string,
  canonical: string,
): {
  sealedDefinition: Uint8Array<ArrayBuffer>
  plainDefinition: string
  hash: string
} {
  return {
    ...(sealFields(ctx.dek, group, serverId, { definition: json }) as {
      sealedDefinition: Uint8Array<ArrayBuffer>
      plainDefinition: string
    }),
    hash: contentHash(ctx, kind, canonical),
  }
}

/**
 * What a wrapper_spec row stores for its definition: the JSON sealed, and
 * the keyed hash of its canonical form (`canonical`).
 */
export function sealedWrapperDefinition(
  ctx: VaultContext,
  serverId: string,
  json: string,
  canonical: string,
) {
  return sealedDefinition(
    ctx,
    WRAPPER_DEFINITION,
    "wrapper",
    serverId,
    json,
    canonical,
  )
}

/** … and a service_spec row's. */
export function sealedServiceDefinition(
  ctx: VaultContext,
  serverId: string,
  json: string,
  canonical: string,
) {
  return sealedDefinition(
    ctx,
    SERVICE_DEFINITION,
    "service",
    serverId,
    json,
    canonical,
  )
}
