import {
  DDNS_CHECK_INTERVAL_MS,
  type DdnsStatus,
  ddnsHostname,
  ddnsView,
  type DdnsView,
  getDdnsConfig,
  getDdnsStatus,
  runDdnsRound,
  saveDdnsStatus,
} from "./ddns"
import { PCP_VERSION } from "../version"
import { appTarget, Edge, type EdgeStatus, httpPort, httpsPort } from "./edge"
import {
  getPcpggConfig,
  getPcpggSaved,
  type PcpggConfig,
  pcpggKeyHint,
  pcpggRelayUrl,
  savePcpggSaved,
} from "./pcpgg"
import {
  type Connector,
  type ConnectorStatus,
  type ConnectorTarget,
  startConnector,
} from "./pcpgg/connector"
import {
  clearTlsConfig,
  acmeIssuer,
  type ChallengeStore,
  getTlsConfig,
  getTlsStatus,
  type Issuer,
  runTlsRound,
  saveTlsForPcpgg,
  saveTlsStatus,
  TLS_CHECK_INTERVAL_MS,
  tlsDomain,
  tlsNotice,
  type TlsStatus,
  turnOffTlsAfterFailure,
} from "./tls"

/**
 * The background side of dynamic DNS, HTTPS and pcp.gg: timers, the edge
 * listeners, the answers to Let's Encrypt's challenges and the connection
 * to pcp.gg. One per process, kept on
 * globalThis because instrumentation.ts and the Server Actions are bundled
 * apart and would otherwise each have their own copy of this module.
 *
 * `startNetwork` runs once at boot; `reconcileNetwork` after the owner
 * changes a setting. Both read the host settings and make the process
 * match: nothing starts while all three are off.
 */

/** The connection to pcp.gg while it is on, as the connector reports it. */
type PcpggLink = {
  key: string
  connector: Connector | null
  status: ConnectorStatus
  /** Since when it has not been online, for the header's bell. */
  offlineSince: number | null
  /** What PCP does about the latest status (followPcpgg). */
  following: Promise<void>
}

type Runtime = {
  started: boolean
  /** Let's Encrypt, or a stand-in in tests. */
  issuer: Issuer
  challenges: ChallengeStore
  edge: Edge | null
  pcpgg: PcpggLink | null
  ddnsTimer: NodeJS.Timeout | null
  tlsTimer: NodeJS.Timeout | null
  /** Rounds of each kind run one at a time. */
  ddnsChain: Promise<unknown>
  tlsChain: Promise<unknown>
  configChain: Promise<unknown>
}

const RUNTIME = Symbol.for("pcp.network")

function runtime(): Runtime {
  const holder = globalThis as unknown as { [RUNTIME]?: Runtime }

  holder[RUNTIME] ??= {
    started: false,
    issuer: acmeIssuer,
    challenges: new Map(),
    edge: null,
    pcpgg: null,
    ddnsTimer: null,
    tlsTimer: null,
    ddnsChain: Promise.resolve(),
    tlsChain: Promise.resolve(),
    configChain: Promise.resolve(),
  }

  return holder[RUNTIME]
}

function chain<T>(
  key: "ddnsChain" | "tlsChain" | "configChain",
  run: () => Promise<T>,
): Promise<T> {
  const state = runtime()
  const result = state[key].then(run, run)
  state[key] = result.catch((error) =>
    console.error("[network] background work failed", error),
  )
  return result
}

/** At boot: picks up whatever the owner turned on before the restart. */
export async function startNetwork(): Promise<void> {
  const state = runtime()

  if (state.started) {
    return
  }

  state.started = true
  await reconcileNetwork().catch((error) =>
    console.error("[network] could not start", error),
  )
}

/**
 * Makes the process match the settings. `ddnsNow` sends a dynamic DNS
 * update at once and waits for it; `tlsNow` asks for a certificate without
 * waiting out an earlier failure (it runs in the background either way:
 * Let's Encrypt can take a minute).
 */
