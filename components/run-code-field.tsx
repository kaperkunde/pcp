import { Checkbox } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * The right to run programs through the gateway's run_code tool, whose
 * calls follow the token's tool levels (lib/core/code/).
 */
export function RunCodeField({
  id,
  defaultChecked = false,
}: {
  id: string
  defaultChecked?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="font-normal" htmlFor={id}>
        <Checkbox id={id} name="runCode" defaultChecked={defaultChecked} />
        Let an assistant with this token run code that calls its tools
      </Label>
      <p className="text-xs text-muted-foreground">
        It gets a run_code tool: a short JavaScript program, run inside PCP,
        that calls this token&apos;s tools and filters or passes on what they
        answer, so large answers never have to pass through the assistant. Every
        call follows the token&apos;s levels: a tool that asks you first stops
        the program until you answer, and a blocked tool stays blocked. The
        program reaches nothing else: no network, no files, and never your
        secrets.
      </p>
    </div>
  )
}
