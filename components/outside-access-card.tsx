import type { ReactNode } from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { REPOSITORY_URL } from "@/lib/operator-identity"

const SELF_HOSTING_GUIDE = `${REPOSITORY_URL}/blob/main/docs/self-hosting.md#4-reach-pcp-from-outside-your-home-optional`

/**
 * How to reach PCP from the internet when it runs at home. Shown on the
 * Settings page while PCP's address is one only the owner's own network can
 * reach (lib/core/local-address.ts): the usual case for the desktop app and
 * for Docker on a machine behind a home router. It sits above the pcp.gg,
 * Dynamic DNS and HTTPS cards and leads to them; the other tunnels and the
 * troubleshooting are what those cards do not cover.
 */
export function OutsideAccessCard({
  address,
  desktop,
}: {
  /** Where PCP is reached now, e.g. http://localhost:3000. */
  address: string
  /** Started by the desktop app, whose menu decides who reaches its port. */
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
          somewhere else, such as Claude on the web or on a phone, needs an
          address that reaches this computer from the internet, and a home
          router does not give it one by itself. pcp.gg is the easiest way.
        </CardDescription>
      </CardHeader>
      <CardContent className="gap-5">
        <Section title="pcp.gg: paste a key">
          <p>
            pcp.gg gives PCP a name of its own, such as <code>you.pcp.gg</code>,
            and carries connections to it to this computer over a connection PCP
            opens itself. Nothing changes on your router and nothing else runs.
            PCP gets its own certificate for the name, so what passes through
            pcp.gg stays encrypted to PCP.
          </p>
          <p>
            Under <strong>pcp.gg</strong> below, paste the connection key from
            your pcp.gg dashboard.
          </p>
        </Section>

        <Section title="A tunnel: no router changes">
          <p>
            A tunnel program runs on this computer, connects out to a service
            and gives you a public <code>https</code> address that forwards to
            PCP. It works behind any router, on a connection shared with other
            customers too, and brings its own certificate.
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
            Enter the address it gives you under <strong>Public address</strong>{" "}
            above, so the endpoint address and OAuth redirects use it, and leave{" "}
            <strong>Dynamic DNS</strong> and <strong>HTTPS</strong> below off.
          </p>
        </Section>

        <Section title="Through your router: Dynamic DNS and HTTPS" collapsed>
          <p>
            Your router gives this computer a private address and hides it
            behind the one your provider gave you. Forwarding ports lets
            connections to your public address through to PCP, which then serves
            itself over HTTPS.
          </p>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              In the router&apos;s settings, give this computer a fixed address
              on your network (a DHCP reservation, or static lease), so the
              forwards keep pointing at it.
            </li>
            <li>
              Forward ports 80 and 443 (TCP) to this computer. Routers call this
              port forwarding, virtual servers, NAT or applications. Do not
              forward port {port}: it is plain HTTP, for your own network.{" "}
              {desktop ? (
                <>
                  PCP opens 80 and 443 itself once HTTPS is on; Windows asks
                  whether to let it through the firewall.
                </>
              ) : (
                <>
                  In Docker or Podman, publish ports 80 and 443 too: run the
                  installer again with <code>PCP_HTTPS=1</code>, or start PCP
                  with <code>docker-compose.https.yaml</code> as well.
                </>
              )}
            </li>
            <li>
              Under <strong>Dynamic DNS</strong> below, get a name that follows
              your connection&apos;s address when your provider changes it.
              DuckDNS is free.
            </li>
            <li>
              Under <strong>HTTPS</strong> below, turn it on for that name. PCP
              gets a certificate from Let&apos;s Encrypt and renews it.
            </li>
            <li>
              When the HTTPS card offers it, make the <code>https</code> address
              PCP&apos;s public address.
            </li>
          </ol>
          <p>
            <a
              href={SELF_HOSTING_GUIDE}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              The self-hosting guide
            </a>{" "}
            walks through each step.
          </p>
        </Section>

        {desktop ? (
          <Section title="Other devices on your network" collapsed>
            <p>
              Port {port} answers this computer only until you turn on{" "}
              <strong>Accept connections from other devices</strong> in the PCP
              app&apos;s menu. Then a laptop or phone on the same network
              reaches PCP at this computer&apos;s address, port {port}. The
              tunnel and HTTPS above do not need it.
            </p>
          </Section>
        ) : null}

        <Section title="If it does not work" collapsed>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <strong>Test from outside</strong>: a phone on mobile data, not
              your Wi-Fi. Many home routers cannot reach their own public
              address from inside, so a test from your own network can fail
              while the forward works.
            </li>
            <li>
              <strong>A shared connection</strong>: if the internet address on
              your router&apos;s status page differs from the one{" "}
              <code>api.ipify.org</code> shows, or starts with 100.64 to
              100.127, your provider shares it between customers (CGNAT) and
              there is no port of yours to forward. Ask the provider for a
              public IPv4 address, or use a tunnel.
            </li>
            <li>
              <strong>Port 80 blocked</strong>: some providers block it on home
              plans, and Let&apos;s Encrypt needs it. Use a tunnel.
            </li>
            <li>
              <strong>Two routers</strong>: a provider&apos;s modem with a
              router of its own in front of yours, or a mesh system, needs the
              forwards on each, or the first one in bridge mode.
            </li>
            <li>
              <strong>This computer&apos;s firewall</strong> has to let ports 80
              and 443 through.
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
    <details className="group">
      <summary className="cursor-pointer list-none font-medium marker:hidden">
        <span
          aria-hidden
          className="mr-2 inline-block transition-transform group-open:rotate-90"
        >
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
