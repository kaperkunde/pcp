/**
 * Where the dev server's own HTTPS listeners go during the suite
 * (PCP_HTTP_PORT and PCP_HTTPS_PORT in playwright.config.ts): above 1024, so
 * no root is needed, and away from anything a developer runs.
 */
export const E2E_EDGE_HTTP_PORT = 18080
export const E2E_EDGE_HTTPS_PORT = 18443

/**
 * Where the fake upstream answers as GitHub's latest release during the
 * suite (PCP_RELEASES_URL in playwright.config.ts): a fixed port, because the
 * dev server's environment is set before any spec starts the upstream.
 */
export const E2E_RELEASES_PORT = 18090
export const E2E_RELEASES_URL = `http://127.0.0.1:${E2E_RELEASES_PORT}/releases/latest`
