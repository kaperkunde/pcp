"use client"

import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ServerKind } from "@/lib/core/servers"

/** Which servers a token reaches: all of them, or the ones checked. */
export function ServerScopeFields({
  servers,
  allowAll = true,
  selected = [],
}: {
  servers: Array<{ id: string; name: string; kind?: ServerKind }>
  allowAll?: boolean
  selected?: string[]
}) {
  const [access, setAccess] = useState<"all" | "selected">(
    allowAll ? "all" : "selected",
  )

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">Access</legend>
      <Label className="font-normal">
        <input
          type="radio"
          name="access"
          value="all"
          checked={access === "all"}
          onChange={() => setAccess("all")}
          className="accent-primary"
        />
        Every server, including ones added later
      </Label>
      <Label className="font-normal">
        <input
          type="radio"
          name="access"
          value="selected"
          checked={access === "selected"}
          onChange={() => setAccess("selected")}
          className="accent-primary"
        />
        Only these servers
      </Label>
      {access === "selected" ? (
        <div className="ml-6 flex flex-col gap-2 pt-1">
          {servers.length === 0 ? (
            <p className="text-muted-foreground">
              No servers to choose from yet.
            </p>
          ) : (
            servers.map((server) => (
              <Label key={server.id} className="font-normal">
                <Checkbox
                  name="serverIds"
                  value={server.id}
                  defaultChecked={selected.includes(server.id)}
                />
                {server.name}
                {server.kind === "openapi" ? (
                  <Badge variant="outline">API</Badge>
                ) : null}
              </Label>
            ))
          )}
        </div>
      ) : null}
    </fieldset>
  )
}
