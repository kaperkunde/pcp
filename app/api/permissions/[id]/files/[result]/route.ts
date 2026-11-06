import { asBytes } from "@/lib/core/crypto"
import { servedFile } from "@/lib/core/permission-files"
import { openRequestFile } from "@/lib/core/permissions"
import { isSameOrigin } from "@/lib/server/same-origin"
import { currentSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/** Ids are PCP's own: anything longer is not one. */
const MAX_ID = 64

/**
 * A file a call waiting for the owner carries, for the request's own page
 * (lib/core/permission-files.ts): shown in the page (a PDF in the browser's
 * viewer, an image, text as plain text) or, with `?download=1`, as a
 * download.
 *
 * A route handler, not a Server Action: a file needs Content-Type and
 * Content-Disposition, which an action cannot send. So it checks for itself
 * that the request came from PCP's own page and that the owner is signed
 * in, and serves only a result the waiting request's arguments name, of the
 * request's own token, opened with the owner's key in this request. Nothing
 * of the file is logged.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; result: string }> },
): Promise<Response> {
  if (!isSameOrigin(request)) {
    return problem(403, "That request did not come from PCP's own page.")
  }

  const session = await currentSession()

  if (!session) {
    return problem(401, "Sign in first.")
  }

  const { id, result } = await params

  if (id.length > MAX_ID || result.length > MAX_ID) {
    return problem(404, "That file is not there.")
  }

  let opened: Awaited<ReturnType<typeof openRequestFile>>

  try {
    opened = await openRequestFile(session.ctx, {
      permissionId: id,
      resultId: result,
    })
  } catch {
    console.error("[permission-file] could not be opened")

    return problem(500, "That file could not be opened.")
  }

  if (!opened) {
    return problem(
      404,
      "That file is not there: the request was answered or expired, or the file is no longer kept.",
    )
  }

  const download = new URL(request.url).searchParams.get("download") === "1"
  const file = servedFile(opened, { download })

  // A plain Uint8Array: Response does not take Node's Buffer as a body.
  return new Response(asBytes(file.body), {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": file.disposition,
      "Content-Length": String(file.body.length),
      "Content-Security-Policy": file.csp,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  })
}

function problem(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}
