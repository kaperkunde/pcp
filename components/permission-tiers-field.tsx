import { Checkbox } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  PERMISSION_TIER_LABELS,
  PERMISSION_TIERS,
  type PermissionTier,
} from "@/lib/core/constants"

/**
 * How PCP may ask the owner about this token's calls. PCP uses the first one
 * the client says it can show; the link cannot be turned off, because it is
 * what is left when nothing else works.
 */
export function PermissionTiersField({
  idPrefix,
  checked,
}: {
  idPrefix: string
  checked: readonly PermissionTier[]
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">
        How PCP asks you about a call
      </legend>
      <p className="mb-1 text-xs text-muted-foreground">
        PCP uses the first of these the app says it can show. Turn one off if
        the app gets stuck on it.
      </p>
      {PERMISSION_TIERS.map((tier) => {
        const id = `${idPrefix}-${tier}`
        const { label, hint, issueUrl } = PERMISSION_TIER_LABELS[tier]

        return (
          <div key={tier} className="flex flex-col gap-0.5">
            <Label className="font-normal" htmlFor={id}>
              {tier === "link" ? (
                <Checkbox id={id} checked disabled readOnly />
              ) : (
                <Checkbox
                  id={id}
                  name="permissionTiers"
                  value={tier}
                  defaultChecked={checked.includes(tier)}
                />
              )}
              {label}
            </Label>
            <p className="ml-6 text-xs text-muted-foreground">
              {hint}
              {issueUrl ? (
                <>
                  {" "}
                  <a
                    className="underline"
                    href={issueUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    The issue
                  </a>
                </>
              ) : null}
            </p>
          </div>
        )
      })}
    </fieldset>
  )
}
