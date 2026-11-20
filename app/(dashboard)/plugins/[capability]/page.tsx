import Link from "next/link"
import { notFound } from "next/navigation"
import type { Metadata } from "next"

import { PageColumn } from "@kaperkunde/ui/page"
import { PageHeader } from "@kaperkunde/ui/page"
import { AddCommonRepoButton } from "@/components/repo-forms"
import { Badge } from "@kaperkunde/ui/badge"
import { ButtonLink } from "@kaperkunde/ui/button"
import { Card } from "@kaperkunde/ui/card"
import {
  pluginEntry,
  type CatalogueEntry,
} from "@/lib/core/capabilities/catalogue"
import { capability, isCapabilityId } from "@/lib/core/capabilities/list"
import {
  capabilityOffers,
  itemOffers,
  type ItemOffer,
} from "@/lib/core/capabilities/setup"
import { requireContext } from "@/lib/server/session"

export const dynamic = "force-dynamic"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ capability: string }>
}): Promise<Metadata> {
  const { capability: id } = await params

  return {
    title: isCapabilityId(id)
      ? capability(id).title
      : (pluginEntry(id)?.title ?? "Not found"),
  }
}

/**
 * A capability's page (lib/core/capabilities/): what it is, and the common
 * items that provide it, each launched in one click from PCP's common items
 * (the repository's import page, where the owner reads it whole and picks
 * the SSH server and secrets). An assistant whose capability tool found no
 * provider hands the owner a link here. A common item of the catalogue
 * that is no capability (catalogue.ts: Claude Code sessions, a VPN exit…)
 * has its page here too, which a search's "can set up" line links to.
 */
export default async function CapabilityPage({
  params,
}: {
  params: Promise<{ capability: string }>
}) {
  const ctx = await requireContext()
  const { capability: id } = await params

  if (!isCapabilityId(id)) {
    const entry = pluginEntry(id)

    if (!entry) {
      notFound()
    }

    return <EntryPage entry={entry} />
  }

  const {
    capability: cap,
    repoId,
    offers,
    running,
    problem,
  } = await capabilityOffers(ctx, id)

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        title={cap.title}
        description={cap.summary}
      />

      <Card className="gap-3 leading-relaxed sm:p-6">
        <p>{cap.explain}</p>
        <p className="text-muted-foreground">
          Assistants call <code className="font-mono">{cap.tool}</code>, which
          uses a server or API endpoint you have that can do the work, at the
          levels you give each token: one you have not allowed yet asks you
          first, as any other tool does. Launch one below; once it runs, the
          assistant can try again.
        </p>
      </Card>

      {running.length > 0 ? (
        <Card className="gap-2">
          <p className="font-medium">You run these already</p>
          <ul className="flex flex-col gap-1">
            {running.map((service) => (
              <li key={service.id}>
                <Link
                  href={`/servers/${service.id}`}
                  className="underline underline-offset-2"
                >
                  {service.name}
                </Link>{" "}
                <span className="text-muted-foreground">({service.item})</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            If an assistant still finds none, check the token may use what it
            registered (its page in Tokens) and that it is running.
          </p>
        </Card>
      ) : null}

      {repoId === null ? <CommonItemsCard forId={cap.id} /> : null}

      {problem ? (
        <p className="text-sm text-destructive" role="alert">
          PCP&apos;s common items could not be read: {problem}
        </p>
      ) : null}

      {offers.map((offer) => (
        <OfferCard
          key={offer.item.name}
          offer={offer}
          linked={repoId !== null}
          problem={problem}
        />
      ))}
    </PageColumn>
  )
}

/**
 * A catalogue entry's page: what it does and takes, then its common item,
 * launched as a capability's are; or, with none yet, how to get there.
 */
async function EntryPage({ entry }: { entry: CatalogueEntry }) {
  const ctx = await requireContext()
  const items = entry.item ? [entry.item] : []
  const { repoId, offers, running, problem } = await itemOffers(ctx, items)

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/servers", label: "Servers" }}
        title={entry.title}
        description={entry.does}
      />

      <Card className="gap-3 leading-relaxed sm:p-6">
        <p>
          <span className="font-medium">What it takes: </span>
          {entry.takes}
        </p>
        {entry.ownerOnly ? (
          <p className="text-muted-foreground">
            Only you launch it, here: an assistant can point you to this page
            but never proposes it.
          </p>
        ) : (
          <p className="text-muted-foreground">
            You can also ask an assistant to set it up: it says what it needs
            and asks you in PCP first. Nothing runs until you agree.
          </p>
        )}
      </Card>

      {entry.item ? null : (
        <Card className="items-start gap-3 sm:p-6" data-testid="plugin-none">
          <p className="font-medium">Not available as a common item yet</p>
          <p className="text-muted-foreground">
            PCP&apos;s common items have no ready-made service for it yet. An
            assistant can write a service definition and propose it, which you
            read in full before it runs; or add one yourself.
          </p>
          <ButtonLink href="/servers/services/new" size="sm">
            Add a service
          </ButtonLink>
        </Card>
      )}

      {running.length > 0 ? (
        <Card className="gap-2">
          <p className="font-medium">You run it already</p>
          <ul className="flex flex-col gap-1">
            {running.map((service) => (
              <li key={service.id}>
                <Link
                  href={`/servers/${service.id}`}
                  className="underline underline-offset-2"
                >
                  {service.name}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {entry.item && repoId === null ? (
        <CommonItemsCard forId={entry.id} />
      ) : null}

      {problem ? (
        <p className="text-sm text-destructive" role="alert">
          PCP&apos;s common items could not be read: {problem}
        </p>
      ) : null}

      {offers.map((offer) => (
        <OfferCard
          key={offer.item.name}
          offer={offer}
          linked={repoId !== null}
          problem={problem}
        />
      ))}
    </PageColumn>
  )
}

/** PCP's common items, not linked yet: offered first, coming back here. */
function CommonItemsCard({ forId }: { forId: string }) {
  return (
    <Card className="items-start gap-3 sm:p-6">
      <p className="font-medium">Start from PCP&apos;s common items</p>
      <p className="text-muted-foreground">
        Ready-made services kept by pcp.gg in a public repository,
        kaperkunde/pcp-gg-common, to run on your own SSH server. It is added
        read-only and not trusted: you read every item before launching it, what
        you launch stays as you read it, and it never holds a secret.
      </p>
      <AddCommonRepoButton forCapability={forId} variant="default" />
    </Card>
  )
}

/** One common item: launch it, open the one you have, or say it is gone. */
function OfferCard({
  offer,
  linked,
  problem,
}: {
  offer: ItemOffer
  linked: boolean
  problem: string | null
}) {
  return (
    <Card className="gap-3 sm:p-6" data-testid="plugin-offer">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[17px] font-semibold">{offer.item.title}</h2>
        {offer.state === "have" ? (
          <Badge variant="secondary">In your vault</Badge>
        ) : null}
      </div>
      <p className="text-muted-foreground">{offer.item.about}</p>
      {offer.state === "launch" && offer.href ? (
        <div>
          <ButtonLink href={offer.href} size="sm">
            Launch {offer.item.title}
          </ButtonLink>
        </div>
      ) : offer.state === "have" && offer.href ? (
        <div>
          <ButtonLink href={offer.href} variant="secondary" size="sm">
            Open {offer.item.title}
          </ButtonLink>
        </div>
      ) : offer.state === "absent" && linked && !problem ? (
        <p className="text-muted-foreground">
          PCP&apos;s common items do not have it at the moment.
        </p>
      ) : null}
    </Card>
  )
}
