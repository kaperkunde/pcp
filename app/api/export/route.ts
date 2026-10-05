import { exportFileName, exportVault } from "@/lib/core/backup"
import { asBytes } from "@/lib/core/crypto"
import { isPcpError } from "@/lib/core/errors"
import { validatePassword } from "@/lib/core/vault"
import { UNEXPECTED_ERROR } from "@/lib/server/action-state"
import { confirmOwner } from "@/lib/server/password-attempts"
import { isSameOrigin } from "@/lib/server/same-origin"
import { currentSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"

/** The form holds three passwords; anything near this is not that form. */
const MAX_FORM_BYTES = 64 * 1024

/**
 * The export file, for the signed-in owner (lib/core/backup.ts).
 *
 * A route handler, not a Server Action: a download needs Content-Disposition
 * on the response, which an action cannot set. So it checks for itself what
 * an action gets for free — that the request came from PCP's own page — and
 * answers a missing session with 401 rather than a redirect, which a page's
 * fetch() would follow and take for a file.
 *
 * An export is a lasting copy of the vault, so like making a token it asks
 * for the owner's password again, or Touch ID in the Mac app
 * (lib/server/password-attempts.ts).
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return problem(403, "That request did not come from PCP's own page.")
  }

  const length = request.headers.get("content-length")

  if (length === null || !/^\d+$/.test(length)) {
    return problem(411, "The request has no length.")
  }

  if (Number(length) > MAX_FORM_BYTES) {
    return problem(413, "The request is too large.")
  }

  const session = await currentSession()

  if (!session) {
    return problem(401, "Sign in first.")
  }

  let form: FormData

  try {
    form = await request.formData()
  } catch {
    return problem(400, "The form could not be read.")
  }

  const exportPassword = text(form, "exportPassword")

  if (exportPassword !== text(form, "exportPasswordConfirm")) {
    return problem(400, "The export passwords do not match.")
  }

  const weak = validatePassword(exportPassword)

  if (weak) {
    return problem(400, weak)
  }

  try {
    await confirmOwner(session, form)
    const file = await exportVault(session.ctx, exportPassword)

    // A plain Uint8Array: Response does not take Node's Buffer as a body.
    return new Response(asBytes(file), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${exportFileName(new Date())}"`,
        "Content-Length": String(file.length),
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    if (isPcpError(error)) {
      const status =
        error.code === "unauthorized"
          ? 401
          : error.code === "forbidden"
            ? 429
            : 400

      return problem(status, error.message)
    }

    console.error("[export] failed", error)

    return problem(500, UNEXPECTED_ERROR)
  }
}

function text(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === "string" ? value : ""
}

function problem(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}
