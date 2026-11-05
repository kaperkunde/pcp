import Link from "next/link"
import { notFound } from "next/navigation"
import type { Metadata } from "next"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { AddCommonRepoButton } from "@/components/repo-forms"
import { Badge } from "@/components/ui/badge"
import { ButtonLink } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { capability, isCapabilityId } from "@/lib/core/capabilities/list"
import { capabilityOffers } from "@/lib/core/capabilities/setup"
import { requireContext } from "@/lib/server/session"

export const dynamic = "force-dynamic"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ capability: string }>
}): Promise<Metadata> {
  const { capability: id } = await params

  return { title: isCapabilityId(id) ? capability(id).title : "Not found" }
}

/**
 * A capability's page (lib/core/capabilities/): what it is, and the common
 * items that provide it, each launched in one click from PCP's common items
 * (the repository's import page, where the owner reads it whole and picks
 * the SSH server and secrets). An assistant whose capability tool found no
 * provider hands the owner a link here.
 */
export default async function CapabilityPage({
  params,
}: {
  params: Promise<{ capability: string }>
}) {
  const ctx = await requireContext()
  const { capability: id } = await params

  if (!isCapabilityId(id)) {
    notFound()
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

      {repoId === null ? (
        <Card className="items-start gap-3 sm:p-6">
          <p className="font-medium">Start from PCP&apos;s common items</p>
          <p className="text-muted-foreground">
            Ready-made services kept by pcp.gg in a public repository,
            kaperkunde/pcp-gg-common, to run on your own SSH server. It is added
            read-only and not trusted: you read every item before launching it,
            what you launch stays as you read it, and it never holds a secret.
          </p>
          <AddCommonRepoButton forCapability={cap.id} variant="default" />
        </Card>
      ) : null}

      {problem ? (
        <p className="text-sm text-destructive" role="alert">
          PCP&apos;s common items could not be read: {problem}
        </p>
      ) : null}

      {offers.map((offer) => (
        <Card
          key={offer.item.name}
          className="gap-3 sm:p-6"
          data-testid="plugin-offer"
        >
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
          ) : offer.state === "absent" && repoId !== null && !problem ? (
            <p className="text-muted-foreground">
              PCP&apos;s common items do not have it at the moment.
            </p>
          ) : null}
        </Card>
      ))}
    </PageColumn>
  )
}
