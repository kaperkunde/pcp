/**
 * The files a call waiting for the owner carries: every kept result its
 * arguments name ({"$result": id}, at any depth, in any tool's arguments),
 * shown on the request's page as a chip the owner can open and download
 * before they answer, and the rules for serving one.
 *
 * A file is served to the owner's own page only (app/api/permissions/[id]/
 * files/[result]/route.ts), only while the request waits, only when the
 * request's arguments name it, and only from the results of the request's
 * own token (`openResult` checks the token and the day it is kept for).
 * Nothing here reads a result's content: the route opens it with the
 * owner's key in the request that asks.
 */

import type { VaultContext } from "./context"
import { db } from "./db"
import { bareType, isTextType, sniffMediaType } from "./media-types"
import { isOpen, visible } from "./permission-rules"
import { collectHandleIds } from "./result-handles"
import { describeResults, type ResultKind } from "./tool-results"
import { SERVER_META_SELECT, serverSlug } from "./server-meta"

/** How the owner's page can show a file before they download it. */
export type FilePreview = "pdf" | "image" | "text" | null

/** A file a waiting call carries, as its chip shows it. No content. */
export type RequestFile =
  | { id: string; found: false }
  | {
      id: string
      found: true
      /** The name it was kept with, as the owner reads it; null when none. */
      name: string | null
      mediaType: string
      kind: ResultKind
      /** Bytes, or characters for a text result. */
      length: number
      /** The length as the owner reads it: "12.3 KB", "1,204 characters". */
      size: string
      /** The tool that kept it, as `server/tool` (or PCP's own tool name). */
      from: string
      expiresAt: Date
      preview: FilePreview
    }

/** Images a browser shows as they are, with no script in them (not SVG). */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
])

/** How a file of this type is previewed, by what it says it is. */
export function previewOf(kind: ResultKind, mediaType: string): FilePreview {
  const bare = bareType(mediaType)

  if (bare === "application/pdf") {
    return "pdf"
  }

  if (IMAGE_TYPES.has(bare)) {
    return "image"
  }

  return kind === "text" || isTextType(bare) ? "text" : null
}

/**
 * The result ids a call's arguments name, once each, in order: handles and
 * attachments, at any depth. Arguments too deep to walk name none here; the
 * call itself refuses them.
 */
export function namedResultIds(args: unknown): string[] {
  try {
    return collectHandleIds(args, { loose: true })
  } catch {
    return []
  }
}

/**
 * What each kept result a call's arguments name is, so the owner sees what
 * the call carries: its name, type and size, which tool kept it, and until
 * when. An id the token no longer has is listed too, since the call would
 * fail.
 */
export async function requestFiles(
  ctx: VaultContext,
  tokenId: string,
  args: Record<string, unknown>,
  now = new Date(),
): Promise<RequestFile[]> {
  const infos = await describeResults(ctx, tokenId, namedResultIds(args), now)
  const serverIds = infos.flatMap((info) =>
    info.found && info.serverId ? [info.serverId] : [],
  )
  const servers = serverIds.length
    ? await db().mcpServer.findMany({
        where: { id: { in: serverIds }, vaultId: ctx.vaultId },
        select: SERVER_META_SELECT,
      })
    : []
  const slugs = new Map(
    servers.map((server) => [server.id, serverSlug(ctx, server)]),
  )

  return infos.map((info): RequestFile => {
    if (!info.found) {
      return { id: info.id, found: false }
    }

    return {
      id: info.id,
      found: true,
      name: info.name === null ? null : visible(info.name, { oneLine: true }),
      mediaType: visible(info.mediaType, { oneLine: true }),
      kind: info.kind,
      length: info.length,
      size: sizeLabel(info.kind, info.length),
      from: info.serverId
        ? `${slugs.get(info.serverId) ?? "(removed server)"}/${info.toolName}`
        : info.toolName,
      expiresAt: info.expiresAt,
      preview: previewOf(info.kind, info.mediaType),
    }
  })
}

const COUNT = new Intl.NumberFormat("en-US")
const ONE_DECIMAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 })

