import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { EMPTY_WRAPPER, WrapperForm } from "@/components/wrapper-form"
import { listSecrets } from "@/lib/core/secrets"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add a wrapper" }

export default async function NewWrapperPage() {
  const ctx = await requireContext()
  const secretNames = (await listSecrets(ctx))
    .filter((secret) => secret.kind === "text")
    .map((secret) => secret.name)

  return (
    <>
      <PageHeader
        title="Add a wrapper"
        description="A wrapper's tools are short programs over your other tools: fewer arguments, several calls made one, an answer cut to what matters, a secret put where an API wants it. Each runs in PCP and calls only the tools you list for it, at the calling token's own levels."
      />
      <WrapperForm initial={EMPTY_WRAPPER} secretNames={secretNames} />
    </>
  )
}