export function reconcileNetwork(
  options: { ddnsNow?: boolean; tlsNow?: boolean } = {},
): Promise<void> {
  return chain("configChain", async () => {
    const state = runtime()
    const ddns = await getDdnsConfig()

    if (ddns) {
      state.ddnsTimer ??= setInterval(
        () => void ddnsRound(false),
        DDNS_CHECK_INTERVAL_MS,
      ).unref()
    } else if (state.ddnsTimer) {
      clearInterval(state.ddnsTimer)
      state.ddnsTimer = null
    }

    const ddnsDone = ddns ? ddnsRound(!!options.ddnsNow) : Promise.resolve()

    if (options.ddnsNow) {
      await ddnsDone
    }

    const pcpgg = await getPcpggConfig()
    const pcpggSaved = await getPcpggSaved()
    await syncConnector(pcpgg && !pcpggSaved.rejected ? pcpgg : null)

    let tls = await getTlsConfig()
    let tlsNow = !!options.tlsNow

    if (tls?.via === "pcpgg" && !pcpgg) {
      // The name is no longer this PCP's to answer for (pcp.gg turned off,
      // or settings restored from another PCP).
      await clearTlsConfig()
      tls = null
    }

    const name = onlineName()

    if (pcpgg && name && tls?.domain !== name) {
      const tlsStatus = await getTlsStatus()
      // Once the first try for the name failed, the owner asks again.
      const refused = !!tlsStatus.turnedOffAt && tlsStatus.domain === name

      if (!refused) {
        tls = await saveTlsForPcpgg(name, pcpgg.agreedAt, tls?.email ?? null)
        tlsNow = true
      }
    }

    const domain = tlsDomain(tls, ddns)
    // With a pcp.gg name, only the connector reaches the listeners.
    const host = tls?.via === "pcpgg" ? "127.0.0.1" : undefined

    if (state.edge && state.edge.host !== host) {
      await state.edge.stop()
      state.edge = null
    }

    if (tls) {
      state.edge ??= new Edge({
        target: appTarget(),
        challenges: state.challenges,
        httpPort: httpPort(),
        httpsPort: httpsPort(),
        host,
      })

      if (domain) {
        await state.edge.start(domain)
      }

      state.tlsTimer ??= setInterval(
        () => void tlsRound(false),
        TLS_CHECK_INTERVAL_MS,
      ).unref()
      void tlsRound(tlsNow)
    } else {
      if (state.tlsTimer) {
        clearInterval(state.tlsTimer)
        state.tlsTimer = null
      }

      await state.edge?.stop()
      state.edge = null
    }
  })
}

/**
 * Starts the connector for `config`, replaces it when the key changed, and
 * stops it when pcp.gg is off or turned the key down.
 */
async function syncConnector(config: PcpggConfig | null): Promise<void> {
  const state = runtime()
  const current = state.pcpgg

  if (current && current.key === config?.key) {
    return
  }

  state.pcpgg = null

  if (current?.connector) {
    // The relay answers a close at once; a lost connection is not waited on.
    await Promise.race([
      current.connector.stop(),
      new Promise((resolve) => setTimeout(resolve, 2_000).unref()),
    ])
  }

  if (!config) {
    return
  }

  const link: PcpggLink = {
    key: config.key,
    connector: null,
    status: { state: "connecting", hostnames: [] },
    offlineSince: Date.now(),
    following: Promise.resolve(),
  }
  state.pcpgg = link
  link.connector = startConnector({
    key: config.key,
    relayUrl: pcpggRelayUrl(),
    https: () => edgeTarget("https"),
    http: () => edgeTarget("http"),
    client: `pcp/${PCP_VERSION}`,
    onStatus: (status) => {
      const wasOnline = link.status.state === "online"
      link.status = status

      if (status.state === "online") {
        link.offlineSince = null
      } else {
        link.offlineSince ??= Date.now()
      }

      link.following = link.following.then(() =>
        followPcpgg(link, status, wasOnline),
      )
    },
    log: (message) => console.log(`[pcp.gg] ${message}`),
  })
}

/** Where the connector sends a stream: the edge's listener, while it is open. */
function edgeTarget(port: "http" | "https"): ConnectorTarget | null {
  const bound = runtime().edge?.boundPorts()[port]
  return bound ? { host: "127.0.0.1", port: bound } : null
}

function onlineName(): string | null {
  const status = runtime().pcpgg?.status
  return status?.state === "online" ? (status.hostnames[0] ?? null) : null
}

