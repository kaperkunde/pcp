import {
  MailRequestError,
  type MailboxRole,
  type MailboxSummary,
} from "./types"

/**
 * A mailbox as an assistant names it: by id (a JMAP id, an IMAP path), by
 * role ("inbox", "trash") or by name, whichever matches first.
 */
export function findMailbox(
  boxes: MailboxSummary[],
  ref: string,
): MailboxSummary {
  const wanted = ref.trim().toLowerCase()
  const found =
    boxes.find((box) => box.id === ref) ??
    boxes.find((box) => box.role === wanted) ??
    boxes.find((box) => box.name.toLowerCase() === wanted) ??
    boxes.find((box) => box.path?.toLowerCase() === wanted)

  if (!found) {
    throw new MailRequestError(
      `No mailbox called ${ref.slice(0, 100)}; list_mailboxes lists them.`,
    )
  }

  return found
}

export function mailboxByRole(
  boxes: MailboxSummary[],
  role: MailboxRole,
): MailboxSummary | null {
  return boxes.find((box) => box.role === role) ?? null
}
