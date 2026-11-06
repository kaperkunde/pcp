import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { StorageBrowser } from "@/components/storage-browser"
import { StorageCard } from "@/components/storage-card"
import { ButtonLink } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { IconTile } from "@/components/ui/icon-tile"
import { isPcpError } from "@/lib/core/errors"
import {
  PAGE_UPLOAD_BYTES,
  previewOfName,
  TEXT_PREVIEW_BYTES,
  TEXT_SHOW_ALL_BYTES,
} from "@/lib/core/storage/browse"
import type { Listing } from "@/lib/core/storage/files"
import { loadStorageRoot, storageRootView } from "@/lib/core/storage/roots"
import { withStorageFolder } from "@/lib/core/upstream"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Files" }

/**
 * A store's file browser: one folder at a time (`?path=`), read when the
 * page loads (over SFTP for a storage folder, from the data folder for
 * PCP's own, decrypted in this request for an encrypted one), with
 * previews, download, upload, a new folder, rename or move and delete.
 * Every path is confined to the store as an assistant's is
 * (lib/core/storage/files.ts). Under the files, the store itself: where it
 * is and its conversion either way.
 */
export default async function StoreFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const query = await searchParams
  const path = typeof query.path === "string" ? query.path : ""

  const loaded = await loadStorageRoot(ctx, id).catch((error) => {
    if (isPcpError(error)) notFound()
    throw error
  })
  const view = storageRootView(loaded)
  const local = view.backend === "local"

  let listing: Listing | null = null
  let problem: string | null = null

  try {
    listing = await withStorageFolder(
      ctx,
      id,
      { publicUrl: await publicUrlFor(ctx) },
      (folder) => folder.list(path),
    )
  } catch (error) {
    if (!isPcpError(error) && !(error instanceof Error)) throw error
    problem = error.message.split("\n")[0]!
  }

  const crumbs = (listing?.path ?? "").split("/").filter(Boolean)
  const base = `/files/${id}`

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: "/files", label: "Files" }}
        icon={<IconTile kind="storage" size="lg" />}
        title={loaded.server.name}
        description={
          <>
            {local ? (
              "PCP's own store, in its data folder on this machine"
            ) : (
              <>
                <code>{loaded.root.path}</code> on{" "}
                {loaded.host?.name ?? "an SSH server no longer in PCP"}
              </>
            )}
            {view.mode === "encrypted" ? ", encrypted" : ", plain"}
            {loaded.server.readOnly
              ? ". Read-only in PCP: you can look and download here."
              : "."}
          </>
        }
        action={
          <ButtonLink href={`/servers/${id}`} variant="secondary" size="sm">
            Settings
          </ButtonLink>
        }
      />
      <nav
        aria-label="Folder"
        className="flex flex-wrap items-center gap-1 px-1 text-sm"
      >
        <Link href={base} className="text-primary hover:underline">
          Top
        </Link>
        {crumbs.map((name, index) => (
          <span key={index} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            <Link
              href={`${base}?${new URLSearchParams({ path: crumbs.slice(0, index + 1).join("/") })}`}
              className="text-primary hover:underline"
              aria-current={index === crumbs.length - 1 ? "page" : undefined}
            >
              {name}
            </Link>
          </span>
        ))}
      </nav>
      {listing ? (
        <StorageBrowser
          storeId={id}
          path={listing.path}
          entries={listing.entries.map((entry) => ({
            ...entry,
            preview: entry.type === "file" ? previewOfName(entry.name) : null,
          }))}
          truncated={listing.truncated === true}
          readOnly={loaded.server.readOnly}
          limits={{
            uploadBytes: PAGE_UPLOAD_BYTES,
            textPreviewBytes: TEXT_PREVIEW_BYTES,
            textShowAllBytes: TEXT_SHOW_ALL_BYTES,
          }}
        />
      ) : (
        <Card className="p-5 text-sm text-destructive" role="alert">
          {problem}
        </Card>
      )}
      <StorageCard view={view} browse={false} />
    </PageColumn>
  )
}
