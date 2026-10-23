import type { Prisma } from "@/lib/generated/prisma/client"

import { db } from "./db"

/**
 * How a request still waiting for the owner ends without their answer:
 * the assistant that asked took it back (`withdrawn`), or what it was about
 * went away (`closed`: the tab a hand-over named was closed, or the
 * browser). Neither runs anything or writes anything else.
 */
export type ClosedStatus = "withdrawn" | "closed"

/**
 * Closes the requests `where` picks that are still pending and unexpired,
 * in one update, so an answer racing it either wins first or finds the row
 * closed (the owner's answers claim a row the same way). Needs no key: the
 * status says what happened, and nothing is encrypted. Returns how many it
 * closed.
 */
export async function closePendingRequests(
  where: Prisma.PermissionRequestWhereInput,
  status: ClosedStatus,
  now = new Date(),
): Promise<number> {
  const { count } = await db().permissionRequest.updateMany({
    where: { ...where, status: "pending", expiresAt: { gt: now } },
    data: { status, decidedAt: now },
  })

  return count
}
