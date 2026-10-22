import {
  BookOpen,
  ChevronLeft,
  FolderGit2,
  Globe,
  KeyRound,
  ListChecks,
  Server,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AccessReview } from "@/components/access-review"
import { AllClearAfter, AnsweredBefore } from "@/components/answer-queue"
import { RelativeDate } from "@/components/local-date"
import { MemoryReview } from "@/components/memory-review"
import { PageHeader } from "@/components/page-header"
import { PageColumn } from "@/components/page-column"
import { PermissionDecision } from "@/components/permission-decision"
import { PermissionLines } from "@/components/permission-lines"
import { PermissionOutcome } from "@/components/permission-outcome"
import { RepoReview } from "@/components/repo-review"
import { buttonVariants } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { IconTile } from "@/components/ui/icon-tile"
import { ShownInFull } from "@/components/shown-in-full"
import { SkillReview } from "@/components/skill-review"
import { WrapperReview } from "@/components/wrapper-review"
import { tabFor } from "@/lib/core/browser/owner"
import { getAccessProposal, getPermissionView } from "@/lib/core/permissions"
import type { PermissionView } from "@/lib/core/permissions"
import type { ServerKind } from "@/lib/core/servers"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"
import { cn } from "@/lib/utils"

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
  withdrawn: "Withdrawn by the assistant, so nothing ran.",
  closed: "The tab was closed before you were done, so nothing more happens.",
  expired: "This expired without an answer, so nothing ran.",
}

/** The same, for tool levels an assistant proposed. */
const ACCESS_STATUS: Record<string, string> = {
  executed: "You saved these levels.",
  running: "Saving now.",
  failed: "You saved, but the levels were not written.",
  declined: "You said no, so no tool's level changed.",
  withdrawn: "Withdrawn by the assistant, so no tool's level changed.",
  expired: "This expired without an answer, so no tool's level changed.",
}

const STATUS_TONE: Record<string, "ok" | "warning" | "error" | "off"> = {
  executed: "ok",
  running: "warning",
  failed: "error",
  declined: "off",
  withdrawn: "off",
  closed: "off",
  expired: "off",
}

/** Nothing for the assistant to hear: it ended without your answer. */
const UNANSWERED = new Set(["expired", "withdrawn", "closed"])

/**
 * Where an assistant sends you to answer something it asked PCP for
 * (lib/core/permissions.ts): when its app cannot show the question itself,
 * or you would rather decide here. A hand-over whose tab is open is
 * answered on the tab, in the Browser page's tabs view, which this sends
 * you on to; once answered, or with its tab gone, it is shown here.
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
      <PageColumn width="narrow">
        <PageHeader title="Permission" />
        <p className="text-muted-foreground" role="alert">
          There is no request waiting for you at this link.
        </p>
      </PageColumn>
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

  // A hand-over is answered on its tab while the tab is open.
  if (
    view.kind === "browser_handover" &&
    pending &&
    view.browserTabId &&
    (await tabFor(ctx, view.browserTabId))
  ) {
    redirect(`/browser?tab=${encodeURIComponent(view.browserTabId)}`)
  }

  const proposal = access && pending ? await getAccessProposal(ctx, id) : null
  // A long list of levels, a wrapper's programs or a skill want room.
  const roomy = Boolean(
    (access && pending) ||
    view.wrapper !== null ||
    view.skill !== null ||
    view.repo !== null,
  )

  return (
    <PageColumn width={roomy ? "wide" : "narrow"}>
      <Link
        href="/home"
        className="-mb-4 -ml-1 inline-flex items-center gap-0.5 self-start text-sm text-primary hover:text-accent-foreground"
      >
        <ChevronLeft aria-hidden className="size-4" />
        Home
      </Link>
      <AnsweredBefore
        className={cn("mx-auto w-full", !roomy && "max-w-[720px]")}
      />
      <Card
        className={cn(
          "mx-auto w-full gap-6 rounded-[18px] p-5 sm:p-8",
          pending && "ring-1 ring-warning/25",
          !roomy && "max-w-[720px]",
        )}
      >
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-foreground"
          >
            {view.tokenName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0">
            <Link
              href={`/tokens/${view.tokenId}`}
              className="font-semibold text-foreground break-words hover:text-primary"
            >
              {view.tokenName}
            </Link>{" "}
            {pending ? "is asking" : "asked"} ·{" "}
            <RelativeDate value={view.createdAt} />
          </span>
        </div>

        <div className="flex items-center gap-4">
          <RequestTile view={view} />
          <h1 className="min-w-0 text-[22px] leading-tight font-bold tracking-[-0.015em] break-words sm:text-[26px]">
            {view.title}
          </h1>
        </div>

        {view.memory ? (
          <MemoryReview memory={view.memory} asking={view.kind} />
        ) : (
          <PermissionLines lines={view.lines} />
        )}
        {view.skill ? <SkillReview skill={view.skill} /> : null}
        {view.full ? <ShownInFull parts={view.full} /> : null}
        {view.warning && view.memory ? (
          // The text is what to check; the warning says what to look for,
          // under it, without drawing the eye away from it.
          <p
            className="border-l-2 border-separator pl-3 text-sm text-muted-foreground"
            role="note"
          >
            {view.warning}
          </p>
        ) : view.warning ? (
          <p
            className="flex items-start gap-3 rounded-xl bg-warning/10 p-4 ring-1 ring-warning/30"
            role="note"
          >
            <TriangleAlert
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-warning"
            />
            <span className="min-w-0 break-words">{view.warning}</span>
          </p>
        ) : null}
        {view.wrapper ? <WrapperReview shown={view.wrapper} /> : null}
        {view.repo ? <RepoReview shown={view.repo} /> : null}
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
            <PendingNote view={view} />
            <PermissionDecision
              id={view.id}
              decisions={view.decisions}
              secret={view.secretToEnter}
              allowForFixed={
                view.kind === "secret_use" || view.kind === "secret_request"
              }
              every={
                view.kind === "memory_share" && view.memory
                  ? { asked: view.memory.always }
                  : null
              }
            />
          </>
        ) : (
          <PermissionOutcome
            status={
              memory && showOutcome
                ? null
                : ((access ? ACCESS_STATUS : STATUS)[view.status] ??
                  view.status)
            }
            tone={STATUS_TONE[view.status] ?? "off"}
            outcome={showOutcome ? view.outcome : null}
            outcomeIsError={view.outcomeIsError}
            tell={!UNANSWERED.has(view.status)}
          />
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
      </Card>
      <AllClearAfter
        className={cn("mx-auto w-full", !roomy && "max-w-[720px]")}
      />
    </PageColumn>
  )
}

/** The tile before the title: the server's kind, or what the request is about. */
function RequestTile({ view }: { view: PermissionView }) {
  const tile = "max-sm:size-11 max-sm:rounded-xl"

  if (view.serverKind) {
    return (
      <IconTile
        size="lg"
        kind={view.serverKind as ServerKind}
        className={tile}
      />
    )
  }

  switch (view.kind) {
    case "memory_share":
    case "memory_change":
      return <IconTile size="lg" icon={BookOpen} className={tile} />
    case "skill_change":
      return <IconTile size="lg" icon={ListChecks} className={tile} />
    case "repo_change":
      return <IconTile size="lg" icon={FolderGit2} className={tile} />
    case "access":
      return <IconTile size="lg" icon={SlidersHorizontal} className={tile} />
    case "fetch":
    case "browse":
    case "browser_handover":
      return <IconTile size="lg" icon={Globe} className={tile} />
    case "secret_use":
    case "secret_request":
      return <IconTile size="lg" icon={KeyRound} className={tile} />
    default:
      return <IconTile size="lg" icon={Server} className={tile} />
  }
}

