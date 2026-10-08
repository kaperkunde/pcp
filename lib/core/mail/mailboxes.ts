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

/**
 * The mailbox drafts go in: the one with the drafts role, or else one
 * called Drafts, as a server without roles (or SPECIAL-USE) names it.
 */
export function draftsMailbox(boxes: MailboxSummary[]): MailboxSummary | null {
  return (
    mailboxByRole(boxes, "drafts") ??
    boxes.find(
      (box) =>
        box.name.toLowerCase() === "drafts" ||
        box.path?.toLowerCase() === "drafts",
    ) ??
    null
  )
}

/**
 * Refuses a mailbox delete_mailbox must leave alone: one with a role (the
 * inbox, Trash, Sent and the like, which mail apps rely on), one that holds
 * mail (removing it would delete that mail for good), or one with mailboxes
 * inside it.
 */
export function checkDeletable(
  boxes: MailboxSummary[],
  box: MailboxSummary,
): void {
  if (box.role) {
    throw new MailRequestError(
      `${box.name} is the account's ${box.role} mailbox; PCP does not delete it.`,
    )
  }

  if (box.totalEmails === null || box.totalEmails > 0) {
    throw new MailRequestError(
      box.totalEmails === null
        ? `The mail server does not say whether ${box.name} is empty, so PCP leaves it.`
        : `${box.name} holds ${box.totalEmails} email${box.totalEmails === 1 ? "" : "s"}; move or delete them first. PCP never deletes mail for good.`,
    )
  }

  if (boxes.some((other) => other.parentId === box.id)) {
    throw new MailRequestError(
      `${box.name} has mailboxes inside it; delete or move them first.`,
    )
  }
}

/** Refuses a new parent that is the mailbox itself or one inside it. */
export function checkNewParent(
  boxes: MailboxSummary[],
  box: MailboxSummary,
  parent: MailboxSummary | null,
): void {
  const byId = new Map(boxes.map((candidate) => [candidate.id, candidate]))
  let current = parent

  for (let depth = 0; current && depth <= boxes.length; depth++) {
    if (current.id === box.id) {
      throw new MailRequestError(
        `${box.name} cannot go inside itself or a mailbox inside it.`,
      )
    }

    current = current.parentId ? (byId.get(current.parentId) ?? null) : null
  }
}
