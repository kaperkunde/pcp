import type { Metadata } from "next"

import { PageHeader } from "@/components/page-header"
import { EMPTY_SSH_SERVER, SshServerForm } from "@/components/ssh-server-form"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add an SSH server" }

export default async function NewSshServerPage() {
  await requireContext()

  return (
    <>
      <PageHeader
        title="Add an SSH server"
        description="An assistant runs commands on it, one per call, with the run_command tool. PCP signs in with a certificate only: once the server is added, PCP shows you a key of its own to sign with your user CA. It connects only to a server that presents a host certificate from the CA you give here."
      />
      <SshServerForm initial={EMPTY_SSH_SERVER} />
    </>
  )
}
