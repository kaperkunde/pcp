"use server"

import { revalidatePath } from "next/cache"

import {
  createSkill,
  deleteSkill,
  deleteSkillFile,
  importSkill,
  saveSkillFile,
  setTokenSkills,
  updateSkill,
} from "@/lib/core/skills"
import {
  type ActionState,
  field,
  fields,
  guarded,
} from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

export type SkillActionResult = ActionState<{ id?: string; message?: string }>

/** The tools a form lists: one server/tool per line, or between commas. */
function toolsOf(formData: FormData): string[] {
  return field(formData, "tools")
    .split(/[\s,]+/)
    .filter(Boolean)
}

function skillFields(formData: FormData) {
  return {
    name: field(formData, "name"),
    description: field(formData, "description"),
    body: field(formData, "body"),
    tools: toolsOf(formData),
  }
}

/** A skill the owner writes on the Skills page. */
export async function createSkillAction(
  _previous: SkillActionResult,
  formData: FormData,
): Promise<SkillActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const { id } = await createSkill(ctx, skillFields(formData))
    return { id }
  })

  revalidatePath("/skills")

  return result
}

/** A SKILL.md the owner pasted: its frontmatter names and describes it. */
export async function importSkillAction(
  _previous: SkillActionResult,
  formData: FormData,
): Promise<SkillActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const { id } = await importSkill(ctx, field(formData, "text"))
    return { id }
  })

  revalidatePath("/skills")

  return result
}

export async function updateSkillAction(
  _previous: SkillActionResult,
  formData: FormData,
): Promise<SkillActionResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")
  const result = await guarded(async () => {
    const { version } = await updateSkill(ctx, id, skillFields(formData))
    return { message: `Saved as version ${version}.` }
  })

  revalidatePath("/skills")
  revalidatePath(`/skills/${id}`)

  return result
}

/** A reference file added to a skill, or changed. */
export async function saveSkillFileAction(
  _previous: SkillActionResult,
  formData: FormData,
): Promise<SkillActionResult> {
  const ctx = await requireContext()
  const id = field(formData, "id")
  const result = await guarded(async () => {
    const { version } = await saveSkillFile(ctx, id, {
      path: field(formData, "path"),
      text: field(formData, "text"),
      previousPath: field(formData, "previousPath") || null,
    })
    return { message: `Saved as version ${version}.` }
  })

  revalidatePath(`/skills/${id}`)

  return result
}

export async function deleteSkillFileAction(
  id: string,
  path: string,
): Promise<SkillActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    const { version } = await deleteSkillFile(ctx, id, path)
    return { message: `Deleted. The skill is now version ${version}.` }
  })

  revalidatePath(`/skills/${id}`)

  return result
}

export async function deleteSkillAction(
  id: string,
): Promise<SkillActionResult> {
  const ctx = await requireContext()
  const result = await guarded(async () => {
    await deleteSkill(ctx, id)
    return {}
  })

  revalidatePath("/skills")

  return result
}

/** The skills one token sees: all of them, or the ones ticked. */
export async function setTokenSkillsAction(
  _previous: SkillActionResult,
  formData: FormData,
): Promise<SkillActionResult> {
  const ctx = await requireContext()
  const tokenId = field(formData, "tokenId")
  const result = await guarded(async () => {
    await setTokenSkills(ctx, tokenId, {
      all: field(formData, "skills") !== "selected",
      skillIds: fields(formData, "skillIds"),
    })
    return { message: "Saved." }
  })

  revalidatePath(`/tokens/${tokenId}`)

  return result
}
