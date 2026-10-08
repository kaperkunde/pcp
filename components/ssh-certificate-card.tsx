"use client"

import { useActionState, useState, useTransition } from "react"

import { CopyableValue } from "@/components/copyable-value"
import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  replaceSshKeyAction,
  setSshCertificateAction,
} from "@/lib/actions/ssh-servers"
import type { SshServerView } from "@/lib/core/ssh/hosts"

/**
 * PCP's side of signing in to an SSH server: its key for you to sign, the
 * certificate you made for it, and the host CAs it checks the server
 * against. Nothing here is secret; the private key never leaves PCP.
 */
export function SshCertificateCard({
  serverId,
  slug,
  view,
}: {
  serverId: string
  slug: string
  view: SshServerView
}) {
  const [state, action] = useActionState<ServerActionResult, FormData>(
    setSshCertificateAction,
    { status: "idle" },
  )
  const [pending, startTransition] = useTransition()
  const [keyResult, setKeyResult] = useState<ServerActionResult>({
    status: "idle",
  })
  const file = `pcp-${slug}.pub`
  const certificate = view.certificate

  function newKey() {
    if (
      !window.confirm(
        "Make PCP a new key for this server? It forgets the old one, and the certificate goes with it: nothing runs there until you sign the new key.",
      )
    ) {
      return
    }

    startTransition(async () => {
      setKeyResult(await replaceSshKeyAction(serverId))
    })
  }

  return (
    <Card data-testid="ssh-certificate">
      <CardHeader>
        <CardTitle>Certificate</CardTitle>
        <CardDescription>
          PCP signs in as <code className="text-xs">{view.username}</code> with
          a key of its own and a certificate your user CA made for it, and with
          nothing else: no password, no key on its own. The private key never
          leaves PCP.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">PCP&apos;s key</h3>
          <p className="text-muted-foreground">
            Save it as <code className="text-xs">{file}</code> and sign it with
            your user CA, for the login PCP uses:
          </p>
          <CopyableValue value={view.publicKey} testId="ssh-public-key" />
          <CopyableValue
            value={`ssh-keygen -s user_ca -I pcp-${slug} -n ${view.username} -V +52w ${file}`}
          />
          <p className="text-xs text-muted-foreground">
            {view.publicKeyFingerprint}. The server has to trust that CA
            (TrustedUserCAKeys in sshd_config). To keep PCP to one command
            there, add <code>-O force-command=…</code>; a shorter{" "}
            <code>-V</code> means renewing sooner.
          </p>
        </section>

        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="id" value={serverId} />
          <Field
            label={certificate ? "Replace the certificate" : "Certificate"}
            htmlFor={`ssh-${serverId}-certificate`}
            hint={`The contents of pcp-${slug}-cert.pub, which ssh-keygen wrote next to the key.`}
          >
            <Textarea
              id={`ssh-${serverId}-certificate`}
              name="certificate"
              required
              rows={3}
              spellCheck={false}
              className="font-mono text-xs"
              placeholder="ssh-ed25519-cert-v01@openssh.com AAAA…"
            />
          </Field>
          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton pendingText="Checking…">
              Save certificate
            </SubmitButton>
          </div>
        </form>

        {certificate ? (
          <section className="flex flex-col gap-1">
            <h3 className="font-medium">The certificate PCP has</h3>
            {certificate.problem ? (
              <p className="text-warning">{certificate.problem}</p>
            ) : null}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Key ID</dt>
              <dd>
                <code className="text-xs">{certificate.keyId || "(none)"}</code>
                {certificate.serial ? ` · serial ${certificate.serial}` : null}
              </dd>
              <dt className="text-muted-foreground">Logins</dt>
              <dd>{certificate.principals.join(", ") || "(none)"}</dd>
              <dt className="text-muted-foreground">Valid</dt>
              <dd>
                {certificate.validAfter ? (
                  <>
                    from <LocalDate value={certificate.validAfter} />{" "}
                  </>
                ) : null}
                {certificate.validBefore ? (
                  <>
                    until <LocalDate value={certificate.validBefore} />
                  </>
                ) : (
                  "with no end"
                )}
              </dd>
              {certificate.criticalOptions.length > 0 ? (
                <>
                  <dt className="text-muted-foreground">Options</dt>
                  <dd>
                    {certificate.criticalOptions.map((option) => (
                      <code key={option.name} className="block text-xs">
                        {option.name}
                        {option.value ? `=${option.value}` : ""}
                      </code>
                    ))}
                  </dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Signed by</dt>
              <dd>
                <code className="text-xs">{certificate.authority}</code>
              </dd>
            </dl>
          </section>
        ) : null}

        <section className="flex flex-col gap-1">
          <h3 className="font-medium">Host CAs PCP accepts</h3>
          <ul className="flex flex-col gap-1">
            {view.hostCas.map((ca) => (
              <li key={ca.line}>
                <code className="text-xs">{ca.fingerprint}</code>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            The server must present a host certificate from one of them naming{" "}
            <code>{view.host}</code>. Change them in the settings below.
          </p>
        </section>

        <div className="flex flex-col items-start gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={newKey}
          >
            Make a new key
          </Button>
          <FormError
            error={keyResult.status === "error" ? keyResult.error : null}
          />
          <FormNote
            message={keyResult.status === "ok" ? keyResult.message : null}
          />
        </div>
      </CardContent>
    </Card>
  )
}
