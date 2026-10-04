import type { ReactNode } from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * How to reach PCP from the internet when it runs at home. Shown on the
 * Settings page while PCP's address is one only the owner's own network can
 * reach (lib/core/local-address.ts): the usual case for the desktop app and
 * for Docker on a machine behind a home router.
 */
export function OutsideAccessCard({
  address,
  desktop,
}: {
  /** Where PCP is reached now, e.g. http://localhost:3000. */
  address: string
  /** Started by the desktop app, which listens on this computer only until told otherwise. */
  desktop: boolean
}) {
  const port = portOf(address)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reaching PCP from outside your home</CardTitle>
        <CardDescription>
          PCP answers at <code>{address}</code>, an address only this computer
          or your own network can reach. An assistant that runs here, such as
          Claude Code or a desktop app, can use it as it is. One that runs
          somewhere else, including Claude&apos;s own servers, needs an address
          that reaches this computer from the internet. There are two ways to
          get one; a tunnel is the easier.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-5">
        <Section title="A tunnel: no router changes">
          <p>
            A tunnel program runs on this computer, connects out to a service
            and gives you a public <code>https</code> address that forwards to
            PCP. It works behind any router, on a shared connection too, and
            brings its own certificate.
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong>Cloudflare Tunnel</strong>:{" "}
              <code>cloudflared tunnel --url http://localhost:{port}</code>{" "}
              prints a temporary address at once; a named tunnel on a domain of
              yours keeps the same one.
            </li>
            <li>
              <strong>Tailscale Funnel</strong>:{" "}
              <code>tailscale funnel {port}</code> publishes PCP at your
              machine&apos;s Tailscale name.
            </li>
            <li>
              <strong>ngrok</strong>: <code>ngrok http {port}</code>.
            </li>
          </ul>
          <p>
            Then enter the address it gave you under{" "}
            <strong>Public address</strong> above, so the endpoint address and
            OAuth redirects use it.
          </p>
        </Section>

        <Section title="Port forwarding on your router" collapsed>
          <p>
            Your router gives this computer a private address and hides it
            behind the one your provider gave you. Forwarding a port lets a
            connection to your public address through to PCP.
          </p>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              {desktop ? (
                <>
                  In the PCP app&apos;s menu, turn on{" "}
                  <strong>Accept connections from other devices</strong>. Until
                  then PCP answers this computer only.
                </>
              ) : (
                <>
                  Make sure PCP accepts connections from other devices. The
                  Docker image does; with <code>pnpm start</code> it does unless{" "}
                  <code>HOSTNAME</code> says otherwise.
                </>
              )}
            </li>
            <li>
              Give this computer a fixed address on your network: a DHCP
              reservation in the router&apos;s settings, so the forward keeps
              pointing at it.
            </li>
            <li>
              In the router, forward a port to this computer&apos;s address,
              port {port}. Routers call this port forwarding, virtual server,
              NAT or applications. Use the same number outside unless you have a
              reason not to.
            </li>
            <li>
              Your public address changes now and then. A dynamic DNS name
              (DuckDNS, No-IP, or your router&apos;s own) keeps a name pointing
              at it; use the name, not the number.
            </li>
            <li>
              OAuth servers require <code>https</code>, and your password should
              not cross the internet in the clear: put a TLS proxy in front.
              Caddy does it in one line and fetches the certificate itself,{" "}
              <code>
                caddy reverse-proxy --from pcp.yourname.duckdns.org --to
                localhost:{port}
              </code>
              , with ports 80 and 443 forwarded to this computer.
            </li>
            <li>
              Enter the address under <strong>Public address</strong> above.
            </li>
          </ol>
        </Section>

        <Section title="If it does not work" collapsed>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong>Test from outside</strong>: a phone on mobile data, not
              your wifi. Many home routers cannot reach their own public address
              from inside, so a test from your own network can fail while the
              forward works.
            </li>
            <li>
              <strong>A shared connection</strong>: if your router&apos;s
              internet address starts with 100.64 to 100.127 or 10., or your
              provider mentions CGNAT or DS-Lite, there is no port of yours to
              forward. Use a tunnel.
            </li>
            <li>
              <strong>Two routers</strong>: a modem with a router of its own, or
              a mesh system, needs the forward on each, or the first one in
              bridge mode.
            </li>
            <li>
              <strong>This computer&apos;s firewall</strong> has to let the port
              through. Windows asks the first time PCP listens; allow it on
              private networks.
            </li>
            <li>
              <strong>Public address</strong>: once PCP is reachable, the
              address above must be the public one, or OAuth servers send you
              back to an address that only works here.
            </li>
          </ul>
        </Section>
      </CardContent>
    </Card>
  )
}

function Section({
  title,
  collapsed = false,
  children,
}: {
  title: string
  collapsed?: boolean
  children: ReactNode
}) {
  const body = (
    <div className="flex flex-col gap-3 text-muted-foreground [&_code]:text-foreground [&_strong]:font-medium [&_strong]:text-foreground">
      {children}
    </div>
  )

  if (!collapsed) {
    return (
      <section className="flex flex-col gap-3">
        <h3 className="font-medium">{title}</h3>
        {body}
      </section>
    )
  }

  return (
    <details className="group flex flex-col gap-3">
      <summary className="cursor-pointer list-none font-medium marker:hidden">
        <span className="mr-2 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        {title}
      </summary>
      <div className="mt-3">{body}</div>
    </details>
  )
}

function portOf(address: string): string {
  try {
    const url = new URL(address)
    return url.port || (url.protocol === "https:" ? "443" : "80")
  } catch {
    return "3000"
  }
}
