// Dev-mode Turbopack compiles a route on its first request, which can take
// longer than an assertion timeout. Warm the routes the suite touches so
// the first test does not pay for that mid-flow.
const ROUTES = [
  "/",
  "/setup",
  "/login",
  "/recover",
  "/servers",
  "/servers/new",
  "/secrets",
  "/tokens",
  "/settings",
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
