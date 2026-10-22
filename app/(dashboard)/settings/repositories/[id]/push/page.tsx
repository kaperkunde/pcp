import { redirect } from "next/navigation"

/**
 * Pushing is chosen on the repository's page (Not pushed and Changed) and
 * each item is reviewed on its own before it goes; this older address
 * opens that list.
 */
export default async function PushPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/settings/repositories/${encodeURIComponent(id)}?status=not_pushed`)
}
