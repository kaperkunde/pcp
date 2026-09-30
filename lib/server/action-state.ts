import { isPcpError } from "@/lib/core/errors"

/**
 * What a Server Action hands back to `useActionState`: the initial state,
 * a failure with a message for the person, or success with whatever the
 * form needs next (a token to show once, an id to navigate to).
 */
export type ActionState<T extends object = Record<never, never>> =
  | { status: "idle" }
  | { status: "error"; error: string }
  | ({ status: "ok" } & T)

export const IDLE: ActionState<never> = { status: "idle" }

export const UNEXPECTED_ERROR =
  "Something went wrong on PCP's side. Check the server log."

/** Runs the action, turning expected failures into a message. */
export async function guarded<T extends object>(
  run: () => Promise<T>,
): Promise<ActionState<T>> {
  try {
    return { status: "ok", ...(await run()) }
  } catch (error) {
    if (isPcpError(error)) {
      return { status: "error", error: error.message }
    }

    console.error("[action] failed", error)

    return { status: "error", error: UNEXPECTED_ERROR }
  }
}

export function field(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === "string" ? value : ""
}

export function fields(formData: FormData, name: string): string[] {
  return formData
    .getAll(name)
    .filter((value): value is string => typeof value === "string")
}
