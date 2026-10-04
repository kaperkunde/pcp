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
import { appTarget, Edge, type EdgeStatus, httpPort, httpsPort } from "./edge"
import {
  acmeIssuer,
  type ChallengeStore,
  getTlsConfig,
  getTlsStatus,
  type Issuer,
  runTlsRound,
  saveTlsStatus,
  TLS_CHECK_INTERVAL_MS,
  tlsDomain,
  type TlsStatus,
} from "./tls"

/**
 * The background side of dynamic DNS and HTTPS: timers, the edge listeners
 * and the answers to Let's Encrypt's challenges. One per process, kept on
 * globalThis because instrumentation.ts and the Server Actions are bundled
 * apart and would otherwise each have their own copy of this module.
 *
 * `startNetwork` runs once at boot; `reconcileNetwork` after the owner
 * changes a setting. Both read the host settings and make the process
 * match: nothing starts while both features are off.
 */

type Runtime = {
  started: boolean
  /** Let's Encrypt, or a stand-in in tests. */
  issuer: Issuer
  challenges: ChallengeStore
  edge: Edge | null
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

    const tls = await getTlsConfig()
    const domain = tlsDomain(tls, ddns)

    if (tls) {
      state.edge ??= new Edge({
        target: appTarget(),
        challenges: state.challenges,
        httpPort: httpPort(),
        httpsPort: httpsPort(),
      })

      if (domain) {
        await state.edge.start(domain)
      }

      state.tlsTimer ??= setInterval(
        () => void tlsRound(false),
        TLS_CHECK_INTERVAL_MS,
      ).unref()
      void tlsRound(!!options.tlsNow)
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

    const { status, certificate } = await runTlsRound({
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

    await saveTlsStatus(status)

    if (certificate && state.edge) {
      if (domain) await state.edge.start(domain)
      await state.edge.useCertificate(certificate)
    }
  })
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
  } | null
  ddnsName: string | null
  ports: { http: number; https: number }
}

export async function networkOverview(): Promise<NetworkOverview> {
  const [ddns, ddnsStatus, tls, tlsStatus] = await Promise.all([
    getDdnsConfig(),
    getDdnsStatus(),
    getTlsConfig(),
    getTlsStatus(),
  ])
  const view = ddnsView(ddns)
  const edge = runtime().edge

  return {
    ddns: view ? { ...view, status: ddnsStatus } : null,
    https: tls
      ? {
          domain: tlsDomain(tls, ddns),
          typedDomain: tls.domain,
          email: tls.email,
          status: tlsStatus,
          edge: edge ? structuredClone(edge.status) : null,
        }
      : null,
    ddnsName: ddnsHostname(ddns),
    ports: { http: httpPort(), https: httpsPort() },
  }
}
