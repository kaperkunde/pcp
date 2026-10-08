"use server"

import { revalidatePath } from "next/cache"

import { invalid } from "@/lib/core/errors"
import {
  clearDdnsConfig,
  type DdnsConfig,
  ddnsHostname,
  getDdnsConfig,
  getDdnsStatus,
  saveDdnsConfig,
} from "@/lib/core/network/ddns"
import {
  clearPcpggConfig,
  getPcpggConfig,
  savePcpggConfig,
} from "@/lib/core/network/pcpgg"
import {
  networkOverview,
  pcpggSettled,
  reconcileNetwork,
} from "@/lib/core/network/runtime"
import {
  clearTlsConfig,
  saveTlsConfig,
  tlsDomain,
} from "@/lib/core/network/tls"
import { type ActionState, field, guarded } from "@/lib/server/action-state"
import { requireContext } from "@/lib/server/session"

/**
 * Dynamic DNS, HTTPS and pcp.gg. These are settings of the machine, not of the
 * vault (lib/core/host-settings.ts), but only the signed-in owner changes
 * them.
 */

export type NetworkResult = ActionState<{ message?: string }>

function refresh() {
  revalidatePath("/settings")
  revalidatePath("/setup/network")
}

async function ddnsOutcome(config: DdnsConfig): Promise<string> {
  const status = await getDdnsStatus()
  const name = ddnsHostname(config) ?? "Your name"

  if (status.lastError) {
    return `Saved. The update did not work yet: ${status.lastError}`
  }

  return status.lastIp
    ? `${name} now points at ${status.lastIp}.`
    : `Saved. ${name} was updated.`
}

export async function saveDdnsAction(
  _previous: NetworkResult,
  formData: FormData,
): Promise<NetworkResult> {
  await requireContext()

  const result = await guarded(async () => {
    const config = await saveDdnsConfig({
      provider: field(formData, "provider"),
      subdomain: field(formData, "subdomain"),
      token: field(formData, "token"),
      server: field(formData, "server"),
      hostname: field(formData, "hostname"),
      username: field(formData, "username"),
      password: field(formData, "password"),
      apiToken: field(formData, "apiToken"),
      zone: field(formData, "zone"),
      record: field(formData, "record"),
      url: field(formData, "url"),
    })
    await reconcileNetwork({ ddnsNow: true, tlsNow: true })

    return { message: await ddnsOutcome(config) }
  })

  refresh()
  return result
}

export async function updateDdnsNowAction(): Promise<NetworkResult> {
  await requireContext()

  const result = await guarded(async () => {
    const config = await getDdnsConfig()

    if (!config) {
      return { message: "Dynamic DNS is off." }
    }

    await reconcileNetwork({ ddnsNow: true })
    return { message: await ddnsOutcome(config) }
  })

  refresh()
  return result
}

export async function disableDdnsAction(): Promise<void> {
  await requireContext()
  await clearDdnsConfig()
  await reconcileNetwork()
  refresh()
}

export async function saveHttpsAction(
  _previous: NetworkResult,
  formData: FormData,
): Promise<NetworkResult> {
  await requireContext()

  const result = await guarded(async () => {
    if (await getPcpggConfig()) {
      throw invalid(
        "PCP uses its pcp.gg name while it is connected to pcp.gg. Disconnect from pcp.gg first to use another name.",
      )
    }

    const ddns = await getDdnsConfig()
    const config = await saveTlsConfig(
      {
        domain: field(formData, "domain"),
        useDdnsName: field(formData, "useDdnsName") === "on",
        email: field(formData, "email"),
        agreed: field(formData, "agreed") === "on",
      },
      ddns,
    )
    await reconcileNetwork({ tlsNow: true })

    return {
      message: `Asking Let's Encrypt for a certificate for ${tlsDomain(config, ddns)}. This usually takes under a minute.`,
    }
  })

  refresh()
  return result
}

export async function retryHttpsAction(): Promise<NetworkResult> {
  await requireContext()

  const result = await guarded(async () => {
    await reconcileNetwork({ tlsNow: true })
    return { message: "Asking Let's Encrypt again." }
  })

  refresh()
  return result
}

export async function disableHttpsAction(): Promise<void> {
  await requireContext()
  await clearTlsConfig()
  await reconcileNetwork()
  refresh()
}

export async function savePcpggAction(
  _previous: NetworkResult,
  formData: FormData,
): Promise<NetworkResult> {
  await requireContext()

  const result = await guarded(async () => {
    await savePcpggConfig({
      key: field(formData, "key"),
      agreed: field(formData, "agreed") === "on",
    })
    await reconcileNetwork()
    await pcpggSettled()
    const { pcpgg } = await networkOverview()

    switch (pcpgg?.state) {
      case "online":
        return {
          message: `PCP is online at ${pcpgg.name}. It is getting its HTTPS certificate now; that usually takes under a minute.`,
        }
      case "rejected":
        throw invalid(pcpgg.error ?? "pcp.gg did not accept the key.")
      case "offline":
        return {
          message: `Saved. ${pcpgg.error ?? "pcp.gg did not answer."} PCP keeps trying.`,
        }
      default:
        return { message: "Saved. PCP is connecting to pcp.gg." }
    }
  })

  refresh()
  return result
}

/** After Let's Encrypt refused the first certificate for the pcp.gg name. */
export async function retryPcpggHttpsAction(): Promise<NetworkResult> {
  await requireContext()

  const result = await guarded(async () => {
    await clearTlsConfig()
    await reconcileNetwork({ tlsNow: true })
    return { message: "Asking Let's Encrypt again." }
  })

  refresh()
  return result
}

export async function disablePcpggAction(): Promise<void> {
  await requireContext()
  await clearPcpggConfig()
  // Also turns HTTPS for the pcp.gg name off.
  await reconcileNetwork()
  refresh()
}
