"use client"

import Link from "next/link"

import { LocalDate, RelativeDate } from "@/components/local-date"
import { PermissionDecision } from "@/components/permission-decision"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { List, ListRow } from "@/components/ui/list"
import {
  TAB_STATE_LABELS,
  tabHost,
  tabInitial,
  tabState,
} from "@/lib/browser-tabs"
import type { OverviewTab } from "@/lib/core/browser/owner"
import { cn } from "@/lib/utils"

/**
 * Every open tab in the browser, in one list, as a browser's own tab strip
 * would show them: the page's icon (or its site's first letter), title and
 * site, whose tab it is, and its state. A hand-over waiting for you is on
 * its tab, with its answers, so it is settled there; Close is on every tab.
 * Choosing a tab (`/browser?tab=<id>`) shows it live under the list.
 */
export function BrowserTabs({
  tabs,
  selected,
  running,
  disabled,
  onClose,
}: {
  tabs: OverviewTab[]
  selected: string | null
  running: boolean
  disabled: boolean
  onClose: (tab: OverviewTab) => void
}) {
  // What waits for you first, then the tabs in the order they opened.
  const ordered = [
    ...tabs.filter((tab) => tab.waiting),
    ...tabs.filter((tab) => !tab.waiting),
  ]

  return (
    <List as="ul" aria-label="Open tabs">
      {ordered.length === 0 ? (
        <ListRow
          as="li"
          title={
            <span className="text-muted-foreground">
              No tabs are open
              {running ? "." : ": the browser is not running."}
            </span>
          }
        />
      ) : (
        ordered.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            current={tab.id === selected}
            disabled={disabled}
            onClose={() => onClose(tab)}
          />
        ))
      )}
    </List>
  )
}

function TabItem({
  tab,
  current,
  disabled,
  onClose,
}: {
  tab: OverviewTab
  current: boolean
  disabled: boolean
  onClose: () => void
}) {
  const name = tab.title || tabHost(tab.url)
  const state = tabState(tab)
  const href = `/browser?tab=${encodeURIComponent(tab.id)}`

  return (
    <li
      aria-label={name}
      aria-current={current ? "true" : undefined}
      data-tab-id={tab.id}
      className={cn(
        "flex flex-col",
        current && "bg-row-hover",
        tab.waiting && "ring-1 ring-warning/25 ring-inset",
      )}
    >
      <div className="flex min-h-14 flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-2.5 text-sm">
        <TabIcon tab={tab} />
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
          <Link
            href={href}
            scroll={false}
            aria-current={current ? "page" : undefined}
            className="block truncate text-[15px] leading-snug font-medium text-foreground hover:text-primary"
          >
            {tab.title || "(no title)"}
          </Link>
          <span className="flex min-w-0 flex-col text-xs leading-relaxed text-muted-foreground">
            <code className="truncate" title={tab.url}>
              {tabHost(tab.url)}
            </code>
            <span>
              {owners(tab)} · last used <LocalDate value={tab.lastUsedAt} />
            </span>
          </span>
        </div>
        <span className="flex items-center gap-2">
          <Badge
            variant={state === "owner" ? "default" : "secondary"}
            data-testid="tab-state"
          >
            {TAB_STATE_LABELS[state]}
          </Badge>
          {current ? null : (
            <Link
              href={href}
              scroll={false}
              className="px-2 text-sm text-primary hover:text-accent-foreground"
              aria-label={`Watch ${name}`}
            >
              Watch
            </Link>
          )}
          <Button
            type="button"
            size="sm"
            variant="plain"
            disabled={disabled}
            onClick={onClose}
            aria-label={`Close ${name}`}
          >
            Close
          </Button>
        </span>
      </div>
      {tab.waiting ? (
        <div
          className="flex flex-col gap-4 border-t border-separator px-4 py-4"
          aria-label="Waiting for you"
          role="group"
        >
          <div className="flex flex-col gap-1">
            <p className="text-sm break-words">
              <span className="font-semibold text-warning">
                Waiting for you:
              </span>{" "}
              {tab.waiting.message}
            </p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {tab.waiting.tokenName} asked{" "}
              <RelativeDate value={tab.waiting.createdAt} />, in its own words.
              The tab is yours until you answer:{" "}
              {current ? (
                "do what it asks in the tab below"
              ) : (
                <Link href={href} scroll={false} className="underline">
                  open it
                </Link>
              )}
              , then say Done; Not now gives it back undone.
            </p>
          </div>
          <PermissionDecision
            key={tab.waiting.id}
            id={tab.waiting.id}
            decisions={tab.waiting.decisions}
          />
        </div>
      ) : null}
    </li>
  )
}

/** Who has the tab: who opened it, and the token it is with now. */
function owners(tab: OverviewTab): string {
  const opened = `Opened by ${tab.openedBy === "owner" ? "you" : tab.openedBy}`

  if (tab.tokenId === null) {
    return `${opened}; no assistant has it yet`
  }

  return tab.tokenName && tab.tokenName !== tab.openedBy
    ? `${opened}; now ${tab.tokenName}'s`
    : opened
}

/**
 * The page's icon, from what Chromium loaded for the page (a data:
 * address, so nothing is asked of the site), or its site's first letter.
 */
function TabIcon({ tab }: { tab: OverviewTab }) {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-muted text-sm font-semibold text-muted-foreground"
      data-testid="tab-icon"
    >
      {tab.favicon ? (
        // A data: address PCP made from the bytes Chromium loaded; there is
        // nothing for next/image to optimise.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={tab.favicon}
          alt=""
          width={16}
          height={16}
          className="size-4"
        />
      ) : (
        tabInitial(tab.url)
      )}
    </span>
  )
}
