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
        description="An assistant runs commands on it, one per call, with the run_command tool. PCP signs in with a key of its own, never a password: once the server is added, its page shows the key to add to the login's authorized_keys. PCP pins the server's host key the first time it connects and refuses any other after that."
      />
      <SshServerForm initial={EMPTY_SSH_SERVER} />
    </>
  )
}
