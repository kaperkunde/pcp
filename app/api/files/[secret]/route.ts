import { asBytes } from "@/lib/core/crypto"
import {
  downloadByLink,
  uploadByLink,
  type LinkRefusal,
} from "@/lib/core/file-links"
import { checkRateLimit } from "@/lib/core/rate-limit"
import { UNEXPECTED_ERROR } from "@/lib/server/action-state"
import { clientIp } from "@/lib/server/client-ip"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * A file link (lib/core/file-links.ts): GET downloads the kept result a
 * share_result link names, PUT (or POST) sends the file a receive_file link
 * waits for, as the request's body. An assistant's own computer calls it
 * with curl, so there is no session, no page and no origin to check: the
 * link's secret is the credential, for that one file. A route handler, not
 * an action: a file needs Content-Disposition, and a body of its own.
 */

/** Guesses at secrets, per address; a real client makes a few calls. */
const RATE_LIMIT = { max: 60, windowMs: 60_000 }

type Params = { params: Promise<{ secret: string }> }

export async function GET(_request: Request, { params }: Params) {
  const limited = await rateLimited()

  if (limited) {
    return limited
  }

  try {
    const file = await downloadByLink((await params).secret)

    if (!file.ok) {
      return problem(file)
    }

    return new Response(asBytes(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.mediaType || "application/octet-stream",
        "Content-Disposition": disposition(file.name),
        "Content-Length": String(file.bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        // A file is the assistant's, not PCP's page: opened in a browser,
        // nothing in it runs under PCP's address.
        "Content-Security-Policy": "sandbox",
        "Referrer-Policy": "no-referrer",
      },
    })
  } catch (error) {
    console.error("[files] download failed", error)
    return problem({ ok: false, status: 500, message: UNEXPECTED_ERROR })
  }
}

async function receive(request: Request, { params }: Params) {
  const limited = await rateLimited()

  if (limited) {
    return limited
  }

  const length = request.headers.get("content-length")

  try {
    const received = await uploadByLink(
      (await params).secret,
      request.body as AsyncIterable<Uint8Array> | null,
      {
        contentType: request.headers.get("content-type"),
        contentLength: length && /^\d+$/.test(length) ? Number(length) : null,
      },
    )

    if (!received.ok) {
      return problem(received)
    }

    return Response.json(
      {
        received: received.size,
        result: {
          $result: received.resultId,
          type: received.mediaType,
          size: received.size,
          ...(received.name ? { name: received.name } : {}),
          readableUntil: received.readableUntil.toISOString(),
        },
        note: `PCP keeps the file for the assistant until ${received.readableUntil.toISOString()}: pass {"$result": "${received.resultId}"} where a tool wants a file.`,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    console.error("[files] upload failed", error)
    return problem({ ok: false, status: 500, message: UNEXPECTED_ERROR })
  }
}

export const PUT = receive
export const POST = receive

async function rateLimited(): Promise<Response | null> {
  return checkRateLimit(`file-link:${await clientIp()}`, RATE_LIMIT)
    ? null
    : problem({
        ok: false,
        status: 429,
        message: "Too many requests. Wait a minute.",
      })
}

/** attachment, with the name in ASCII and, where it is not, in UTF-8. */
function disposition(name: string | null): string {
  const file = name || "file"
  const ascii = file.replace(/[^\x20-\x7e]|["\\]/g, "_")

  return ascii === file
    ? `attachment; filename="${ascii}"`
    : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
}

function problem(refusal: LinkRefusal): Response {
  return Response.json(
    { error: refusal.message },
    { status: refusal.status, headers: { "Cache-Control": "no-store" } },
  )
}
