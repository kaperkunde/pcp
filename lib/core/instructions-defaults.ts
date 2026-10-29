/**
 * PCP's suggested instructions for an assistant: what each new token gets a
 * copy of, for the owner to change as they like (lib/core/instructions.ts).
 * The gateway gives a token's copy at the start of every conversation.
 *
 * Every version stays in this list, oldest first: a token remembers the
 * version its text was copied or merged from (`api_token.instructions_base`),
 * and when a newer one ships the owner is offered a three-way merge whose
 * base is that version's text. Add a version, never change one.
 */

export type InstructionTemplate = { version: number; text: string }

export const INSTRUCTION_TEMPLATES: readonly InstructionTemplate[] = [
  {
    version: 1,
    text: [
      "- Describe a tool with describe_tool before you call it, and call it with the call_handle that describe_tool gives. Do not guess argument names.",
      "- After an action failed or is waiting for the owner, check before you try it again (check_permission, or look at what it would have changed), so nothing happens twice.",
      "- When an answer gives you a link to PCP, end your reply with it, on a line of its own.",
      "- Read a memory before you change or replace it.",
      "- If this app cannot load call_tool, run_code makes the same calls: await pcp.call(server, tool, args).",
    ].join("\n"),
  },
  {
    // search and describe take over from search_tools and describe_tool,
    // and find the owner's skills.
    version: 2,
    text: [
      "- Find tools, skills and memories with search. Describe a tool with describe before you call it, and call it with the call_handle that describe gives. Do not guess argument names.",
      "- When a skill fits the task, describe it and follow its steps: the owner approved them.",
      "- After an action failed or is waiting for the owner, check before you try it again (check_permission, or look at what it would have changed), so nothing happens twice.",
      "- When an answer gives you a link to PCP, end your reply with it, on a line of its own.",
      "- Read a memory before you change or replace it.",
      "- If this app cannot load call_tool, run_code makes the same calls: await pcp.call(server, tool, args).",
    ].join("\n"),
  },
  {
    // A link to PCP is handed over as a markdown link with a short label,
    // so an app that reads the reply aloud says the label, not the address.
    version: 3,
    text: [
      "- Find tools, skills and memories with search. Describe a tool with describe before you call it, and call it with the call_handle that describe gives. Do not guess argument names.",
      "- When a skill fits the task, describe it and follow its steps: the owner approved them.",
      "- After an action failed or is waiting for the owner, check before you try it again (check_permission, or look at what it would have changed), so nothing happens twice.",
      "- When an answer gives you a link to PCP, end your reply with it as a markdown link with a short label naming the action, on a line of its own, never the bare address.",
      "- Read a memory before you change or replace it.",
      "- If this app cannot load call_tool, run_code makes the same calls: await pcp.call(server, tool, args).",
    ].join("\n"),
  },
]

/** The suggested instructions new tokens get now. */
export function currentTemplate(): InstructionTemplate {
  return INSTRUCTION_TEMPLATES[INSTRUCTION_TEMPLATES.length - 1]!
}

/** The text of one version, or null for a version PCP does not know. */
export function templateText(version: number): string | null {
  return (
    INSTRUCTION_TEMPLATES.find((template) => template.version === version)
      ?.text ?? null
  )
}
