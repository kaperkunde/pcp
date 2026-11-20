import { ButtonLink } from "@kaperkunde/ui/button"
import { ThingsToSay } from "@/components/things-to-say"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@kaperkunde/ui/card"

/**
 * Before there is anything here: an assistant can do the adding. Asked in
 * the owner's words, it finds what PCP can set up (search's "can set up"
 * lines), says what it takes and proposes it, and nothing exists until the
 * owner agrees, so all it needs is to be connected.
 */
export function GetStarted({ hasToken }: { hasToken: boolean }) {
  return (
    <Card data-testid="servers-start">
      <CardHeader>
        <CardTitle>Talk to Claude</CardTitle>
        <CardDescription>
          You do not have to set things up by hand. Add PCP to Claude or another
          assistant, then ask it, for example:
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ThingsToSay />
        <p className="leading-relaxed text-muted-foreground">
          It says what that takes and asks you first, with a link to PCP: you
          see what it would add or run, and nothing changes until you agree. A
          password or key it needs, you type in on PCP&apos;s own page, never in
          the chat.
        </p>
        <div>
          <ButtonLink href="/tokens">
            {hasToken ? "Open your assistants" : "Connect an assistant"}
          </ButtonLink>
        </div>
      </CardContent>
    </Card>
  )
}
