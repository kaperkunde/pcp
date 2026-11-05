import Link from "next/link"

import { ButtonLink } from "@/components/ui/button"
import { List, ListRow, ListSection } from "@/components/ui/list"
import type { StorageRootView } from "@/lib/core/storage/roots"

/**
 * A storage folder's own card on its page: where it is, whose files PCP
 * writes, and the way to its file browser.
 */
export function StorageCard({ view }: { view: StorageRootView }) {
  const login = view.host?.login ?? ""

  return (
    <ListSection title="Folder" data-testid="storage-folder">
      <List>
        <ListRow
          title={<code className="text-[13px]">{view.path}</code>}
          description={
            view.host ? (
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
            view.host ? (
              <ButtonLink
                href={`/servers/${view.id}/files`}
                variant="secondary"
                size="sm"
              >
                Browse files
              </ButtonLink>
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
