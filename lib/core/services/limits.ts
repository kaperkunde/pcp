/**
 * Bounds on a service: what its definition may hold, and how long and how
 * much PCP waits for and reads from the engine on the SSH server.
 */

/** Ports a service may publish. */
export const MAX_SERVICE_PORTS = 8
/** Environment variables a definition may name. */
export const MAX_SERVICE_ENV = 64
/** Named volumes a service may mount. */
export const MAX_SERVICE_VOLUMES = 8
/** Arguments after the image, and the length of each. */
export const MAX_SERVICE_ARGS = 32
export const MAX_SERVICE_ARG_CHARS = 1000
/** An image reference, as Docker allows it (255 for the name, plus tag or digest). */
export const MAX_IMAGE_CHARS = 400
/** An environment variable's description, and a fixed value in a definition. */
export const MAX_ENV_DESCRIPTION_CHARS = 300
export const MAX_ENV_VALUE_CHARS = 4000
/** A path in the container, or on the service's HTTP side. */
export const MAX_PATH_CHARS = 400
/** A definition as JSON. */
export const MAX_SERVICE_DEFINITION_BYTES = 64 * 1024
/** One environment variable's value, from a secret. */
export const MAX_ENV_SECRET_BYTES = 32 * 1024

/** Reading the engine's version, inspecting, starting, stopping. */
export const ENGINE_COMMAND_TIMEOUT_MS = 60_000
/** Pulling an image. */
export const ENGINE_PULL_TIMEOUT_MS = 10 * 60_000
/** What PCP reads back from one engine command. */
export const ENGINE_OUTPUT_BYTES = 256 * 1024
/** How long `stop` gives the container before the engine kills it. */
export const STOP_GRACE_SECONDS = 30

/** Log lines an assistant or the owner may ask for at once. */
export const MAX_LOG_LINES = 500
export const DEFAULT_LOG_LINES = 100
/** How far back `logs` may look, in minutes (a week). */
export const MAX_LOG_SINCE_MINUTES = 7 * 24 * 60
/** What PCP keeps of the logs it reads. */
export const MAX_LOG_BYTES = 128 * 1024

/** How long a launch, update or restart waits for the service to be healthy. */
export const HEALTH_WAIT_MS = 90_000
/** Between two health checks while waiting. */
export const HEALTH_INTERVAL_MS = 1_500
/** One health check. */
export const HEALTH_REQUEST_TIMEOUT_MS = 5_000
