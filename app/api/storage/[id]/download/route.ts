import { Readable } from "node:stream"

import { isPcpError } from "@/lib/core/errors"
import { openStorageDownload } from "@/lib/core/upstream"
import { publicUrlFor } from "@/lib/server/public-url"
import { isSameOrigin } from "@/lib/server/same-origin"
import { currentSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * One file of a store (lib/core/storage/), for the owner's file browser:
 * streamed from the SSH server over SFTP, or from PCP's data folder, as it
 * is read (and decrypted, for an encrypted store), never kept in PCP. A route handler, not a Server Action, for the export's
 * reason: a download needs Content-Disposition, and a file can be larger
 * than an action's answer. So it checks for itself that the request came
 * from PCP's own page (a link the owner clicked there) and that the owner
 * is signed in; the path is confined to the folder like an assistant's.
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
  const path = new URL(request.url).searchParams.get("path") ?? ""

  try {
    const file = await openStorageDownload(session.ctx, id, path, {
      publicUrl: await publicUrlFor(session.ctx),
    })

    return new Response(
      Readable.toWeb(file.stream) as ReadableStream<Uint8Array>,
      {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.length),
          "Content-Disposition": `attachment; filename="${asciiName(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          "X-Content-Type-Options": "nosniff",
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

/** The name for browsers that read only filename=: ASCII, no quotes. */
function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "file"
}

function problem(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
