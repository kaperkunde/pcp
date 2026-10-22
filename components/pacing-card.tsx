"use client"

import { Timer } from "lucide-react"
import { useActionState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { describePace, PaceFields } from "@/components/pacing-fields"
import { SettingsItem } from "@/components/settings-item"
import { SubmitButton } from "@/components/submit-button"
import { Disclosure } from "@/components/ui/disclosure"
import { Checkbox, Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import {
  type PacingResult,
  removePacingSiteAction,
  resetPacingAction,
  savePacingClassesAction,
  savePacingSiteAction,
} from "@/lib/actions/pacing"
import type { PacedSite, PacingOverview } from "@/lib/core/pacing/config"
import type { PacingClass } from "@/lib/core/pacing/limits"

const CLASSES: Array<{ name: PacingClass; title: string; about: string }> = [
  {
    name: "browser_act",
    title: "Browser actions",
    about:
      "Opening pages, clicking, typing, scrolling and downloads, per site. Reading what a tab already shows is never paced.",
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
