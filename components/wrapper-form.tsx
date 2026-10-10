"use client"

import { useActionState } from "react"

import {
  FormFooter,
  FormSection,
  ServerFormFrame,
} from "@/components/server-form-parts"
import { Input, Select, Textarea } from "@/components/ui/input"
import { Field } from "@/components/ui/label"
import type { ServerActionResult } from "@/lib/actions/servers"
import {
  createWrapperAction,
  updateWrapperAction,
} from "@/lib/actions/wrappers"
import type { CallLevels } from "@/lib/core/wrappers/definition"
import { cn } from "@/lib/utils"

export type WrapperFormValues = {
  id?: string
  name: string
  slug?: string
  description: string
  /** Whose levels the calls inside its tools follow. */
  callLevels: CallLevels
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
  callLevels: "approved",
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
    <ServerFormFrame editing={editing} action={action}>
      {editing ? <input type="hidden" name="id" value={initial.id} /> : null}

      <FormSection>
        <div className={cn("grid gap-4", editing && "sm:grid-cols-2")}>
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
                spellCheck={false}
                className="font-mono"
              />
            </Field>
          ) : null}
        </div>
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
            rows={2}
            className="min-h-16"
          />
        </Field>
      </FormSection>

      <FormSection>
        <Field
          label="Calls inside its tools run"
          htmlFor={`${prefix}-call-levels`}
          hint="On your approval: the tools a wrapper tool lists run whatever a token's own levels for them are, so a token needs a level only for the wrapper's tool and the tools it replaces can stay hidden. At each token's own levels: the wrapper reaches no further than the token does."
        >
          <Select
            id={`${prefix}-call-levels`}
            name="callLevels"
            defaultValue={initial.callLevels}
          >
            <option value="approved">On your approval of the wrapper</option>
            <option value="token">At each token&apos;s own levels</option>
          </Select>
        </Field>
        <Field
          label="Tools and secrets"
          htmlFor={`${prefix}-definition`}
          hint="JSON, in the shape an assistant's create_wrapper takes. PCP checks every tool it names and every program when you save."
        >
          <Textarea
            id={`${prefix}-definition`}
            name="definition"
            defaultValue={initial.definition}
            className="min-h-96 font-mono text-xs leading-relaxed md:text-xs"
            spellCheck={false}
          />
        </Field>
        <DefinitionGuide secretNames={secretNames} />
      </FormSection>

      <FormFooter
        editing={editing}
        state={state}
        submitLabel="Add wrapper"
        pendingText={editing ? "Saving…" : "Adding…"}
      />
    </ServerFormFrame>
  )
}

/** What goes in the definition, field by field. */
function DefinitionGuide({ secretNames }: { secretNames: string[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-2.5 rounded-[10px] bg-field px-4 py-3.5 text-xs leading-relaxed text-muted-foreground sm:grid-cols-[6rem_1fr]">
      <dt className="font-mono text-foreground">tools</dt>
      <dd className="m-0">
        Each has a <code>name</code>, a <code>description</code>, an{" "}
        <code>inputSchema</code>, optionally an <code>outputSchema</code> (the
        shape of what the program returns, checked on every call), a{" "}
        <code>program</code> (the body of an async function: <code>args</code>{" "}
        holds its arguments, <code>await pcp.call(server, tool, args)</code>{" "}
        calls a tool), <code>calls</code> (every tool the program calls, as
        server/tool) and <code>replaces</code> (tools among calls left out of
        search).
      </dd>
      <dt className="font-mono text-foreground">secrets</dt>
      <dd className="m-0">
        Each has <code>secret</code> (its name), <code>tool</code>{" "}
        (server/tool), <code>argument</code> (a JSON Pointer such as{" "}
        <code>&quot;/api_key&quot;</code>) and optionally <code>template</code>{" "}
        (<code>&quot;Bearer {"{{secret}}"}&quot;</code>); the program writes{" "}
        <code>{'{"$secret": "<name>"}'}</code> there.
      </dd>
      <dt className="text-foreground">Your secrets</dt>
      <dd className="m-0 break-words">
        {secretNames.length > 0
          ? secretNames.map((name, index) => (
              <span key={`${index}-${name}`}>
                {index > 0 ? ", " : null}
                <code>{name}</code>
              </span>
            ))
          : "You have no secrets yet."}
      </dd>
    </dl>
  )
}
