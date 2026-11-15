import { asBytes, decryptString, encryptString } from "./crypto"

/**
 * A linked file's name (file_link, #96), sealed under the link's key with
 * "file_link_name:<id>" as its bytes are: whoever holds the link sees it,
 * and the token through an upload's wrapped key, nobody else. Its own
 * module so tool-results.ts, which file-links.ts imports, can open one.
 */

function nameAad(id: string): string {
  return `file_link_name:${id}`
}

export function sealLinkName(
  key: Buffer,
  id: string,
  name: string | null,
): Uint8Array<ArrayBuffer> | null {
  return name === null ? null : asBytes(encryptString(key, name, nameAad(id)))
}

/** A linked file's name, opened (or as it was, on a row from before). */
export function openLinkName(
  key: Buffer,
  row: { id: string; plainName: string | null; sealedName: Uint8Array | null },
): string | null {
  return row.sealedName
    ? decryptString(key, Buffer.from(row.sealedName), nameAad(row.id))
    : row.plainName
}
