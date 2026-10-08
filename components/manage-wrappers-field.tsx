import { Checkbox } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * The right to propose wrappers (create_wrapper and its kin,
 * lib/core/wrappers/): every one it proposes, and every change, is yours to
 * agree to.
 */
export function ManageWrappersField({
  id,
  defaultChecked = false,
}: {
  id: string
  defaultChecked?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="font-normal" htmlFor={id}>
        <Checkbox
          id={id}
          name="manageWrappers"
          defaultChecked={defaultChecked}
        />
        Let an assistant with this token propose wrappers
      </Label>
      <p className="text-xs text-muted-foreground">
        A wrapper is a set of tools the assistant writes over your other tools:
        short programs that make a long-winded server simpler to use, and can
        put one of your secrets where an API wants it in its arguments. You read
        every program and decide; nothing changes until you agree, and a wrapper
        never reaches a tool the calling token could not.
      </p>
    </div>
  )
}
