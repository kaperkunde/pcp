/**
 * Where the dev server's own HTTPS listeners go during the suite
 * (PCP_HTTP_PORT and PCP_HTTPS_PORT in playwright.config.ts): above 1024, so
 * no root is needed, and away from anything a developer runs.
 */
export const E2E_EDGE_HTTP_PORT = 18080
export const E2E_EDGE_HTTPS_PORT = 18443
