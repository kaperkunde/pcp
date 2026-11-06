import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { PageColumn } from "@kaperkunde/ui/page"
import { PageHeader } from "@kaperkunde/ui/page"
import {
  EMPTY_STORAGE_FOLDER,
  StorageFolderForm,
} from "@/components/storage-folder-form"
import { IconTile } from "@/components/ui/icon-tile"
import { db } from "@/lib/core/db"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Add a storage folder" }

/**
 * Adding a storage folder on one SSH server (`?host=<id>`, from the Storage
 * folders list on its page).
 */
export default async function NewStorageFolderPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const query = await searchParams
  const hostId = typeof query.host === "string" ? query.host : ""
  const host = hostId
    ? await db().mcpServer.findFirst({
        where: { id: hostId, vaultId: ctx.vaultId, kind: "ssh" },
      })
    : null

  if (!host) {
    notFound()
  }

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: `/servers/${host.id}`, label: host.name }}
        icon={<IconTile kind="storage" size="lg" />}
        title="Add a storage folder"
        description={`A folder on ${host.name} that assistants list, find, get and save files in, over SFTP on PCP's SSH connection, and nowhere outside it. A file goes in and out as a kept result, so a mail attachment or a scan lands here in one call.`}
      />
      <StorageFolderForm
        initial={EMPTY_STORAGE_FOLDER}
        hostId={host.id}
        login={host.authUsername ?? ""}
      />
    </PageColumn>
  )
}
