"use client"

import { Timer } from "lucide-react"
import { useActionState } from "react"

import { FormError, FormNote } from "@kaperkunde/ui/form-status"
import { describePace, PaceFields } from "@/components/pacing-fields"
import { SettingsItem } from "@/components/settings-item"
import { SubmitButton } from "@kaperkunde/ui/submit-button"
import { Disclosure } from "@kaperkunde/ui/disclosure"
import { Checkbox, Input } from "@kaperkunde/ui/input"
import { Field } from "@kaperkunde/ui/label"
import {
  type PacingResult,
  removePacingSiteAction,
  resetPacingAction,
  saveAssistantPaceAction,
  savePacingClassesAction,
  savePacingSiteAction,
} from "@/lib/actions/pacing"
import type { PacedSite, PacingOverview } from "@/lib/core/pacing/config"
import type {
  BrowserPacingClass,
  PaceRange,
  PacingClass,
} from "@/lib/core/pacing/limits"

const CLASSES: Array<{ name: PacingClass; title: string; about: string }> = [
  {
    name: "browser_act",
    title: "Browser actions in a page",
    about:
      "Clicking, typing, choosing, scrolling and the like, per site, after the previous action there ended. Typing fills a field at once, not key by key. Reading what a tab already shows is never paced.",
  },
  {
    name: "browser_navigate",
    title: "Browser opening a page",
    about:
      "Opening a page, going back and downloading by an address, per site: first the page the tab shows settles, then this wait.",
  },
  {
    name: "web_fetch",
    title: "Web fetch",
    about: "Each request web_fetch sends to a site, its redirects included.",
  },
  {
    name: "server_change",
    title: "Server calls that change things",
    about:
      "Tools a server does not mark read-only, per server: MCP servers, API endpoints, mail and calendar accounts, SSH servers.",
  },
  {
    name: "server_read",
    title: "Server calls that only read",
    about: "Tools a server marks read-only, per server.",
  },
]

const IDLE: PacingResult = { status: "idle" }

function Status({ state }: { state: PacingResult }) {
  return (
    <>
      <FormError error={state.status === "error" ? state.error : null} />
      <FormNote message={state.status === "ok" ? state.message : null} />
    </>
  )
}

/**
 * Settings → Pacing: how fast assistants may act on one site or server,
 * per kind of action, and a pace of your own for a site. Set once and
 * rarely looked at again, so all of it is folded.
 */
