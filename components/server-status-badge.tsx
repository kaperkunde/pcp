import { Badge, StatusDot } from "@/components/ui/badge"
import type { ServerKind, ServerStatus } from "@/lib/core/servers"
import { cn } from "@/lib/utils"

export type ServerStatusInput = {
  status: ServerStatus
  connected: boolean
  enabled: boolean
  kind?: ServerKind
  /** Signs in with OAuth: refused credentials mean connecting again. */
  oauth?: boolean
}

export type ServerStatusTone = "ok" | "warning" | "error" | "off"

/**
 * A server's state in a word or two, and how it reads: `warning` when it
 * needs the owner (connecting, a client, a credential), `error` when it
 * is broken in a way the owner may not fix from here.
 */
export function serverStatus({
  status,
  connected,
  enabled,
  kind = "mcp",
  oauth = false,
}: ServerStatusInput): { label: string; tone: ServerStatusTone } {
  const ok = (label: string) => ({ label, tone: "ok" as const })
  const warning = (label: string) => ({ label, tone: "warning" as const })
  const error = (label: string) => ({ label, tone: "error" as const })
  const unchecked = { label: "Not checked yet", tone: "off" as const }

  if (!enabled) {
    return { label: "Disabled", tone: "off" }
  }

  // An API endpoint is "connected" only when it signs in with OAuth: PCP has
  // read its schema, and calls it only when an assistant does.
  if (kind === "openapi") {
    if (status === "client_required") return warning("Needs an OAuth client")
    if (!connected) return warning("Needs connecting")

    switch (status) {
      case "ok":
        return ok("Ready")
      case "auth_required":
        return warning("Credentials rejected")
      case "error":
        return error("Schema problem")
      default:
        return unchecked
    }
  }

  // A wrapper's tools are built from what you approved: nothing to reach.
  if (kind === "wrapper") {
    return status === "error" ? error("Broken") : ok("Ready")
  }

  // The browser is checked by finding Chromium on this machine.
  if (kind === "browser") {
    switch (status) {
      case "ok":
        return ok("Ready")
      case "error":
        return error("Chromium missing")
      default:
        return unchecked
    }
  }

  // A mail account is checked by signing in: its password can be refused,
  // or, with OAuth, its sign-in can need renewing in PCP.
  if (kind === "jmap" || kind === "imap") {
    if (status === "client_required") return warning("Needs an OAuth client")
    if (!connected || (oauth && status === "auth_required")) {
      return warning("Needs connecting")
    }

    switch (status) {
      case "ok":
        return ok("Ready")
      case "auth_required":
      case "refused":
        return warning("Credentials rejected")
      case "error":
        return error("Unreachable")
      default:
        return unchecked
    }
  }

  // An SSH server is checked by signing in with PCP's key: the server can
  // refuse the key (not added yet), or show another host key than the one
  // PCP pinned.
  if (kind === "ssh") {
    switch (status) {
      case "ok":
        return ok("Ready")
      case "auth_required":
      case "refused":
        return warning("Key not accepted")
      case "error":
        return error("Not connected")
      default:
        return unchecked
    }
  }

  if (status === "client_required") return warning("Needs an OAuth client")
  if (!connected || status === "auth_required") {
    return warning("Needs connecting")
  }

  switch (status) {
    case "ok":
      return ok("Connected")
    case "refused":
      return error("Access refused")
    case "error":
      return error("Unreachable")
    default:
      return unchecked
  }
}

/**
 * A server's state where it is listed or titled: a dot and a word when all
 * is well (or plainly off), a solid amber badge when it needs the owner.
 * The word is always there: colour is never the only signal.
 */
export function ServerStatusBadge({
  className,
  ...input
}: ServerStatusInput & { className?: string }) {
  const { label, tone } = serverStatus(input)

  if (tone === "warning") {
    return (
      <Badge variant="solid-warning" className={className}>
        {label}
      </Badge>
    )
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      <StatusDot tone={tone} />
      {label}
    </span>
  )
}
