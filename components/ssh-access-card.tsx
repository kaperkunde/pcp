"use client"

import { useState, useTransition } from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError, FormNote } from "@/components/form-status"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
    <Card data-testid="ssh-access">
      <CardHeader>
        <CardTitle>Sign-in</CardTitle>
        <CardDescription>
          PCP signs in as <code className="text-xs">{view.username}</code> with
          a key of its own, never a password. The private key never leaves PCP.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">PCP&apos;s key</h3>
          <p className="text-muted-foreground">
            Add it to <code className="text-xs">~/.ssh/authorized_keys</code> of{" "}
            <code className="text-xs">{view.username}</code> on the server:
          </p>
          <CopyableValue value={view.publicKey} testId="ssh-public-key" />
          <p className="text-xs text-muted-foreground">
            {view.publicKeyFingerprint}. To keep PCP to one command there, put{" "}
            <code>command=&quot;…&quot;,restrict</code> in front of it.
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="font-medium">The server&apos;s host key</h3>
          {view.hostKey ? (
            <>
              <p className="text-muted-foreground">
                Pinned the first time PCP connected; PCP refuses any other key
                from this address. Compare it with the server&apos;s own (
                <code className="text-xs">ssh-keygen -lf</code> on its{" "}
                <code className="text-xs">/etc/ssh/ssh_host_*_key.pub</code>).
              </p>
              <p data-testid="ssh-host-key">
                <code className="text-xs">{view.hostKey.type}</code>{" "}
                <code className="text-xs">{view.hostKey.fingerprint}</code>
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">
              Not seen yet: PCP pins it the first time it connects.
            </p>
          )}
        </section>

        <div className="flex flex-wrap gap-2">
          {view.hostKey ? (
            <Button
              variant="outline"
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
          ) : null}
          <Button
            variant="outline"
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
        </div>
        <FormError error={result.status === "error" ? result.error : null} />
        <FormNote message={result.status === "ok" ? result.message : null} />
      </CardContent>
    </Card>
  )
}
