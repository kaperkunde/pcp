"use client"

import Link from "next/link"
import { useActionState, useState } from "react"

import { Badge } from "@kaperkunde/ui/badge"
import { CopyableValue } from "@kaperkunde/ui/copy-button"
import { Disclosure } from "@kaperkunde/ui/disclosure"
import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { Input } from "@kaperkunde/ui/input"
import { Field } from "@kaperkunde/ui/label"
import { List, ListSection } from "@kaperkunde/ui/list"
import { SubmitButton } from "@kaperkunde/ui/submit-button"
import { SwitchRow } from "@kaperkunde/ui/switch"

import { SecretChoice } from "@/components/auth-fields-secret"
import type { SecretOption } from "@/components/header-auth-fields"
import {
  disconnectGoogleAction,
  removeGoogleAction,
  saveGoogleAction,
  type GoogleActionResult,
} from "@/lib/actions/google"

/** Google's page that makes a client for an AI agent in one go. */
export const GOOGLE_CLIENT_PAGE =
  "https://console.cloud.google.com/auth/overview/personal?apis=ws,wsmcp,tasksmcp&clientType=web&isAgent=true"

export type GoogleProductRow = {
  id: string
  name: string
  allows: string
  scopes: string[]
  chosen: boolean
  granted: boolean
  server: {
    id: string
    enabled: boolean
    status: string
    toolCount: number
  } | null
}

export type GoogleFormProps = {
  clientId: string
  clientSecretId: string
  secrets: SecretOption[]
  redirectUrl: string
  status: "none" | "disconnected" | "connected" | "needs_reconnect"
  email: string | null
  products: GoogleProductRow[]
}

const idle: GoogleActionResult = { status: "idle" }

/**
 * The owner's Google page: their own Google client (with the steps to make
 * it), the products they want, and one Connect. Chosen products Google has
 * not granted yet ask for consent again when connected.
 */
