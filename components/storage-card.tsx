import Link from "next/link"

import { StoreConversionForm } from "@/components/store-conversion-form"
import { ButtonLink } from "@/components/ui/button"
import { List, ListRow, ListSection } from "@/components/ui/list"
import type { StorageRootView } from "@/lib/core/storage/roots"

/**
 * A store's own card on its page: where its files are, whether PCP keeps
 * them encrypted, whose files PCP writes, the way to its file browser
 * (left out on the browser itself, `browse` false), and the conversion
 * either way.
 */
export function StorageCard({
  view,
  browse = true,
}: {
  view: StorageRootView
  browse?: boolean
}) {
  const login = view.host?.login ?? ""
  const local = view.backend === "local"
  const reachable = local || view.host !== null
  const to =
    view.converting ?? (view.mode === "encrypted" ? "plain" : "encrypted")

  return (
    <ListSection
      title={local ? "Store" : "Folder"}
      data-testid="storage-folder"
    >
      <List>
        <ListRow
          title={
            local ? (
              "In PCP's data folder"
            ) : (
              <code className="text-[13px]">{view.path}</code>
            )
          }
          description={
            local ? (
              "On the machine PCP runs on. Exports carry its index and keys, not its files: back up PCP's data folder to keep them."
            ) : view.host ? (
              <>
                On{" "}
                <Link
                  href={`/servers/${view.host.id}`}
                  className="underline underline-offset-2"
                >
                  {view.host.name}
                </Link>
                , over SFTP as {login}. New files get umask {view.umask}.
              </>
            ) : (
              "Its SSH server is no longer in PCP, so PCP cannot reach it. Remove the folder, and add it again on an SSH server's page."
            )
          }
          trailing={
            browse && reachable && !view.converting ? (
              <ButtonLink
                href={`/files/${view.id}`}
                variant="secondary"
                size="sm"
              >
                Browse files
              </ButtonLink>
            ) : null
          }
        />
        <ListRow
          title={
            view.converting
              ? view.converting === "encrypted"
                ? "Being encrypted"
                : "Being made plain"
              : view.mode === "encrypted"
                ? "Encrypted"
                : "Plain"
          }
          description={
            view.converting
              ? "Assistants' calls to it wait until this is done. Continue until it says so."
              : view.mode === "encrypted"
                ? local
                  ? "PCP keeps the files encrypted, names and folders too, and decrypts them only for a request."
                  : "The SSH server holds only encrypted objects: names, folders and content are PCP's to read, and other apps (Samba, Finder) see none of it. Making it plain writes the files back as they are."
                : "The files are there as they are, for other apps (Samba, Finder, the Files app) too. Encrypting replaces each with an encrypted object only PCP can read, one batch at a time."
          }
          trailing={
            reachable && !view.readOnly ? (
              <StoreConversionForm
                id={view.id}
                to={to}
                underway={view.converting !== null}
              />
            ) : null
          }
        />
        {view.loginDiffers ? (
          <ListRow
            className="text-warning"
            title="Files are saved as the SSH login"
            description={`You want these to be ${view.writeAs}'s, but PCP signs in as ${login}, so what it saves is ${login}'s. Sign PCP in as ${view.writeAs} on the SSH server, or give ${login} the folder's group (with the setgid bit on the folder, new files take its group).`}
          />
        ) : null}
      </List>
    </ListSection>
  )
}
