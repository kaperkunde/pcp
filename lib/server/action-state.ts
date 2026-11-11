import { fail, guarded as kitGuarded, ok } from "@kaperkunde/next-kit"

import { isPcpError } from "@/lib/core/errors"

/**
 * What a Server Action hands back to `useActionState`
 * (@kaperkunde/next-kit's ActionState): the initial state, a failure with a
 * message for the person, or success with whatever the form needs next (a
 * token to show once, an id to navigate to). PCP's work throws a PcpError
 * for what it refuses rather than answering a Result, so `guarded` turns
 * one into the package's failure here, at the edge.
 */
export {
  field,
  fields,
  file,
  IDLE,
  type ActionState,
} from "@kaperkunde/next-kit"

export const UNEXPECTED_ERROR =
  "Something went wrong on PCP's side. Check the server log."

/** Runs the action, turning expected failures into a message. */
export function guarded<T extends object>(run: () => Promise<T>) {
  return kitGuarded<T>(
    async () => {
      try {
        return ok(await run())
      } catch (error) {
        if (isPcpError(error)) {
          return fail(error.code, error.message)
        }

        throw error
      }
    },
    { unexpected: UNEXPECTED_ERROR },
  )
}