export function PacingCard({ overview }: { overview: PacingOverview }) {
  const own = CLASSES.filter((entry) => overview.classes[entry.name].own)
  const sites = overview.sites.length

  return (
    <SettingsItem
      id="pacing"
      title="Pacing"
      icon={Timer}
      state={[
        own.length === 0
          ? "PCP's defaults"
          : `Your own for ${own.length} ${own.length === 1 ? "kind" : "kinds"} of action`,
        sites > 0
          ? `${sites} ${sites === 1 ? "site" : "sites"} of your own`
          : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      about={
        <>
          PCP spaces out what assistants do in one place, so a site does not
          take a quick run of automated actions for a robot and flag your
          account, and a page or a server is not overloaded. Every way an
          assistant calls follows the same pace: directly, in a program, through
          a wrapper, or once you allowed it. A call waits up to 30 seconds for
          its turn; one that would wait longer is told when to try again.
        </>
      }
    >
      <ClassesForm key={JSON.stringify(overview.classes)} overview={overview} />
      <ResetForm />
      <Disclosure
        title="What assistants may set"
        description={`A tab's or a browser flow's own pace, without asking you: ${ASSISTANT_CLASSES.map(
          (entry) =>
            `${entry.short} ${rangeWords(overview.assistant[entry.name].range)}`,
        ).join(", ")}`}
      >
        <AssistantForm
          key={JSON.stringify(overview.assistant)}
          overview={overview}
        />
      </Disclosure>
      <Disclosure
        title="Sites"
        description={
          sites === 0
            ? "A pace of your own for a site, for web fetch and the browser"
            : overview.sites.map((site) => site.host).join(", ")
        }
      >
        {overview.sites.map((site) => (
          <SiteForm key={JSON.stringify(site)} site={site} />
        ))}
        <SiteForm key={`new-${sites}`} site={null} />
      </Disclosure>
    </SettingsItem>
  )
}

function ClassesForm({ overview }: { overview: PacingOverview }) {
  const [state, action] = useActionState(savePacingClassesAction, IDLE)

  return (
    <form
      action={action}
      className="flex flex-col gap-5"
      aria-label="Pacing by kind of action"
    >
      {CLASSES.map((entry) => {
        const current = overview.classes[entry.name]

        return (
          <fieldset
            key={entry.name}
            className="m-0 flex flex-col gap-2 border-0 p-0"
          >
            <legend className="text-[15px] text-foreground">
              {entry.title}
            </legend>
            <p className="text-xs text-muted-foreground">
              {entry.about} PCP&apos;s default:{" "}
              {describePace(overview.defaults[entry.name]).toLowerCase()}.
            </p>
            <PaceFields
              prefix={`${entry.name}-`}
              pace={current.pace}
              label={`Pace ${entry.title.toLowerCase()}`}
            />
          </fieldset>
        )
      })}
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="secondary" pendingText="Saving…">
          Save
        </SubmitButton>
        <Status state={state} />
      </div>
    </form>
  )
}

const ASSISTANT_CLASSES: Array<{
  name: BrowserPacingClass
  title: string
  short: string
}> = [
  {
    name: "browser_act",
    title: "Before an action in a page",
    short: "actions",
  },
  {
    name: "browser_navigate",
    title: "Before opening a page",
    short: "opening a page",
  },
]

function rangeWords(range: PaceRange): string {
  return `${range.minMs / 1000} to ${range.maxMs / 1000} s`
}

/**
 * The bounds within which an assistant may give a tab, or a browser flow,
 * a pace of its own without asking: outside them it asks you (a tab), or
 * its request says so (a flow). Your own pace for a site stays a floor.
 */
function AssistantForm({ overview }: { overview: PacingOverview }) {
  const [state, action] = useActionState(saveAssistantPaceAction, IDLE)

  return (
    <form
      action={action}
      className="flex flex-col gap-5"
      aria-label="What assistants may set"
    >
      <p className="text-xs text-muted-foreground">
        An assistant can slow a tab down or speed it up for a site that is slow
        or quick, and a browser flow can bring its own timings. Within these it
        needs no answer from you; outside them it asks. Your own pace for a site
        always stays the least it waits there.
      </p>
      {ASSISTANT_CLASSES.map((entry) => {
        const current = overview.assistant[entry.name]
        const defaults = overview.assistantDefaults[entry.name]

        return (
          <fieldset
            key={entry.name}
            className="m-0 flex flex-col gap-2 border-0 p-0"
          >
            <legend className="text-[15px] text-foreground">
              {entry.title}
            </legend>
            <p className="text-xs text-muted-foreground">
              PCP&apos;s default: {rangeWords(defaults)}. Leave both empty for
              it.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Shortest, in seconds"
                htmlFor={`assistant-${entry.name}-min`}
              >
                <Input
                  id={`assistant-${entry.name}-min`}
                  name={`${entry.name}-min`}
                  inputMode="decimal"
                  defaultValue={
                    current.own ? String(current.range.minMs / 1000) : ""
                  }
                  placeholder={String(defaults.minMs / 1000)}
                />
              </Field>
              <Field
                label="Longest, in seconds"
                htmlFor={`assistant-${entry.name}-max`}
              >
                <Input
                  id={`assistant-${entry.name}-max`}
                  name={`${entry.name}-max`}
                  inputMode="decimal"
                  defaultValue={
                    current.own ? String(current.range.maxMs / 1000) : ""
                  }
                  placeholder={String(defaults.maxMs / 1000)}
                />
              </Field>
            </div>
          </fieldset>
        )
      })}
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant="secondary" pendingText="Saving…">
          Save
        </SubmitButton>
        <Status state={state} />
      </div>
    </form>
  )
}

function ResetForm() {
  const [state, action] = useActionState(resetPacingAction, IDLE)

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <SubmitButton variant="plain" pendingText="Resetting…">
        Reset to PCP&apos;s defaults
      </SubmitButton>
      <Status state={state} />
    </form>
  )
}

/** One site's pace, or with no site the form that adds one. */
function SiteForm({ site }: { site: PacedSite | null }) {
  const [state, action] = useActionState(savePacingSiteAction, IDLE)
  const [removed, remove] = useActionState(removePacingSiteAction, IDLE)
  const label = site ? site.host : "Add a site"

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-field/40 p-3">
      <form
        action={action}
        className="flex flex-col gap-3"
        aria-label={site ? `Pacing for ${site.host}` : "Add a site to pace"}
      >
        <p className="text-[15px] text-foreground">{label}</p>
        {site ? (
          <input type="hidden" name="replacing" value={site.host} />
        ) : null}
        <Field
          label="Site"
          htmlFor={`pacing-site-${site?.host ?? "new"}`}
          hint="A host, like example.com."
        >
          <Input
            id={`pacing-site-${site?.host ?? "new"}`}
            name="site"
            defaultValue={site?.host ?? ""}
            placeholder="example.com"
            autoComplete="off"
          />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            name="subdomains"
            defaultChecked={site?.subdomains ?? true}
          />
          Also its subdomains (www.example.com for example.com)
        </label>
        <PaceFields
          pace={
            site?.pace ?? {
              minIntervalMs: 3_000,
              jitterMs: 4_000,
              burst: null,
            }
          }
          label={`Pace ${site ? site.host : "this site"}`}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton variant="secondary" size="sm" pendingText="Saving…">
            {site ? "Save" : "Add site"}
          </SubmitButton>
          <Status state={state} />
        </div>
      </form>
      {site ? (
        <form action={remove} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="site" value={site.host} />
          <SubmitButton variant="destructive" size="sm" pendingText="Removing…">
            Remove {site.host}
          </SubmitButton>
          <Status state={removed} />
        </form>
      ) : null}
    </div>
  )
}
