"use client"

import { ToolTierSelect } from "@/components/tool-tier-select"
import { List, ListSection } from "@/components/ui/list"
import { setOwnToolTierAction } from "@/lib/actions/tool-tiers"
import type { OwnToolTier } from "@/lib/core/own-tool-tiers"

/**
 * PCP's own tools, one row each, with the tier each tells assistants' apps
 * (Settings → PCP's own tools). A choice is saved as soon as it is made.
 */
export function OwnToolTiers({ tools }: { tools: OwnToolTier[] }) {
  return (
    <ListSection
      title={`Tools (${tools.length})`}
      footer="A tool a token cannot use (one for memories, web fetch or code it was not given) is not offered to it, whatever its tier. The call_tool and run_code tools still run only tools of their own tier and below, whatever they tell an app."
    >
      <List as="ul">
        {tools.map((tool) => (
          <li
            key={tool.name}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-sm"
          >
            <div className="flex min-w-0 flex-col">
              <code className="text-[13px] break-all text-foreground">
                {tool.name}
              </code>
              <span className="text-xs text-muted-foreground">
                {tool.title}
              </span>
            </div>
            <ToolTierSelect
              action={setOwnToolTierAction}
              fields={{ tool: tool.name }}
              tool={tool.name}
              shown={{
                tier: tool.override ?? tool.derived,
                derived: tool.derived,
                override: tool.override,
              }}
            />
          </li>
        ))}
      </List>
    </ListSection>
  )
}
