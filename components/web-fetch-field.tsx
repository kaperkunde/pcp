import { Checkbox } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * The right to fetch web pages through the gateway's web_fetch tool, as the
 * token's site and method levels say (lib/core/web-fetch.ts).
 */
export function WebFetchField({
  id,
  defaultChecked = false,
}: {
  id: string
  defaultChecked?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="font-normal" htmlFor={id}>
        <Checkbox id={id} name="webFetch" defaultChecked={defaultChecked} />
        Let an assistant with this token fetch web pages
      </Label>
      <p className="text-xs text-muted-foreground">
        It gets a web_fetch tool that reads public web pages (as Markdown) and
        can send other requests. You decide per method and per site on the
        token&apos;s page; a site it has not reached before asks you first
        unless you allow that method everywhere. It never sends your secrets,
        and never reaches addresses on your own network.
      </p>
    </div>
  )
}
