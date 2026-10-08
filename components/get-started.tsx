import { ButtonLink } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * Before there is anything here: an assistant can do the adding. It finds
 * the server or the API's schema and proposes it with register_server, and
 * nothing exists until the owner agrees, so all it needs is a token.
 */
export function GetStarted({ hasToken }: { hasToken: boolean }) {
  return (
    <Card data-testid="servers-start">
      <CardHeader>
        <CardTitle>Let an assistant set them up</CardTitle>
        <CardDescription>
          You do not have to add servers and endpoints by hand. Connect an
          assistant to PCP with an API token, then ask it, for example:
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2 text-[15px]">
          <li>
            <q className="font-medium">Have PCP add my Gmail</q>
          </li>
          <li>
            <q className="font-medium">Have PCP add the Porkbun API</q>
          </li>
        </ul>
        <p className="leading-relaxed text-muted-foreground">
          It finds the server, or the API&apos;s schema, and asks you first: you
          see the address and the tools, and nothing is added until you agree. A
          password or key it needs, you type in on PCP&apos;s own page, never in
          the chat.
        </p>
        <div>
          <ButtonLink href="/tokens">
            {hasToken ? "Open your API tokens" : "Create your first API token"}
          </ButtonLink>
        </div>
      </CardContent>
    </Card>
  )
}
