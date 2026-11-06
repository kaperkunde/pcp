import type { Metadata } from "next"
import Link from "next/link"

import { PageHeader } from "@kaperkunde/ui/page"
import { Badge, StatusDot } from "@kaperkunde/ui/badge"
import { IconTile } from "@/components/ui/icon-tile"
import { List, ListRow, ListSection } from "@kaperkunde/ui/list"
import { loadResourceLimits } from "@/lib/core/resources/state"
import { bytesLabel } from "@/lib/core/storage/browse"
import { storeUsage } from "@/lib/core/storage/quota"
import {
  ensureOwnStore,
  listStores,
  loadStorageRoot,
  unreachableReason,
  type StorageRootView,
} from "@/lib/core/storage/roots"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Files" }

type StoreRow = {
  view: StorageRootView
  /** What PCP's own store holds and may hold; null for a storage folder. */
  usage: { used: number; quota: number } | null
  /** Why PCP cannot reach it now, or null. */
  problem: string | null
}

/**
 * Every store, PCP's own first: where it is, whether PCP keeps it
 * encrypted, how full PCP's own is, and whether PCP reaches it. A row opens
 * its file browser (./[id]). Nothing here connects to an SSH server: a
 * storage folder's files are read when its browser opens.
 */
export default async function FilesPage() {
  const ctx = await requireContext()
  // PCP's own store is always there, for a vault from before it too.
  await ensureOwnStore(ctx)
  const [stores, limits, publicUrl] = await Promise.all([
    listStores(ctx),
    loadResourceLimits(),
    publicUrlFor(ctx),
  ])

  const rows: StoreRow[] = await Promise.all(
    stores.map(async (view): Promise<StoreRow> => {
      if (view.backend === "local") {
        const used = await storeUsage({
          server: { id: view.id },
          root: { backend: view.backend, mode: view.mode },
        })
        return {
          view,
          usage: { used, quota: limits.storeBytes },
          problem: null,
        }
      }

      const reason = unreachableReason(
        await loadStorageRoot(ctx, view.id),
        publicUrl,
      )
      return {
        view,
        usage: null,
        problem:
          reason?.split("\n")[0] ??
          (view.status === "error" || view.status === "refused"
            ? view.statusMessage || "The last check could not reach it."
            : null),
      }
    }),
  )

  return (
    <>
      <PageHeader
        title="Files"
        description="Every store assistants keep files in: PCP's own on this machine, and storage folders on your SSH servers."
      />
      <ListSection
        title="Stores"
        footer={
          <>
            Exports carry each store&apos;s keys and index, not its files: back
            up PCP&apos;s data folder, and your SSH servers&apos; folders, to
            keep them. A storage folder is added on its SSH server&apos;s page
            under{" "}
            <Link href="/servers" className="text-primary hover:underline">
              Servers
            </Link>
            .
          </>
        }
      >
        <List as="ul" data-testid="stores">
          {rows.map((row) => (
            <StoreListRow key={row.view.id} row={row} />
          ))}
        </List>
      </ListSection>
    </>
  )
}

function StoreListRow({ row }: { row: StoreRow }) {
  const { view, usage, problem } = row
  const where =
    view.backend === "local"
      ? "This machine"
      : view.host
        ? `${view.path} on ${view.host.name}`
        : view.path
  const mode = view.converting
    ? view.converting === "encrypted"
      ? "Being encrypted"
      : "Being made plain"
    : view.mode === "encrypted"
      ? "Encrypted"
      : "Plain"

  return (
    <ListRow
      as="li"
      href={`/files/${view.id}`}
      icon={<IconTile kind="storage" />}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {view.name}
          <Badge variant={view.converting ? "warning" : "secondary"}>
            {mode}
          </Badge>
          {view.readOnly ? <Badge variant="secondary">Read-only</Badge> : null}
        </span>
      }
      description={
        <span className="flex flex-col gap-0.5">
          <span className="break-words">
            {where}
            {usage
              ? ` · ${bytesLabel(usage.used)} of ${bytesLabel(usage.quota)}`
              : null}
          </span>
          {problem ? (
            <span className="flex items-center gap-1.5 text-warning">
              <StatusDot tone="warning" />
              {problem}
            </span>
          ) : null}
        </span>
      }
    />
  )
}
