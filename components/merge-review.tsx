"use client"

import { useActionState, useState } from "react"

import { FormError } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import { List, ListSection } from "@/components/ui/list"
import {
  dismissMergeAction,
  mergeDefinitionsAction,
  type DefinitionActionResult,
} from "@/lib/actions/definitions"
import { cn } from "@/lib/utils"

export type MergeCandidate = {
  id: string
  slug: string
  name: string
  description: string
  /** Where it reads its schema from; null when it was uploaded. */
  schemaUrl: string | null
  instances: Array<{ id: string; slug: string; url: string }>
}

/**
 * The merge, as the owner decides it: which definition is kept (its
 * description and where it reads its schema from go to every server), what
 * the merged one is called, and Merge; or keep them apart, and the offer
 * goes away.
 */
export function MergeReview({
  groupKey,
  definitions,
}: {
  groupKey: string
  definitions: MergeCandidate[]
}) {
  const [state, action] = useActionState<DefinitionActionResult, FormData>(
    mergeDefinitionsAction,
    { status: "idle" },
  )
  const [keep, setKeep] = useState(definitions[0]!.id)
  const kept = definitions.find((definition) => definition.id === keep)!
  const [name, setName] = useState(kept.name)
  const others = definitions.filter((definition) => definition.id !== keep)

  return (
    <form action={action} className="flex flex-col gap-8">
      <input type="hidden" name="key" value={groupKey} />
      <input type="hidden" name="keep" value={keep} />
      {others.map((definition) => (
        <input
          key={definition.id}
          type="hidden"
          name="definition"
          value={definition.id}
        />
      ))}

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 px-1 text-[13px] font-semibold text-muted-foreground">
          Keep the definition of
        </legend>
        <List>
          {definitions.map((definition) => (
            <label
              key={definition.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 px-4 py-3 text-sm",
                definition.id === keep && "bg-row-hover",
              )}
            >
              <input
                type="radio"
                name="keepChoice"
                value={definition.id}
                checked={definition.id === keep}
                onChange={() => {
                  setKeep(definition.id)
                  setName(definition.name)
                }}
                className="mt-1 accent-primary"
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-[15px]">
                  {definition.name}{" "}
                  <code className="text-xs text-muted-foreground">
                    {definition.slug}
                  </code>
                </span>
                <span className="text-[13px] whitespace-pre-line text-muted-foreground">
                  {definition.description || "No description."}
                </span>
                <span className="text-xs text-muted-foreground">
                  Schema{" "}
                  {definition.schemaUrl ? (
                    <>
                      from{" "}
                      <code className="break-all">{definition.schemaUrl}</code>
                    </>
                  ) : (
                    "uploaded"
                  )}
                  {" · "}servers:{" "}
                  {definition.instances
                    .map((instance) => `${instance.slug} (${instance.url})`)
                    .join(", ")}
                </span>
              </span>
            </label>
          ))}
        </List>
      </fieldset>

      <ListSection title="What changes">
        <ul className="flex list-disc flex-col gap-1.5 rounded-xl bg-card py-3 pr-4 pl-8 text-sm leading-relaxed">
          {others.flatMap((definition) =>
            definition.instances.map((instance) => (
              <li key={instance.id}>
                <code>{instance.slug}</code> takes the description of{" "}
                <code>{kept.slug}</code>
                {kept.schemaUrl
                  ? ", and reads its schema from where that one does"
                  : ""}
                . Its address, secret, levels and note stay its own.
              </li>
            )),
          )}
          <li>
            {others.map((definition) => definition.slug).join(", ")}{" "}
            {others.length === 1 ? "is" : "are"} no longer a definition of its
            own; Detach on a server&apos;s page makes one again.
          </li>
        </ul>
      </ListSection>

      <Field
        label="Name of the definition"
        htmlFor="merge-name"
        hint="What the shared definition is called; each server keeps its own name."
      >
        <Input
          id="merge-name"
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
        />
      </Field>

      <div className="flex flex-col gap-3">
        <FormError error={state.status === "error" ? state.error : null} />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="plain"
            onClick={() => dismissMergeAction(groupKey)}
          >
            Keep them apart
          </Button>
          <SubmitButton pendingText="Merging…">Merge</SubmitButton>
        </div>
      </div>
    </form>
  )
}
