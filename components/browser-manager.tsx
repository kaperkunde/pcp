"use client"

import Link from "next/link"
import { useActionState, useEffect, useState, useTransition } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { LocalDate } from "@/components/local-date"
import { SubmitButton } from "@/components/submit-button"
import { Badge } from "@/components/ui/badge"
import { Button, ButtonLink } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  browserOverviewAction,
  closeBrowserAction,
  closeTabAction,
  enableBrowserAction,
  forgetSitesAction,
  openTabAction,
  updateBrowserAction,
} from "@/lib/actions/browser"
import type { BrowserOverview } from "@/lib/core/browser/owner"
import type { ActionState } from "@/lib/server/action-state"

/** How often the page asks for the tabs and the browser's state. */
const REFRESH_MS = 5_000

/**
 * The Browser page's cards: adding the browser, its tabs (live), opening
 * one of your own, the sign-ins it keeps, and Chromium on this machine.
 */
export function BrowserManager({
  initial,
  serverDescription,
  desktop,
}: {
  initial: BrowserOverview
  serverDescription: string
  desktop: boolean
}) {
  const [overview, setOverview] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setOverview(initial), [initial])

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return
      void browserOverviewAction().then((next) => next && setOverview(next))
    }
    const timer = setInterval(refresh, REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  function act(run: () => Promise<ActionState>, confirm?: string) {
    if (confirm && !window.confirm(confirm)) return

    startTransition(async () => {
      const result = await run()
      setError(result.status === "error" ? result.error : null)
      const next = await browserOverviewAction()
      if (next) setOverview(next)
    })
  }

  const { server, chromium, status, profile, tabs } = overview

  return (
    <div className="flex flex-col gap-6">
      {!server ? (
        <Card>
          <CardHeader>
            <CardTitle>Add the browser</CardTitle>
            <CardDescription>
              A web browser on the machine PCP runs on, which assistants can use
              through PCP: open pages, read them, click and type. It keeps its
              sign-ins, encrypted with your vault, between conversations. You
              decide which sites each token opens, as for web fetch, and you can
              watch any tab here and take it over to sign in or solve a CAPTCHA.
              Nothing starts until an assistant or you open a page.
            </CardDescription>
          </CardHeader>
          <CardContent className="items-start">
            <Button
              type="button"
              disabled={pending}
              onClick={() => act(enableBrowserAction)}
            >
              Add the browser
            </Button>
            <FormError error={error} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Tabs</CardTitle>
          <CardDescription>
            Every tab open in the browser, the assistants&apos; and yours. Open
            one to watch it live, or to take it over: while you have a tab,
            assistants leave it alone.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {tabs.length === 0 ? (
            <p className="text-muted-foreground">
              No tabs are open
              {status.running ? "." : ": the browser is not running."}
            </p>
          ) : (
            <ul
              className="flex flex-col divide-y divide-border"
              aria-label="Open tabs"
            >
              {tabs.map((tab) => (
                <li
                  key={tab.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                  aria-label={tab.title || tab.url}
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <Link
                      href={`/browser/tabs/${tab.id}`}
                      className="truncate font-medium underline-offset-4 hover:underline"
                    >
                      {tab.title || "(no title)"}
                    </Link>
                    <code className="truncate text-xs text-muted-foreground">
                      {tab.url}
                    </code>
                    <span className="text-xs text-muted-foreground">
                      Opened by{" "}
                      {tab.openedBy === "owner" ? "you" : tab.openedBy} · last
                      used <LocalDate value={tab.lastUsedAt} />
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {tab.control === "owner" ? (
                      <Badge>{tab.handover ? "Handed to you" : "Yours"}</Badge>
                    ) : null}
                    <ButtonLink
                      href={`/browser/tabs/${tab.id}`}
                      size="sm"
                      variant="outline"
                    >
                      Watch
                    </ButtonLink>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => act(() => closeTabAction(tab.id))}
                      aria-label={`Close ${tab.title || tab.url}`}
                    >
                      Close
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {server ? <OpenTabForm /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sign-ins</CardTitle>
          <CardDescription>
            The browser keeps the cookies, local storage and IndexedDB of the
            sites it visits, encrypted with your vault, so a sign-in lasts
            between conversations. Where you have signed in, an assistant with
            the browser acts as you. It cannot read them: no tool hands back a
            cookie or runs a script.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          {profile ? (
            <p data-testid="browser-profile">
              Kept for {profile.sites} {profile.sites === 1 ? "site" : "sites"}{" "}
              ({profile.cookies} {profile.cookies === 1 ? "cookie" : "cookies"}
              ), saved <LocalDate value={profile.savedAt} />.
              {profile.partial
                ? " Some sites stored more than PCP keeps, so their IndexedDB was left out."
                : null}
            </p>
          ) : (
            <p className="text-muted-foreground" data-testid="browser-profile">
              Nothing kept yet.
            </p>
          )}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={pending || (!profile && !status.running)}
            onClick={() =>
              act(
                forgetSitesAction,
                "Close the browser and sign it out of every site?",
              )
            }
          >
            Forget all sites
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Chromium</CardTitle>
          <CardDescription>
            The browser is Chromium, run without a window on this machine. It
            starts with the first page opened and closes after fifteen minutes
            with nothing happening.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          {chromium.path ? (
            <p>
              Found at <code className="text-xs">{chromium.path}</code>.{" "}
              {status.running
                ? `Running, with ${status.tabs} ${status.tabs === 1 ? "tab" : "tabs"}${status.sandbox === false ? ", without Chromium's own sandbox (this machine does not provide one)" : ""}.`
                : "Not running."}
            </p>
          ) : (
            <p className="text-warning">
              Chromium is not installed on this machine.{" "}
              {desktop
                ? "Installing it from the app comes in a later version; until then, point PCP_BROWSER_EXECUTABLE at an installed Chromium or Chrome."
                : "PCP's Docker image includes it; elsewhere, run `pnpm exec playwright install chromium`, or point PCP_BROWSER_EXECUTABLE at an installed Chromium or Chrome."}
            </p>
          )}
          {status.running ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => act(closeBrowserAction)}
            >
              Close the browser
            </Button>
          ) : null}
          <FormError error={server ? error : null} />
        </CardContent>
      </Card>

      {server ? (
        <Card>
          <CardHeader>
            <CardTitle>For assistants</CardTitle>
            <CardDescription>
              A token reaches the browser like any server: one that reaches
              every server, or one you picked it for. Which sites it opens
              follows its web fetch sites and GET setting, on{" "}
              <Link href="/tokens" className="underline">
                its page
              </Link>
              , and which browser tools it runs without asking, on{" "}
              <Link href={`/servers/${server.id}`} className="underline">
                the browser&apos;s server page
              </Link>
              . The name and description are what assistants read.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DescribeForm name={server.name} description={serverDescription} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function OpenTabForm() {
  const [state, action] = useActionState<ActionState, FormData>(openTabAction, {
    status: "idle",
  })

  return (
    <form
      action={action}
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
    >
      <Field label="Open a tab of your own" htmlFor="browser-open-url">
        <Input
          id="browser-open-url"
          name="url"
          required
          maxLength={8192}
          autoComplete="off"
          placeholder="https://example.com/login"
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        It opens taken over by you, to sign in somewhere for the assistants;
        hand it back when they may use it.
      </p>
      <FormError error={state.status === "error" ? state.error : null} />
      <div>
        <SubmitButton pendingText="Opening…">Open</SubmitButton>
      </div>
    </form>
  )
}

function DescribeForm({
  name,
  description,
}: {
  name: string
  description: string
}) {
  const [state, action] = useActionState<
    ActionState<{ message: string }>,
    FormData
  >(updateBrowserAction, { status: "idle" })

  return (
    <form action={action} className="flex flex-col gap-3">
      <Field label="Name" htmlFor="browser-name">
        <Input
          id="browser-name"
          name="name"
          defaultValue={name}
          maxLength={80}
          required
        />
      </Field>
      <Field label="Description" htmlFor="browser-description">
        <Textarea
          id="browser-description"
          name="description"
          defaultValue={description}
          maxLength={1000}
          rows={3}
        />
      </Field>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
      <div>
        <SubmitButton pendingText="Saving…">Save</SubmitButton>
      </div>
    </form>
  )
}
