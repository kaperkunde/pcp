import type { Metadata } from "next"
import Link from "next/link"

import { LocalDate } from "@/components/local-date"
import { PageHeader } from "@/components/page-header"
import { PermissionDecision } from "@/components/permission-decision"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getPermissionView } from "@/lib/core/permissions"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = {
  title: "Permission",
  robots: { index: false, follow: false },
}

export const dynamic = "force-dynamic"

const STATUS: Record<string, string> = {
  executed: "You allowed this and it ran.",
  running: "You allowed this; it is running now.",
  failed: "You allowed this, but it did not go through.",
  declined: "You said no, so nothing ran.",
  expired: "This expired without an answer, so nothing ran.",
}

/**
 * Where an assistant sends you to answer something it asked PCP for
 * (lib/core/permissions.ts): when its app cannot show the question itself,
 * or you would rather decide here.
 */
export default async function PermissionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const view = await getPermissionView(ctx, id, {
    publicUrl: await publicUrlFor(ctx),
  })

  if (!view) {
    return (
      <>
        <PageHeader title="Permission" />
        <p className="text-muted-foreground" role="alert">
          There is no request waiting for you at this link.
        </p>
      </>
    )
  }

  const pending = view.status === "pending"
  const memory = view.kind === "memory_share" || view.kind === "memory_change"
  // A memory's outcome says what was done, whichever answer it was.
  const showOutcome =
    (view.status === "executed" ||
      view.status === "failed" ||
      (memory && view.status === "declined")) &&
    view.outcome

  return (
    <>
      <PageHeader
        title={pending ? "An assistant is asking" : "Permission"}
        description={
          <>
            Asked through the token{" "}
            <Link href={`/tokens/${view.tokenId}`} className="underline">
              {view.tokenName}
            </Link>{" "}
            on <LocalDate value={view.createdAt} />.
            {pending ? " Nothing runs until you answer." : null}
          </>
        }
      />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="break-words">{view.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex list-disc flex-col gap-1 pl-5 break-words whitespace-pre-wrap">
            {view.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
          {view.warning ? (
            <p
              className="rounded-md border border-destructive/50 p-3"
              role="note"
            >
              {view.warning}
            </p>
          ) : null}
          {pending ? (
            <>
              {view.kind === "call" ? (
                <p className="text-muted-foreground">
                  Always allow and Block also decide the calls after this one.
                  You can change that on the token&apos;s page.
                </p>
              ) : view.kind === "memory_share" ? (
                <p className="text-muted-foreground">
                  Kept for this assistant only, it is saved where only the
                  assistant that asked reads it. You can read, edit and delete
                  every memory under{" "}
                  <Link href="/memories" className="underline">
                    Memories
                  </Link>
                  .
                </p>
              ) : null}
              <PermissionDecision
                id={view.id}
                decisions={view.decisions}
                newSecret={view.newSecret}
              />
            </>
          ) : (
            <div
              className="flex flex-col gap-2"
              data-testid="permission-outcome"
            >
              {memory && showOutcome ? null : (
                <p>{STATUS[view.status] ?? view.status}</p>
              )}
              {showOutcome ? (
                <p
                  className={
                    view.outcomeIsError
                      ? "whitespace-pre-wrap break-words text-destructive"
                      : "whitespace-pre-wrap break-words text-muted-foreground"
                  }
                >
                  {view.outcome}
                </p>
              ) : null}
            </div>
          )}
          {view.connect ? (
            <div className="flex flex-wrap items-center gap-3">
              {/* A plain anchor, not next/link: the route redirects to the
                  server's sign-in page, which must be a full page load. */}
              <a
                href={`/api/servers/${view.connect.serverId}/oauth/start`}
                className={buttonVariants({ size: "sm" })}
              >
                Connect {view.connect.name}
              </a>
              <span className="text-muted-foreground">
                {view.connect.name} needs you to sign in before it can be used.
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  )
}