/** What the answers do, in the owner's words, before the buttons. */
function PendingNote({ view }: { view: PermissionView }) {
  const note = "text-[13px] leading-relaxed text-muted-foreground"

  switch (view.kind) {
    case "call":
      return (
        <p className={note}>
          Always allow and Block also decide the calls after this one; Allow for
          lets them run without asking you until that time is up. You can change
          that on the token&apos;s page.
          {view.serverKind === "browser" &&
          (view.tool === "navigate" || view.tool === "tabs")
            ? " Allowing it also lets the tab open the site it names, unless you blocked that site for this token, and keep to its pages while the tab is open; other sites are asked about on their own."
            : null}
        </p>
      )
    case "fetch":
      return (
        <p className={note}>
          Always allow this site and Block this site also decide this
          token&apos;s later requests to the site, and Allow this site for lets
          them through without asking until that time is up.{" "}
          <Link href={`/tokens/${view.tokenId}`} className="underline">
            The token&apos;s page
          </Link>{" "}
          lists every site it reached for, and its method settings.
        </p>
      )
    case "browse":
      return (
        <p className={note}>
          Allow once lets this tab open the site&apos;s pages while it is open.
          Allow this site for, Always allow this site and Block this site decide
          for the token, in the browser and in web fetch, as on{" "}
          <Link href={`/tokens/${view.tokenId}`} className="underline">
            the token&apos;s page
          </Link>
          .
        </p>
      )
    case "browser_handover":
      // Its tab is open no longer: an open one is answered on the tab.
      return (
        <p className={note}>
          The tab this is about is closed, or the browser has closed since, so
          there is nothing left to do in it: say Not now. The{" "}
          <Link href="/browser" className="underline">
            Browser
          </Link>{" "}
          page lists the tabs that are open.
        </p>
      )
    case "secret_use":
      return (
        <p className={note}>
          Allow once types it this time. Allow for 1 hour and Always allow let
          this token have it typed at this site without asking you, for an hour
          or until you end it; Always allow also adds the site to the
          secret&apos;s. You can end either on the token&apos;s page or under{" "}
          <Link href="/secrets" className="underline">
            Secrets
          </Link>
          . While a field holds it, the assistant reads the field as [secret:{" "}
          name] and gets no screenshots of the tab.
        </p>
      )
    case "secret_request":
      return (
        <p className={note}>
          Saving stores the secret under{" "}
          <Link href="/secrets" className="underline">
            Secrets
          </Link>{" "}
          with these sites. Allow one use lets this token have it typed once;
          the others let it, at these sites, for an hour or until you end it.
          Any other use asks you first.
        </p>
      )
    case "skill_change":
      return (
        <p className={note}>
          Allowing it writes the skill exactly as shown above, and only if
          nobody changed it since the assistant asked. Every assistant that sees
          it follows it from then on. You can read, edit and delete every skill
          under{" "}
          <Link href="/skills" className="underline">
            Skills
          </Link>
          .
        </p>
      )
    case "repo_change":
      return (
        <p className={note}>
          Applying it writes the item exactly as shown above, and only if
          neither your vault&apos;s item nor the repository&apos;s change moved
          since the assistant asked. Linked repositories are under{" "}
          <Link href="/settings/repositories" className="underline">
            Settings › Repositories
          </Link>
          .
        </p>
      )
    case "memory_share":
      return (
        <p className={note}>
          Kept for this assistant only, it is saved where only the assistant
          that asked reads it. You can read, edit and delete every memory under{" "}
          <Link href="/memories" className="underline">
            Memories
          </Link>
          .
        </p>
      )
    default:
      return null
  }
}
