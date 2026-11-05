import { Readable } from "node:stream"

import { isPcpError } from "@/lib/core/errors"
import { dispositionOf } from "@/lib/core/permission-files"
import {
  contentRange,
  LOCKED_CSP,
  parseRange,
  previewOfName,
  servedPreview,
  SNIFF_BYTES,
  type ServedPreview,
} from "@/lib/core/storage/browse"
import { openStorageDownload } from "@/lib/core/upstream"
import { publicUrlFor } from "@/lib/server/public-url"
import { isSameOrigin } from "@/lib/server/same-origin"
import { currentSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * One file of a store (lib/core/storage/), for the owner's Files pages:
 * streamed from the SSH server over SFTP, or from PCP's data folder, as it
 * is read (and decrypted, for an encrypted store), never kept in PCP. A
 * route handler, not a Server Action, for the export's reason: a download
 * needs Content-Disposition, and a file can be larger than an action's
 * answer. So it checks for itself that the request came from PCP's own
 * page (a link the owner clicked there, a preview it shows) and that the
 * owner is signed in; the path is confined to the folder like an
 * assistant's.
 *
 * `?inline=1` is a preview (lib/core/storage/browse.ts): an image, a PDF,
 * a sound or a video as itself when its first bytes say so, text as plain
 * text, anything else as the download. A Range header gets that part
 * (206), so a sound or a video can seek and a text preview reads only its
 * start.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!isSameOrigin(request)) {
    return problem(403, "That request did not come from PCP's own page.")
  }

  const session = await currentSession()

  if (!session) {
    return problem(401, "Sign in first.")
  }

  const { id } = await params
  const query = new URL(request.url).searchParams
  const path = query.get("path") ?? ""
  const inline = query.get("inline") === "1"
  const rangeHeader = request.headers.get("range")
  const ctx = session.ctx
  const options = { publicUrl: await publicUrlFor(ctx) }

  try {
    const preview = inline ? previewOfName(path.split("/").at(-1) ?? "") : null
    let served: ServedPreview | null = null
    let size: number | null = null

    // The first bytes say what the file is, and the size where a range
    // needs it before the part is opened.
    if ((preview !== null && preview !== "text") || rangeHeader) {
      const head = await openStorageDownload(ctx, id, path, options, {
        offset: 0,
        length: SNIFF_BYTES,
      })
      size = head.size
      served = servedPreview(preview, await readAll(head.stream))
    } else {
      served = servedPreview(preview, new Uint8Array())
    }

    // An empty file has no part to serve: it goes whole (and empty).
    const range = size ? parseRange(rangeHeader, size) : null

    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": contentRange(null, size!),
          "Cache-Control": "no-store",
        },
      })
    }

    const file = await openStorageDownload(
      ctx,
      id,
      path,
      options,
      range ?? undefined,
    )
    const part = range ? { offset: file.offset, length: file.length } : null

    return new Response(
      Readable.toWeb(file.stream) as ReadableStream<Uint8Array>,
      {
        status: part ? 206 : 200,
        headers: {
          "Content-Type": served?.contentType ?? "application/octet-stream",
          "Content-Length": String(file.length),
          "Content-Disposition": dispositionOf(
            served ? "inline" : "attachment",
            file.name,
          ),
          "Content-Security-Policy": served?.csp ?? LOCKED_CSP,
          ...(part ? { "Content-Range": contentRange(part, file.size) } : {}),
          "Accept-Ranges": "bytes",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer",
          "Cache-Control": "no-store",
        },
      },
    )
  } catch (error) {
    if (isPcpError(error)) {
      return problem(
        error.code === "not_found"
          ? 404
          : error.code === "forbidden"
            ? 403
            : 400,
        error.message,
      )
    }

    return problem(502, "PCP could not read the file from the server.")
  }
}

/** A short stream read whole: the first bytes of a file. */
async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = []

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

function problem(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}
