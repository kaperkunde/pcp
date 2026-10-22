import { createHash } from "node:crypto"

import { canonicalJson } from "../permission-rules"

import { serializeItem, type ItemDocument } from "./documents"
import type { RepoFiles } from "./layout"

/**
 * A fingerprint of an item, for sync to tell whether it changed since it
 * last looked: SHA-256 of its files as PCP writes them (documents.ts), in
 * canonical JSON. It is taken from the serialized documents, not from the
 * files a repository holds, so the same item hashes the same whatever the
 * formatting it was read from: a file reflowed by an editor, keys in
 * another order, a missing final newline.
 */
export function localHash(document: ItemDocument): string {
  return filesHash(serializeItem(document))
}

/** SHA-256 of a file set, in canonical JSON, hex. */
export function filesHash(files: RepoFiles): string {
  return createHash("sha256").update(canonicalJson(files)).digest("hex")
}
