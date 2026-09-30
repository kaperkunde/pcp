import type { Metadata } from "next"

import { CopyableValue } from "@/components/copyable-value"
import { PageHeader } from "@/components/page-header"
import {
  ChangePasswordForm,
  PublicUrlForm,
  RecoveryKeyCard,
  SessionsCard,
} from "@/components/settings-forms"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getSetting, SETTING_PUBLIC_URL } from "@/lib/core/settings"
import { publicUrlFor, requestOrigin } from "@/lib/server/public-url"
import { requireContext } from "@/lib/server/session"

export const metadata: Metadata = { title: "Settings" }

export default async function SettingsPage() {
  const ctx = await requireContext()
  const [pinned, detected, publicUrl] = await Promise.all([
    getSetting(ctx, SETTING_PUBLIC_URL),
    requestOrigin(),
    publicUrlFor(ctx),
  ])

  return (
    <>
      <PageHeader title="Settings" />
      <Card>
        <CardHeader>
          <CardTitle>Gateway endpoint</CardTitle>
          <CardDescription>
            Add this as a remote MCP server in your assistant, with an API token
            as the bearer token. It offers three tools — search_tools,
            describe_tool and call_tool — that reach every server you connected.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CopyableValue value={`${publicUrl}/mcp`} />
        </CardContent>
      </Card>
      <PublicUrlForm pinned={pinned ?? ""} detected={detected} />
      <ChangePasswordForm />
      <RecoveryKeyCard />
      <SessionsCard />
    </>
  )
}
