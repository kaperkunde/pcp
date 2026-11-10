import type { VaultContext } from "../context"

import type { ItemDocument } from "./documents"
import { reviewItem, type ItemReview } from "./review"

/** An item's review, with what the vault says of it. */
export async function reviewInVault(
  _ctx: VaultContext,
  current: ItemDocument | null,
  incoming: ItemDocument,
  _currentId: string | null,
): Promise<ItemReview> {
  return reviewItem(current, incoming)
}
