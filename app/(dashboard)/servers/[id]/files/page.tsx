import { redirect } from "next/navigation"

/**
 * A store's file browser moved to Files (app/(dashboard)/files/[id]): a
 * link or bookmark to the old address lands there, in the same folder.
 */
export default async function StorageFilesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const query = await searchParams
  const path = typeof query.path === "string" ? query.path : ""

  redirect(
    `/files/${encodeURIComponent(id)}${path ? `?${new URLSearchParams({ path })}` : ""}`,
  )
}
