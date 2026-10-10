import type { Metadata, Viewport } from "next"

import "./globals.css"

export const metadata: Metadata = {
  title: { default: "PCP", template: "%s · PCP" },
  description:
    "A self-hosted gateway to your MCP servers, with the secrets they need kept encrypted.",
  robots: { index: false, follow: false },
}

export const viewport: Viewport = { themeColor: "#0f1217" }

/**
 * The type is the system's own (DESIGN.md), so nothing is downloaded for
 * it. Each shell, the dashboard's and the narrow one the sign-in pages use,
 * puts the footer under its own column.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col antialiased">{children}</body>
    </html>
  )
}
