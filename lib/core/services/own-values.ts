import type { VaultContext } from "../context"
import {
  groupSelect,
  openRow,
  readFields,
  sealFields,
  type Opened,
  type SealedGroup,
} from "../sealed-fields"
import type { ServiceSpec } from "@/lib/generated/prisma/client"

/**
 * What the owner typed for a service, sealed (#96): its container's name,
 * where its ports are published and the values of its plain variables
 * (a VPN provider's name, a country). One JSON object under the vault's
 * key as "service_spec:<server id>:own". A row from before holds them in
 * its plain columns and nothing sealed, until the vault's rows are
 * converted (lib/core/sealing/convert.ts); every reader takes either form.
 * All of them are read inside a request that holds the key (the
 * reconcile pass opens the vault's service first), so nothing here is
 * needed without one.
 */
export type ServiceOwn = {
  containerName: string
  /** JSON, as ServicePublish (ServicePublishAsk while it is failed). */
  publish: string
  /** JSON {"NAME": "value"}. */
  values: string
  /**
   * JSON {"message": "…"} while a launch that failed is kept, marked
   * failed; "" otherwise. Never had a plain column.
   */
  failure?: string
}

export const SERVICE_OWN: SealedGroup<ServiceOwn, "sealedOwn", "serverId"> = {
  column: "sealedOwn",
  idKey: "serverId",
  aad: (id) => `service_spec:${id}:own`,
  blank: { containerName: "", publish: "{}", values: "{}", failure: "" },
  sealedOnly: ["failure"],
}

/** The columns a reader selects to read a service's own values. */
export const SERVICE_OWN_SELECT = groupSelect(SERVICE_OWN)

/** A service row with its own values opened under their own names. */
export type OpenServiceOwn<T> = Opened<T, ServiceOwn, "sealedOwn">

export function openServiceOwn<T extends { serverId: string }>(
  ctx: VaultContext,
  row: T,
): OpenServiceOwn<T> {
  return openRow(ctx.dek, SERVICE_OWN, row) as OpenServiceOwn<T>
}

/** The values of a row that selected SERVICE_OWN_SELECT. */
export function readServiceOwn(
  ctx: VaultContext,
  row: Parameters<typeof readFields<ServiceOwn, "sealedOwn", "serverId">>[2],
): ServiceOwn {
  return readFields(ctx.dek, SERVICE_OWN, row)
}

/** What a row stores for them: sealed, the plain columns blank. */
export function sealedServiceOwn(
  ctx: VaultContext,
  serverId: string,
  values: ServiceOwn,
): Pick<
  ServiceSpec,
  "sealedOwn" | "plainContainerName" | "plainPublish" | "plainValues"
> {
  return sealFields(ctx.dek, SERVICE_OWN, serverId, values) as Pick<
    ServiceSpec,
    "sealedOwn" | "plainContainerName" | "plainPublish" | "plainValues"
  >
}
