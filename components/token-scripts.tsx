"use client"

import { useState, useTransition } from "react"

import { Button } from "@kaperkunde/ui/button"
import { List, ListRow, ListSection } from "@kaperkunde/ui/list"
import { removeScriptSiteAction } from "@/lib/actions/browser-scripts"
import type { ActionState } from "@/lib/server/action-state"

/**
 * The sites where you allowed or blocked this token's scripts in the
 * browser (its evaluate tool), each with a way to take it back: it asks
 * you again there.
 */
export function TokenScriptSites({
  tokenId,
  sites,
}: {
  tokenId: string
  sites: Array<{ site: string; access: "allowed" | "blocked" }>
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ActionState>({ status: "idle" })

  return (
    <ListSection
      title="Scripts in the browser"
      description="Sites where you allowed or blocked this assistant's scripts (its evaluate tool) when it asked. Anywhere else it asks you first, showing the whole script."
      footer={result.status === "error" ? result.error : undefined}
    >
      <List as="ul">
        {sites.map(({ site, access }) => (
          <ListRow
            as="li"
            key={site}
            title={<span className="break-words">{site}</span>}
            description={
              access === "allowed" ? "Scripts allowed" : "Scripts blocked"
            }
            trailing={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    setResult(await removeScriptSiteAction(tokenId, site))
                  })
                }
              >
                Take back
              </Button>
            }
          />
        ))}
      </List>
    </ListSection>
  )
}
