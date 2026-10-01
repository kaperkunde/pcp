import type { Metadata } from "next"

import { MemoriesManager } from "@/components/memories-manager"
import { PageHeader } from "@/components/page-header"
import { listMemories } from "@/lib/core/memories"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Memories" }

export default async function MemoriesPage() {
  const ctx = await requireContext()
  const memories = await listMemories(ctx)

  return (
    <>
      <PageHeader
        title="Memories"
        description="Notes assistants keep for you between conversations. A memory is either kept by the assistant that wrote it, or shared with every assistant whose token can keep memories. An assistant only shares one, or changes a shared one, after you agree."
      />
      <MemoriesManager memories={memories} />
    </>
  )
}
