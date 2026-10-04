import type { Metadata } from "next"
import Link from "next/link"

import { AccessReview } from "@/components/access-review"
import { LocalDate } from "@/components/local-date"
import { PageHeader } from "@/components/page-header"
import { PermissionDecision } from "@/components/permission-decision"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { MemoryShown } from "@/lib/core/memories"
import { getAccessProposal, getPermissionView } from "@/lib/core/permissions"
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

/** The same, for tool levels an assistant proposed. */
const ACCESS_STATUS: Record<string, string> = {
  executed: "You saved these levels.",
  running: "Saving now.",
  failed: "You saved, but the levels were not written.",
  declined: "You said no, so no tool's level changed.",
  expired: "This expired without an answer, so no tool's level changed.",
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
  const access = view.kind === "access"
  // A memory's outcome says what was done, whichever answer it was. Saved
  // levels' outcome is written for the assistant; the status says it here.
  const showOutcome =
    !access &&
    (view.status === "executed" ||
      view.status === "failed" ||
      (memory && view.status === "declined")) &&
    view.outcome
  const proposal = access && pending ? await getAccessProposal(ctx, id) : null

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
            {pending
              ? access
                ? " Nothing changes until you save."
                : " Nothing runs until you answer."
              : null}
          </>
        }
      />
      <Card className={access && pending ? "max-w-4xl" : "max-w-2xl"}>
        <CardHeader>
          <CardTitle className="break-words">{view.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {view.memory ? (
            <MemoryText memory={view.memory} asking={view.kind} />
          ) : (
            <ul className="flex list-disc flex-col gap-1 pl-5 break-words whitespace-pre-wrap">
              {view.lines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          )}
          {view.warning && view.memory ? (
            // The text is what to check; the warning says what to look for,
            // under it, without drawing the eye away from it.
            <p
              className="border-l-2 pl-3 text-sm text-muted-foreground"
              role="note"
            >
              {view.warning}
            </p>
          ) : view.warning ? (
            <p
              className="rounded-md border border-destructive/50 p-3"
              role="note"
            >
              {view.warning}
            </p>
          ) : null}
          {pending && proposal ? (
            <>
              <p className="text-muted-foreground">
                The assistant&apos;s levels are filled in below and every change
                is marked. Change any of them, then save; you can change them
                again on the token&apos;s page.
                {proposal.gone > 0
                  ? ` ${proposal.gone} of the proposed tools are no longer on this token and are left out.`
                  : null}
              </p>
              <AccessReview
                id={view.id}
                servers={proposal.servers}
                proposed={proposal.proposed}
              />
            </>
          ) : pending ? (
            <>
              {view.kind === "call" ? (
                <p className="text-muted-foreground">
                  Always allow and Block also decide the calls after this one.
                  You can change that on the token&apos;s page.
                </p>
              ) : view.kind === "fetch" ? (
                <p className="text-muted-foreground">
                  Always allow this site and Block this site also decide this
                  token&apos;s later requests to the site.{" "}
                  <Link href={`/tokens/${view.tokenId}`} className="underline">
                    The token&apos;s page
                  </Link>{" "}
                  lists every site it reached for, and its method settings.
                </p>
              ) : view.kind === "memory_share" ? (
                <p className="text-sm text-muted-foreground">
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
                secret={view.secretToEnter}
                every={
                  view.kind === "memory_share" && view.memory
                    ? { asked: view.memory.always }
                    : null
                }
              />
            </>
          ) : (
            <div
              className="flex flex-col gap-2"
              data-testid="permission-outcome"
            >
              {memory && showOutcome ? null : (
                <p>
                  {(access ? ACCESS_STATUS : STATUS)[view.status] ??
                    view.status}
                </p>
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
              {view.status === "expired" ? null : (
                <p className="text-muted-foreground">
                  Tell the assistant that asked that you answered, and it
                  carries on.
                </p>
              )}
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

/**
 * The memory a request is about, set apart so it is the first thing read:
 * the path above it, and the text it replaces, when it changes, above that.
 */
function MemoryText({
  memory,
  asking,
}: {
  memory: MemoryShown
  asking: string
}) {
  const text = "whitespace-pre-wrap break-words"

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <code className="break-all">{memory.path}</code>
        {memory.newPath ? (
          <>
            <span aria-hidden>→</span>
            <span className="sr-only">moves to</span>
            <code className="break-all">{memory.newPath}</code>
          </>
        ) : null}
        {memory.always && asking !== "memory_share" ? (
          <Badge variant="secondary">Read in every conversation</Badge>
        ) : null}
      </div>
      {memory.before !== null ? (
        <figure className="flex flex-col gap-1">
          <figcaption className="text-xs font-medium text-muted-foreground">
            Now
          </figcaption>
          <blockquote
            className={`${text} rounded-md border border-dashed p-3 text-sm text-muted-foreground`}
          >
            {memory.before}
          </blockquote>
        </figure>
      ) : null}
      <figure className="flex flex-col gap-1">
        {memory.before !== null ? (
          <figcaption className="text-xs font-medium text-muted-foreground">
            After the change
          </figcaption>
        ) : null}
        <blockquote
          className={`${text} rounded-md border-2 border-primary/30 bg-muted/60 p-4 text-base leading-relaxed`}
          data-testid="memory-text"
        >
          {memory.text}
        </blockquote>
      </figure>
    </div>
  )
}
