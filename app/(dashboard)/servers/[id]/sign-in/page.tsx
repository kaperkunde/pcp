import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { PageColumn, PageHeader } from "@kaperkunde/ui/page"
import { ServiceSignIn } from "@/components/service-sign-in"
import { isPcpError } from "@/lib/core/errors"
import { requireSigninTarget } from "@/lib/core/upstream"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Sign in" }

/**
 * Signing in to the account a service needs (its definition's `signin`):
 * the provider's page to open, and the code to paste back, which PCP hands
 * to the service and keeps nowhere. An assistant's connect_account, or a
 * call that failed signed out, links here.
 */
export default async function ServiceSignInPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params
  let target: Awaited<ReturnType<typeof requireSigninTarget>>

  try {
    target = await requireSigninTarget(ctx, id)
  } catch (error) {
    if (isPcpError(error) && error.code === "not_found") {
      notFound()
    }

    throw error
  }

  const name = target.server.name

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: `/servers/${target.server.id}`, label: name }}
        title={`Sign in to ${name}`}
        description={`${name} works under an account of yours, through the service ${target.service.server.name}. Sign in at the provider's page and paste the code it shows you here: PCP hands it to the service and keeps it nowhere.`}
      />
      <ServiceSignIn id={target.server.id} name={name} />
    </PageColumn>
  )
}
