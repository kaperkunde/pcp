import { Badge } from "@/components/ui/badge"
import type { ServerKind, ServerStatus } from "@/lib/core/servers"

export function ServerStatusBadge({
  status,
  connected,
  enabled,
  kind = "mcp",
}: {
  status: ServerStatus
  connected: boolean
  enabled: boolean
  kind?: ServerKind
}) {
  if (!enabled) {
    return <Badge variant="outline">Disabled</Badge>
  }

  // An API endpoint is "connected" only when it signs in with OAuth: PCP has
  // read its schema, and calls it only when an assistant does.
  if (kind === "openapi") {
    if (status === "client_required") {
      return <Badge variant="warning">Needs an OAuth client</Badge>
    }

    if (!connected) {
      return <Badge variant="warning">Needs connecting</Badge>
    }

    switch (status) {
      case "ok":
        return <Badge>Ready</Badge>
      case "auth_required":
        return <Badge variant="warning">Credentials rejected</Badge>
      case "error":
        return <Badge variant="destructive">Schema problem</Badge>
      default:
        return <Badge variant="secondary">Not checked yet</Badge>
    }
  }

  if (status === "client_required") {
    return <Badge variant="warning">Needs an OAuth client</Badge>
  }

  if (!connected || status === "auth_required") {
    return <Badge variant="warning">Needs connecting</Badge>
  }

  switch (status) {
    case "ok":
      return <Badge>Connected</Badge>
    case "refused":
      return <Badge variant="destructive">Access refused</Badge>
    case "error":
      return <Badge variant="destructive">Unreachable</Badge>
    default:
      return <Badge variant="secondary">Not checked yet</Badge>
  }
}
