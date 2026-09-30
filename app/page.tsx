import { redirect } from "next/navigation"

import { isSetUp } from "@/lib/core/vault"
import { currentSession } from "@/lib/server/session"

export const dynamic = "force-dynamic"

/**
 * The front door. Before setup there is nothing to sign in to, so the
 * first visitor is taken to /setup (the Ghost model: a self-hosted install
 * belongs to whoever reaches it first, which is its owner).
 */
export default async function Home() {
  if (!(await isSetUp())) {
    redirect("/setup")
  }

  redirect((await currentSession()) ? "/servers" : "/login")
}
