import { Badge } from "@/components/ui/badge"
import type { ServerStatus } from "@/lib/core/servers"

export function ServerStatusBadge({
  status,
  connected,
  enabled,
}: {
  status: ServerStatus
  connected: boolean
  enabled: boolean
}) {
  if (!enabled) {
    return <Badge variant="outline">Disabled</Badge>
  }

  if (!connected || status === "auth_required") {
    return <Badge variant="warning">Needs connecting</Badge>
  }

  switch (status) {
    case "ok":
      return <Badge>Connected</Badge>
    case "error":
      return <Badge variant="destructive">Unreachable</Badge>
    default:
      return <Badge variant="secondary">Not checked yet</Badge>
  }
}
