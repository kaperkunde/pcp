import { db } from "@/lib/core/db"

export const dynamic = "force-dynamic"

/** For the container healthcheck: can the app reach its database? */
export async function GET() {
  try {
    await db().vault.count()
    return Response.json({ status: "ok" })
  } catch (error) {
    console.error("[health] database check failed", error)
    return Response.json({ status: "error" }, { status: 503 })
  }
}
