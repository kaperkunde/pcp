import type { Metadata } from "next"

import { AuthShell } from "@/components/auth-shell"
import { UploadFiles } from "@/components/upload-files"
import { checkRateLimit } from "@/lib/core/rate-limit"
import { uploadPageView } from "@/lib/core/upload-links"
import { clientIp } from "@/lib/server/client-ip"

export const metadata: Metadata = {
  title: "Upload files",
  robots: { index: false, follow: false },
  // The address is the credential: nothing it links to learns it.
  referrer: "no-referrer",
}
export const dynamic = "force-dynamic"

/** As the file links' route counts them, per address (one limit for both). */
const RATE_LIMIT = { max: 60, windowMs: 60_000 }

/**
 * An upload link's page (lib/core/upload-links.ts): the owner opens it on
 * their phone or computer and sends an assistant files from there. Outside
 * the dashboard and without a session: the link's secret is the credential,
 * for this page alone. Each file goes to app/api/files/[secret]/ as a PUT
 * of its own; Done is a DELETE there.
 */
export default async function UploadPage({
  params,
}: {
  params: Promise<{ secret: string }>
}) {
  const { secret } = await params

  if (!checkRateLimit(`file-link:${await clientIp()}`, RATE_LIMIT)) {
    return (
      <AuthShell
        title="Upload files"
        intro={<p>Too many requests. Wait a minute and open the link again.</p>}
      >
        {null}
      </AuthShell>
    )
  }

  const view = await uploadPageView(secret)

  if (view.state === "gone") {
    return (
      <AuthShell
        title="Upload files"
        intro={
          <p>
            This link does not work: it has expired, or it was never one. Ask
            the assistant for a new one.
          </p>
        }
      >
        {null}
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Upload files"
      intro={
        <>
          <p>
            <span className="text-foreground">{view.assistant}</span> asks you
            for files:
          </p>
          <p className="mt-2 text-[15px] break-words text-foreground">
            {view.purpose}
          </p>
        </>
      }
    >
      <UploadFiles
        secret={secret}
        open={view.state === "open"}
        remaining={view.remaining}
        maxFiles={view.maxFiles}
        until={view.acceptUntil.toISOString()}
        received={view.files.map((file) => ({
          name: file.name,
          size: file.size,
        }))}
      />
    </AuthShell>
  )
}
