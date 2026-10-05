import { Badge } from "@/components/ui/badge"
import type { ServerKind, ServerStatus } from "@/lib/core/servers"

export function ServerStatusBadge({
  status,
  connected,
  enabled,
  kind = "mcp",
  oauth = false,
}: {
  status: ServerStatus
  connected: boolean
  enabled: boolean
  kind?: ServerKind
  /** Signs in with OAuth: refused credentials mean connecting again. */
  oauth?: boolean
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

  // The browser is checked by finding Chromium on this machine.
  if (kind === "browser") {
    switch (status) {
      case "ok":
        return <Badge>Ready</Badge>
      case "error":
        return <Badge variant="destructive">Chromium missing</Badge>
      default:
        return <Badge variant="secondary">Not checked yet</Badge>
    }
  }

  // A mail account is checked by signing in: its password can be refused,
  // or, with OAuth, its sign-in can need renewing in PCP.
  if (kind === "jmap" || kind === "imap") {
    if (status === "client_required") {
      return <Badge variant="warning">Needs an OAuth client</Badge>
    }

    if (!connected || (oauth && status === "auth_required")) {
      return <Badge variant="warning">Needs connecting</Badge>
    }

    switch (status) {
      case "ok":
        return <Badge>Ready</Badge>
      case "auth_required":
      case "refused":
        return <Badge variant="warning">Credentials rejected</Badge>
      case "error":
        return <Badge variant="destructive">Unreachable</Badge>
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
