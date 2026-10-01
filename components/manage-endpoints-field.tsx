import { Checkbox } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * The right to read and change the API endpoints an assistant set up
 * (get_endpoint, update_endpoint). Registering one is register_server, which
 * any token may ask for and the owner decides; this is about what happens
 * after.
 */
export function ManageEndpointsField({
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
          name="manageEndpoints"
          defaultChecked={defaultChecked}
        />
        Let an assistant with this token read and change API endpoints
      </Label>
      <p className="text-xs text-muted-foreground">
        It can read an endpoint, and edit one it proposed while that sends no
        secret and reaches public addresses only. Once it sends a secret, or you
        allow private addresses, the endpoint is yours: it can only read it and
        turn read-only on. A change it makes to its own switches the endpoint
        off until you enable it again. It can never see or change a secret.
        Leave this off unless the assistant needs it.
      </p>
    </div>
  )
}