export function GoogleForm({
  clientId: initialClientId,
  clientSecretId,
  secrets,
  redirectUrl,
  status,
  email,
  products,
}: GoogleFormProps) {
  const [state, action] = useActionState(saveGoogleAction, idle)
  const [clientId, setClientId] = useState(initialClientId)
  const [secretId, setSecretId] = useState(clientSecretId)
  const [chosen, setChosen] = useState(
    () => new Set(products.filter((p) => p.chosen).map((p) => p.id)),
  )
  const connected = status === "connected"
  const lacking = products.filter(
    (product) => chosen.has(product.id) && !product.granted,
  )
  const toggle = (id: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current)

      if (on) next.add(id)
      else next.delete(id)

      return next
    })

  const connectLabel = !connected
    ? status === "needs_reconnect"
      ? "Connect Google again"
      : "Save and connect Google"
    : lacking.length > 0
      ? "Save and allow the new products"
      : "Reconnect Google"

  return (
    <form action={action} className="flex flex-col gap-8">
      <ListSection
        title="Your Google client"
        description="Google lets you make a client of your own for an assistant, so the sign-in stays between you, Google and PCP. PCP never has to be approved by Google."
      >
        <div className="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-separator">
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-[13px] leading-relaxed text-muted-foreground">
            <li>
              Open{" "}
              <a
                href={GOOGLE_CLIENT_PAGE}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                Google&apos;s page for a personal client
              </a>
              . It switches on the Workspace APIs and their MCP APIs in a
              project of yours.
            </li>
            <li>
              Make a{" "}
              <strong className="text-foreground">Web application</strong>{" "}
              client and tick{" "}
              <strong className="text-foreground">
                Use this client for an AI-powered agent
              </strong>
              .
            </li>
            <li>
              Add this as its redirect address (the same one every PCP sign-in
              uses):
            </li>
          </ol>
          <CopyableValue value={redirectUrl} testId="google-redirect-url" />
          <ol
            start={4}
            className="flex list-decimal flex-col gap-2 pl-5 text-[13px] leading-relaxed text-muted-foreground"
          >
            <li>
              Publish the app to{" "}
              <strong className="text-foreground">Production</strong> (Audience,
              then Publish app). While it stays in Testing, Google ends the
              sign-in after 7 days.
            </li>
            <li>Copy the client ID and its secret here.</li>
          </ol>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Google words its pages its own way; the steps are the same.
          </p>

          <Field
            label="Client ID"
            htmlFor="google-client-id"
            hint="Ends in .apps.googleusercontent.com."
          >
            <Input
              id="google-client-id"
              name="clientId"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              required
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="1234567890-abc.apps.googleusercontent.com"
            />
          </Field>
          <SecretChoice
            prefix="google"
            label="Client secret"
            secrets={secrets}
            value={secretId}
            onValueChange={setSecretId}
            initialId={clientSecretId}
            typeNew={{
              option: "A new secret, entered here",
              valueLabel: "Client secret",
              valueHint: "Google shows it once, beside the client ID.",
              nameHint: "Left empty, it is named Google client secret.",
            }}
          />
        </div>
      </ListSection>

      <ListSection
        title="What PCP may reach"
        description="One server for each product you tick, all behind one Google sign-in. Every tool starts as Ask you first: nothing an assistant does reaches Google until you allow it, tool by tool."
      >
        <List as="ul">
          {products.map((product) => (
            <li key={product.id} className="list-none">
              <SwitchRow
                id={`google-product-${product.id}`}
                name="products"
                value={product.id}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    {product.name}
                    {connected && chosen.has(product.id) ? (
                      product.granted ? (
                        product.server ? (
                          <Badge variant="secondary">
                            {product.server.enabled
                              ? `${product.server.toolCount} tools`
                              : "Off"}
                          </Badge>
                        ) : null
                      ) : (
                        <Badge variant="solid-warning">Needs permission</Badge>
                      )
                    ) : null}
                  </span>
                }
                description={product.allows}
                checked={chosen.has(product.id)}
                onChange={(event) => toggle(product.id, event.target.checked)}
                trailing={
                  product.server ? (
                    <Link
                      href={`/servers/${product.server.id}`}
                      className="text-[13px] text-primary hover:underline"
                    >
                      Open
                    </Link>
                  ) : null
                }
              />
            </li>
          ))}
        </List>
        <Disclosure
          title="Exactly what PCP asks Google for"
          description="The permissions behind the ticked products"
          className="mt-3 rounded-[10px] border border-input bg-field"
        >
          <ul className="flex flex-col gap-2 text-[13px] leading-relaxed text-muted-foreground">
            <li>
              Your email address, to show which Google account is connected
              (openid, email).
            </li>
            {products
              .filter((product) => chosen.has(product.id))
              .map((product) => (
                <li key={product.id}>
                  <strong className="text-foreground">{product.name}:</strong>{" "}
                  {product.scopes
                    .map((scope) =>
                      scope.replace("https://www.googleapis.com/auth/", ""),
                    )
                    .join(", ")}
                </li>
              ))}
          </ul>
        </Disclosure>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Turning a product off disables its server; remove it from Servers if
          you want it gone. Google keeps what you already allowed until you
          disconnect.
        </p>
      </ListSection>

      <div className="flex flex-col gap-3">
        <FormError error={state.status === "error" ? state.error : null} />
        <FormNote message={state.status === "ok" ? state.message : null} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {connected && lacking.length === 0 ? (
            <SubmitButton
              name="intent"
              value="connect"
              variant="secondary"
              pendingText="Opening Google…"
            >
              {connectLabel}
            </SubmitButton>
          ) : (
            <SubmitButton
              name="intent"
              value="save"
              variant="secondary"
              pendingText="Saving…"
            >
              Save
            </SubmitButton>
          )}
          {connected && lacking.length === 0 ? (
            <SubmitButton
              name="intent"
              value="save"
              pendingText="Saving…"
              data-testid="google-save"
            >
              Save
            </SubmitButton>
          ) : (
            <SubmitButton
              name="intent"
              value="connect"
              pendingText="Opening Google…"
              data-testid="google-connect"
            >
              {connectLabel}
            </SubmitButton>
          )}
        </div>
        {connected && email ? (
          <p className="text-right text-xs text-muted-foreground">
            Connected as {email}.
          </p>
        ) : null}
      </div>
    </form>
  )
}

/** Disconnect and Remove, last on the page, as red text with a grey line. */
export function GoogleEnd({
  connected,
  exists,
}: {
  connected: boolean
  exists: boolean
}) {
  const [left, leave] = useActionState(disconnectGoogleAction, idle)
  const [gone, remove] = useActionState(removeGoogleAction, idle)

  if (!exists) {
    return null
  }

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      {connected ? (
        <form action={leave} className="flex flex-col items-center gap-1">
          <SubmitButton variant="destructive" pendingText="Disconnecting…">
            Disconnect Google
          </SubmitButton>
          <p className="text-xs text-muted-foreground">
            Google is asked to revoke PCP&apos;s access and PCP deletes its
            tokens. The servers stay, signed out.
          </p>
          <FormError error={left.status === "error" ? left.error : null} />
          <FormNote message={left.status === "ok" ? left.message : null} />
        </form>
      ) : null}
      <form action={remove} className="flex flex-col items-center gap-1">
        <SubmitButton variant="destructive" pendingText="Removing…">
          Remove Google from PCP
        </SubmitButton>
        <p className="text-xs text-muted-foreground">
          Disconnects, removes the Google servers and forgets your client. Your
          client secret stays under Secrets.
        </p>
        <FormError error={gone.status === "error" ? gone.error : null} />
        <FormNote message={gone.status === "ok" ? gone.message : null} />
      </form>
    </div>
  )
}
