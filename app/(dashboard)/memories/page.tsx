import type { Metadata } from "next"

import { MemoriesManager } from "@/components/memories-manager"
import { MemoryAddDialog } from "@/components/memory-add-dialog"
import { PageHeader } from "@/components/page-header"
import { listApiTokens } from "@/lib/core/api-tokens"
import { listMemories } from "@/lib/core/memories"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Memories" }

export default async function MemoriesPage() {
  const ctx = await requireContext()
  const [memories, tokens] = await Promise.all([
    listMemories(ctx),
    listApiTokens(ctx),
  ])
  const now = Date.now()
  // The tokens that can read a memory given to them: alive, and keeping memories.
  const readers = tokens
    .filter(
      (token) =>
        token.keepMemories &&
        token.revokedAt === null &&
        (token.expiresAt === null || token.expiresAt.getTime() >= now),
    )
    .map((token) => ({ id: token.id, name: token.name }))

  return (
    <>
      <PageHeader
        title="Memories"
        description="Notes assistants keep for you between conversations. A memory is either kept by the assistant that wrote it, or shared with every assistant whose token can keep memories. An assistant only shares one, or changes a shared one, after you agree. One you mark to be read in every conversation comes with PCP's instructions, so an assistant has it from the start."
        action={<MemoryAddDialog />}
      />
      <MemoriesManager memories={memories} readers={readers} />
    </>
  )
}