/** Remembers the name and points HTTPS at it; stops on a refused key. */
async function followPcpgg(
  link: PcpggLink,
  status: ConnectorStatus,
  wasOnline: boolean,
): Promise<void> {
  if (runtime().pcpgg !== link) {
    return
  }

  try {
    if (status.state === "online" && !wasOnline) {
      const name = status.hostnames[0]
      const saved = await getPcpggSaved()

      if (name && saved.name !== name) {
        await savePcpggSaved({ ...saved, name })
      }

      // Points HTTPS at the name now that pcp.gg carries its challenge.
      await reconcileNetwork()
    } else if (status.state === "unauthorized") {
      await savePcpggSaved({
        ...(await getPcpggSaved()),
        rejected: status.lastError,
        rejectedAt: new Date().toISOString(),
      })
      await reconcileNetwork()
    }
  } catch (error) {
    console.error("[network] could not follow pcp.gg", error)
  }
}

/**
 * Waits until the connection to pcp.gg is online, turned down or failed, up
 * to `ms`: a save answers with how it went when it goes quickly.
 */
export async function pcpggSettled(ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms

  while (Date.now() < deadline) {
    const link = runtime().pcpgg

    if (!link || link.status.state !== "connecting") {
      break
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  await runtime().pcpgg?.following
  await runtime().configChain
}

/** Resolves once the background work started so far is done (for tests). */
export async function networkIdle(): Promise<void> {
  const state = runtime()
  await state.configChain
  await Promise.all([state.ddnsChain, state.tlsChain])
}

/** Puts a stand-in for Let's Encrypt in place (for tests). */
export function setNetworkIssuer(issuer: Issuer = acmeIssuer): void {
  runtime().issuer = issuer
}

/** The edge listeners' ports, while they are open (for tests). */
export function edgePorts(): { http?: number; https?: number } | null {
  return runtime().edge?.boundPorts() ?? null
}

function ddnsRound(force: boolean): Promise<DdnsStatus | null> {
  return chain("ddnsChain", async () => {
    const config = await getDdnsConfig()

    if (!config) {
      return null
    }

    const next = await runDdnsRound({
      config,
      status: await getDdnsStatus(),
      now: new Date(),
      force,
    })

    // Settings saved while the update was out start from a clean status.
    if (JSON.stringify(await getDdnsConfig()) === JSON.stringify(config)) {
      await saveDdnsStatus(next)
    }

    return next
  })
}

function tlsRound(force: boolean): Promise<void> {
  return chain("tlsChain", async () => {
    const state = runtime()
    const config = await getTlsConfig()

    if (!config) {
      return
    }

    const ddns = await getDdnsConfig()
    const domain = tlsDomain(config, ddns)
    const unchanged = async () =>
      JSON.stringify(await getTlsConfig()) === JSON.stringify(config)

    const { status, certificate, turnOff } = await runTlsRound({
      domain,
      config,
      status: await getTlsStatus(),
      now: new Date(),
      force,
      expectedIp: (await getDdnsStatus()).lastIp,
      challenges: state.challenges,
      issue: state.issuer,
      onIssuing: async (issuing) => {
        if (await unchanged()) await saveTlsStatus(issuing)
      },
    })

    if (!(await unchanged())) {
      return
    }

    if (turnOff) {
      await turnOffTlsAfterFailure(status)
      // Closes ports 80 and 443 and stops the timer.
      await reconcileNetwork()
      return
    }

    await saveTlsStatus(status)

    if (certificate && state.edge) {
      if (domain) await state.edge.start(domain)
      await state.edge.useCertificate(certificate)
    }
  })
}

export type PcpggState =
  "connecting" | "online" | "offline" | "rejected" | "stopped"

export type PcpggView = {
  /** The start of the key, never the key. */
  keyHint: string
  state: PcpggState
  /** The name pcp.gg routes here, as last heard. */
  name: string | null
  error: string | null
  retryAt: string | null
  /** The name's HTTPS: set once PCP serves it (or tries to). */
  https: NetworkOverview["https"]
  /** Let's Encrypt refused the first certificate for the name. */
  httpsTurnedOff: NetworkOverview["httpsTurnedOff"]
}

async function pcpggView(): Promise<Omit<
  PcpggView,
  "https" | "httpsTurnedOff"
> | null> {
  const [config, saved] = await Promise.all([getPcpggConfig(), getPcpggSaved()])

  if (!config) {
    return null
  }

  const keyHint = pcpggKeyHint(config.key)
  const name = saved.name ?? null

  if (saved.rejected) {
    return {
      keyHint,
      state: "rejected",
      name,
      error: saved.rejected,
      retryAt: null,
    }
  }

  const status = runtime().pcpgg?.status ?? {
    state: "connecting",
    hostnames: [],
  }

  return {
    keyHint,
    state: status.state === "unauthorized" ? "rejected" : status.state,
    name: status.hostnames[0] ?? name,
    error: status.lastError ?? null,
    retryAt: status.retryAt?.toISOString() ?? null,
  }
}

/** Everything the settings page shows, without any credential. */
export type NetworkOverview = {
  ddns: (DdnsView & { status: DdnsStatus }) | null
  https: {
    domain: string | null
    typedDomain: string | null
    email: string | null
    status: TlsStatus
    edge: EdgeStatus | null
    /** The name is the pcp.gg one, which the pcp.gg card looks after. */
    viaPcpgg: boolean
  } | null
  /** Why PCP turned HTTPS off after its first try, until it is on again. */
  httpsTurnedOff: { domain: string | null; error: string; at: string } | null
  ddnsName: string | null
  pcpgg: PcpggView | null
  ports: { http: number; https: number }
}

export async function networkOverview(): Promise<NetworkOverview> {
  const [ddns, ddnsStatus, tls, tlsStatus, pcpgg] = await Promise.all([
    getDdnsConfig(),
    getDdnsStatus(),
    getTlsConfig(),
    getTlsStatus(),
    pcpggView(),
  ])
  const view = ddnsView(ddns)
  const edge = runtime().edge
  const https: NetworkOverview["https"] = tls
    ? {
        domain: tlsDomain(tls, ddns),
        typedDomain: tls.domain,
        email: tls.email,
        status: tlsStatus,
        edge: edge ? structuredClone(edge.status) : null,
        viaPcpgg: tls.via === "pcpgg",
      }
    : null
  const httpsTurnedOff: NetworkOverview["httpsTurnedOff"] =
    !tls && tlsStatus.turnedOffAt && tlsStatus.lastError
      ? {
          domain: tlsStatus.domain ?? null,
          error: tlsStatus.lastError,
          at: tlsStatus.turnedOffAt,
        }
      : null

  return {
    ddns: view ? { ...view, status: ddnsStatus } : null,
    https,
    httpsTurnedOff,
    ddnsName: ddnsHostname(ddns),
    pcpgg: pcpgg
      ? {
          ...pcpgg,
          https: https?.viaPcpgg ? https : null,
          httpsTurnedOff:
            httpsTurnedOff && httpsTurnedOff.domain === pcpgg.name
              ? httpsTurnedOff
              : null,
        }
      : null,
    ports: { http: httpPort(), https: httpsPort() },
  }
}

/** Something about the network the owner should hear of on any page. */
export type NetworkNotice = { id: string; title: string; href: string }

/** How long pcp.gg may be out of reach before the bell says so. */
const PCPGG_OFFLINE_NOTICE_MS = 2 * 60_000

export async function networkNotices(): Promise<NetworkNotice[]> {
  const [tls, status, pcpgg] = await Promise.all([
    getTlsConfig(),
    getTlsStatus(),
    pcpggView(),
  ])
  const notices: NetworkNotice[] = []
  const offlineSince = runtime().pcpgg?.offlineSince

  if (pcpgg?.state === "rejected") {
    notices.push({
      id: "pcpgg",
      title: "pcp.gg did not accept PCP's connection key.",
      href: "/settings#pcpgg",
    })
  } else if (
    pcpgg &&
    pcpgg.state !== "online" &&
    offlineSince &&
    Date.now() - offlineSince > PCPGG_OFFLINE_NOTICE_MS
  ) {
    notices.push({
      id: "pcpgg",
      title: "PCP is not connected to pcp.gg. It keeps trying.",
      href: "/settings#pcpgg",
    })
  }

  const title = tlsNotice(tls, status)

  if (title) {
    notices.push({
      id: "https",
      title,
      href: tls?.via === "pcpgg" ? "/settings#pcpgg" : "/settings#https",
    })
  }

  return notices
}