/** A length as the owner reads it: bytes in B, KB or MB; text in characters. */
export function sizeLabel(kind: ResultKind, length: number): string {
  if (kind === "text") {
    return `${COUNT.format(length)} character${length === 1 ? "" : "s"}`
  }

  if (length < 1024) {
    return `${COUNT.format(length)} B`
  }

  if (length < 1024 * 1024) {
    return `${ONE_DECIMAL.format(length / 1024)} KB`
  }

  return `${ONE_DECIMAL.format(length / (1024 * 1024))} MB`
}

/** A file as one line of text, for what the assistant is told. */
export function fileLine(file: RequestFile): string {
  if (!file.found) {
    return `Kept result ${file.id}: no longer available for this token; the call will fail`
  }

  const size =
    file.kind === "bytes"
      ? `${COUNT.format(file.length)} bytes`
      : `${COUNT.format(file.length)} characters`

  return `Kept result ${file.id}: ${file.name ?? "(unnamed)"}, ${file.mediaType}, ${size}, from ${file.from}, readable until ${file.expiresAt.toISOString()}`
}

/**
 * Whether the owner's page may be served the result `resultId` of this
 * request: a call, still waiting (not answered, not expired), whose
 * arguments name it. The result's own token and expiry are `openResult`'s
 * to check, with the request's token.
 */
export function requestServes(
  request: { kind: string; status: string; expiresAt: Date },
  args: unknown,
  resultId: string,
  now = new Date(),
): boolean {
  return (
    request.kind === "call" &&
    isOpen(request, now) &&
    typeof resultId === "string" &&
    resultId !== "" &&
    namedResultIds(args).includes(resultId)
  )
}

/** The headers a served file goes out with, and the body to send. */
export type ServedFile = {
  contentType: string
  disposition: string
  /** Content-Security-Policy: nothing in it runs, loads or frames it. */
  csp: string
  body: Buffer
}

/** A file name for Content-Disposition, in ASCII and in UTF-8. */
export function dispositionOf(
  type: "inline" | "attachment",
  name: string | null,
): string {
  const plain = (name ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/[\\/]/g, "_")
    .trim()
  const fallback =
    plain.replace(/[^\x20-\x7e]/g, "_").replace(/["%;]/g, "_") || "file"
  const encoded = encodeURIComponent(plain || "file").replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )

  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/**
 * How a kept result goes to the owner's page. A download is always an
 * attachment of no type a browser would run. Shown in the page, a PDF goes
 * as itself to the browser's own viewer and an image as itself, each only
 * when its first bytes say it is what it claims; text goes as plain text
 * (HTML and SVG among it, so none of it runs); anything else only as a
 * download.
 */
export function servedFile(
  result: {
    kind: ResultKind
    mediaType: string
    name: string | null
    text(): string
    bytes(): Buffer
  },
  { download }: { download: boolean },
): ServedFile {
  // A sandboxed document runs nothing, even where its type is wrong.
  const locked = "default-src 'none'; frame-ancestors 'none'; sandbox"
  const attachment = (): ServedFile => ({
    contentType: "application/octet-stream",
    disposition: dispositionOf("attachment", result.name),
    csp: locked,
    body: result.bytes(),
  })

  if (download) {
    return attachment()
  }

  const preview = previewOf(result.kind, result.mediaType)
  const bare = bareType(result.mediaType)

  if (preview === "pdf" || preview === "image") {
    const bytes = result.bytes()

    if (result.kind !== "bytes" || sniffMediaType(bytes) !== bare) {
      return attachment()
    }

    return {
      contentType: bare,
      disposition: dispositionOf("inline", result.name),
      // The browser's PDF viewer does not open in a sandboxed document,
      // nor, in some browsers, under a policy that blocks plugins: a PDF
      // whose first bytes say it is one, sent as one with nosniff, runs
      // nothing of the page's.
      csp: preview === "pdf" ? "frame-ancestors 'none'" : locked,
      body: bytes,
    }
  }

  if (preview === "text") {
    let text: string

    try {
      text = result.text()
    } catch {
      return attachment()
    }

    return {
      contentType: "text/plain; charset=utf-8",
      disposition: dispositionOf("inline", result.name),
      csp: locked,
      body: Buffer.from(text, "utf8"),
    }
  }

  return attachment()
}
