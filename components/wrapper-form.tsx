"use client"

import { useActionState } from "react"

import { FormError, FormNote } from "@/components/form-status"
import { SubmitButton } from "@/components/submit-button"
import { Card, CardContent } from "@/components/ui/card"
import { Input, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  createWrapperAction,
  updateWrapperAction,
} from "@/lib/actions/wrappers"

export type WrapperFormValues = {
  id?: string
  name: string
  slug?: string
  description: string
  /** { tools, secrets } as JSON text, other tools by server/tool. */
  definition: string
}

/** What a new wrapper's tools field starts with: one tool to copy from. */
export const EXAMPLE_DEFINITION = JSON.stringify(
  {
    tools: [
      {
        name: "open_issues",
        description:
          "The open issues of one repository, number and title only.",
        inputSchema: {
          type: "object",
          properties: { repo: { type: "string" } },
          required: ["repo"],
        },
        program:
          'const issues = await pcp.call("github", "list_issues", { owner: "me", repo: args.repo, state: "open" }, { fields: ["number", "title"] })\nreturn issues',
        calls: ["github/list_issues"],
        replaces: [],
      },
    ],
    secrets: [],
  },
  null,
  2,
)

export const EMPTY_WRAPPER: WrapperFormValues = {
  name: "",
  description: "",
  definition: EXAMPLE_DEFINITION,
}

/**
 * Add or edit a wrapper: its name and description, and its tools and
 * secrets as JSON, in the shape create_wrapper takes. Saved at once and
 * checked as an assistant's request is: every tool it names, every program.
 */
export function WrapperForm({
  initial,
  secretNames,
}: {
  initial: WrapperFormValues
  /** The secrets you hold, by name, for the secrets list. */
  secretNames: string[]
}) {
  const editing = Boolean(initial.id)
  const [state, action] = useActionState<ServerActionResult, FormData>(
    editing ? updateWrapperAction : createWrapperAction,
    { status: "idle" },
  )
  const prefix = editing ? `wrapper-${initial.id}` : "wrapper-new"

  return (
    <Card>
      <CardContent>
        <form action={action} className="flex flex-col gap-4">
          {editing ? (
            <input type="hidden" name="id" value={initial.id} />
          ) : null}

          <Field label="Name" htmlFor={`${prefix}-name`}>
            <Input
              id={`${prefix}-name`}
              name="name"
              defaultValue={initial.name}
              required
              maxLength={80}
              placeholder="GitHub, simpler"
            />
          </Field>

          {editing ? (
            <Field
              label="Short name"
              htmlFor={`${prefix}-slug`}
              hint="How an assistant refers to this wrapper in tool calls (wrapper/tool). Lowercase letters, digits and dashes."
            >
              <Input
                id={`${prefix}-slug`}
                name="slug"
                defaultValue={initial.slug}
                pattern="[a-z0-9-]+"
                maxLength={40}
              />
            </Field>
          ) : null}

          <Field
            label="Description"
            htmlFor={`${prefix}-description`}
            hint="What the wrapper is for. Assistants read it in the list of servers."
          >
            <Textarea
              id={`${prefix}-description`}
              name="description"
              defaultValue={initial.description}
              maxLength={1000}
            />
          </Field>

          <Field
            label="Tools and secrets"
            htmlFor={`${prefix}-definition`}
            hint={`JSON. Each tool has a name, a description, an inputSchema, a program (the body of an async function: args holds its arguments, await pcp.call(server, tool, args) calls a tool), calls (every tool the program calls, as server/tool) and replaces (tools among calls left out of search). Each secret has secret (its name), tool (server/tool), argument (a JSON Pointer such as "/api_key") and optionally template ("Bearer {{secret}}"); the program writes {"$secret": "<name>"} there. ${secretNames.length > 0 ? `Your secrets: ${secretNames.join(", ")}.` : "You have no secrets yet."}`}
          >
            <Textarea
              id={`${prefix}-definition`}
              name="definition"
              defaultValue={initial.definition}
              className="min-h-96 font-mono text-xs"
              spellCheck={false}
            />
          </Field>

          <FormError error={state.status === "error" ? state.error : null} />
          <FormNote message={state.status === "ok" ? state.message : null} />
          <div>
            <SubmitButton pendingText={editing ? "Saving…" : "Adding…"}>
              {editing ? "Save changes" : "Add wrapper"}
            </SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
