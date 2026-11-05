import { Badge } from "@/components/ui/badge"
import { ButtonLink } from "@/components/ui/button"
import { IconTile } from "@/components/ui/icon-tile"
import { List, ListRow, ListSection } from "@/components/ui/list"
import type { StorageRootView } from "@/lib/core/storage/roots"

/**
 * The storage folders on this SSH server: each one's page, and adding one.
 * Assistants read and write files only inside them, over SFTP.
 */
export function StorageFoldersCard({
  serverId,
  folders,
}: {
  serverId: string
  folders: StorageRootView[]
}) {
  return (
    <ListSection
      title="Storage folders"
      description={
        <>
          Folders on this server that assistants work with files in: list, find,
          get, save, move and delete, over SFTP on the same SSH connection,
          never outside the folder. The server needs SFTP for the login (an{" "}
          <code>sftp</code> Subsystem in its sshd_config, and PCP&apos;s key
          without a forced command).
        </>
      }
      data-testid="ssh-storage"
    >
      <List as="ul">
        {folders.map((folder) => (
          <ListRow
            key={folder.id}
            as="li"
            href={`/servers/${folder.id}`}
            icon={<IconTile kind="storage" size="sm" />}
            title={
              <span className="flex flex-wrap items-center gap-2">
                {folder.name}
                {folder.readOnly ? (
                  <Badge variant="secondary">Read-only</Badge>
                ) : null}
              </span>
            }
            description={<code className="text-xs">{folder.path}</code>}
          />
        ))}
        <li className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          <span className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground">
            {folders.length === 0
              ? "No folders yet: add one to let assistants save and fetch files here."
              : "Another folder on this server."}
          </span>
          <ButtonLink
            href={`/servers/storage/new?${new URLSearchParams({ host: serverId })}`}
            variant="secondary"
            size="sm"
          >
            Add a folder
          </ButtonLink>
        </li>
      </List>
    </ListSection>
  )
}
