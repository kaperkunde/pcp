// Dev-mode Turbopack compiles a route on its first request, which can take
// longer than an assertion timeout. Warm the routes the suite touches so
// the first test does not pay for that mid-flow.
const ROUTES = [
  "/",
  "/setup",
  "/setup/restore",
  "/login",
  "/recover",
  "/home",
  "/servers",
  "/servers/new",
  "/servers/endpoints/new",
  "/servers/mail/new",
  "/secrets",
  "/tokens",
  "/settings",
  "/browser",
  // Refused without a session, but compiled.
  "/api/browser/tabs/warm/stream",
  "/api/browser/tabs/warm/input",
  "/api/health",
  "/mcp",
]

export default async function globalSetup() {
  const baseURL = process.env.PCP_URL ?? "http://localhost:3000"

  await Promise.all(
    ROUTES.map((route) =>
      fetch(`${baseURL}${route}`, { redirect: "manual" }).catch(() => {
        // Not fatal: the test pays the compile cost itself.
      }),
    ),
  )
}
