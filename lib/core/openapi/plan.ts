import { z } from "zod"

import { MAX_HEADER_VALUE } from "./limits"

/**
 * The call plan stored with each generated tool (mcp_tool.operation): what
 * PCP needs to turn the tool's arguments into one HTTP request, and nothing
 * else. It is validated when read back, even though PCP wrote it.
 */

export const callPlanSchema = z.object({
  v: z.literal(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().startsWith("/"),
  params: z.array(
    z.object({
      /** The key in the tool's arguments. */
      arg: z.string(),
      /** The name on the wire. */
      name: z.string(),
      in: z.enum(["path", "query", "header"]),
      required: z.boolean(),
      style: z.enum([
        "simple",
        "form",
        "spaceDelimited",
        "pipeDelimited",
        "deepObject",
      ]),
      explode: z.boolean(),
      /** Declared with `content` as JSON: the value is sent as JSON text. */
      serialize: z.literal("json").optional(),
      /**
       * The one value the schema allows, which PCP sends itself: the
       * parameter is not one of the tool's arguments.
       */
      value: z.string().max(MAX_HEADER_VALUE).optional(),
    }),
  ),
  body: z
    .object({
      arg: z.string(),
      contentType: z.string(),
      encoding: z.enum(["json", "form", "text"]),
      required: z.boolean(),
    })
    .nullable(),
  accept: z.string(),
})

export type CallPlan = z.infer<typeof callPlanSchema>
export type ParamPlan = CallPlan["params"][number]
export type BodyPlan = NonNullable<CallPlan["body"]>

export function readCallPlan(json: string | null): CallPlan | null {
  if (!json) {
    return null
  }

  try {
    const parsed = callPlanSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
