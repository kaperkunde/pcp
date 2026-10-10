"use client"

import { useState, useTransition } from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError, FormNote } from "@/components/form-status"
import { Button } from "@/components/ui/button"
import { List, ListRow, ListSection } from "@/components/ui/list"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  forgetSshHostKeyAction,
  replaceSshKeyAction,
} from "@/lib/actions/ssh-servers"
import type { SshServerView } from "@/lib/core/ssh/hosts"

/**
 * How PCP signs in to an SSH server and knows it is the same one: its key,
 * for you to add on the server, and the host key it pinned the first time.
 * Nothing here is secret; the private key never leaves PCP.
 */
export function SshAccessCard({
  serverId,
  view,
}: {
  serverId: string
  view: SshServerView
}) {
  const [pending, startTransition] = useTransition()
  const [result, setResult] = useState<ServerActionResult>({ status: "idle" })

  function run(question: string, action: () => Promise<ServerActionResult>) {
    if (!window.confirm(question)) {
      return
    }

    startTransition(async () => {
      setResult(await action())
    })
  }

  return (
    <ListSection
      title="Sign-in"
      description={
        <>
          PCP signs in as{" "}
          <code className="text-foreground">{view.username}</code> with a key of
          its own, never a password. The private key never leaves PCP.
        </>
      }
      data-testid="ssh-access"
    >
      <List>
        <div data-slot="list-row" className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[15px] leading-snug">PCP&apos;s key</span>
            <span className="text-xs leading-relaxed text-muted-foreground">
              Add it to <code>~/.ssh/authorized_keys</code> of{" "}
              <code>{view.username}</code> on the server.
            </span>
          </div>
          <CopyableValue value={view.publicKey} testId="ssh-public-key" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            <code className="break-all">{view.publicKeyFingerprint}</code>. To
            keep PCP to one command there, put{" "}
            <code>command=&quot;…&quot;,restrict</code> in front of it.
          </p>
        </div>

        <ListRow
          title="The server's host key"
          description={
            view.hostKey ? (
              <>
                <span
                  data-testid="ssh-host-key"
                  className="block font-mono break-all text-foreground"
                >
                  {view.hostKey.type} {view.hostKey.fingerprint}
                </span>
                Pinned the first time PCP connected; PCP refuses any other key
                from this address. Compare it with the server&apos;s own (
                <code>ssh-keygen -lf</code> on its{" "}
                <code>/etc/ssh/ssh_host_*_key.pub</code>).
              </>
            ) : (
              "Not seen yet: PCP pins it the first time it connects."
            )
          }
          trailing={
            view.hostKey ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(
                    "Forget the pinned host key? PCP connects again at once and pins whatever key the server shows then. Do this only when you changed the server's key yourself.",
                    () => forgetSshHostKeyAction(serverId),
                  )
                }
              >
                Forget host key
              </Button>
            ) : null
          }
        />

        <ListRow
          title="A new key for PCP"
          description="PCP forgets the old one: nothing runs there until you add the new key on the server."
          trailing={
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(
                  "Make PCP a new key for this server? It forgets the old one: nothing runs there until you add the new key on the server.",
                  () => replaceSshKeyAction(serverId),
                )
              }
            >
              Make a new key
            </Button>
          }
        />
      </List>
      <FormError
        className="px-1"
        error={result.status === "error" ? result.error : null}
      />
      <FormNote
        className="px-1"
        message={result.status === "ok" ? result.message : null}
      />
    </ListSection>
  )
}
