import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { StorageBrowser } from "@/components/storage-browser"
import { Card } from "@/components/ui/card"
import { IconTile } from "@/components/ui/icon-tile"
import { isPcpError } from "@/lib/core/errors"
import type { Listing } from "@/lib/core/storage/files"
import { loadStorageRoot } from "@/lib/core/storage/roots"
import { withStorageFolder } from "@/lib/core/upstream"
import { publicUrlFor } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Files" }

/**
 * A storage folder's file browser: one folder at a time (`?path=`), read
 * over SFTP when the page loads, with download, upload, a new folder,
 * rename or move and delete. Every path is confined to the folder as an
 * assistant's is (lib/core/storage/files.ts).
 */
export default async function StorageFilesPage({
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

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: `/servers/${id}`, label: loaded.server.name }}
        icon={<IconTile kind="storage" size="lg" />}
        title="Files"
        description={
          <>
            <code>{loaded.root.path}</code> on{" "}
            {loaded.host?.name ?? "an SSH server no longer in PCP"}
            {loaded.server.readOnly
              ? ". Read-only in PCP: you can look and download here."
              : "."}
          </>
        }
      />
      <nav
        aria-label="Folder"
        className="flex flex-wrap items-center gap-1 px-1 text-sm"
      >
        <Link
          href={`/servers/${id}/files`}
          className="text-primary hover:underline"
        >
          Top
        </Link>
        {crumbs.map((name, index) => (
          <span key={index} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            <Link
              href={`/servers/${id}/files?${new URLSearchParams({ path: crumbs.slice(0, index + 1).join("/") })}`}
              className="text-primary hover:underline"
            >
              {name}
            </Link>
          </span>
        ))}
      </nav>
      {listing ? (
        <StorageBrowser
          serverId={id}
          path={listing.path}
          entries={listing.entries}
          truncated={listing.truncated === true}
          readOnly={loaded.server.readOnly}
        />
      ) : (
        <Card className="p-5 text-sm text-destructive" role="alert">
          {problem}
        </Card>
      )}
    </PageColumn>
  )
}
