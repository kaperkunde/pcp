import Link from "next/link"

import { PcpMark } from "@/components/pcp-mark"

/** The narrow column the setup, sign-in and recovery pages sit in. */
export function AuthShell({
  title,
  intro,
  children,
}: {
  title: string
  intro?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 py-12 sm:px-6 sm:py-20">
      <Link href="/" className="flex items-center gap-3">
        <PcpMark />
        <span className="text-lg font-medium">PCP</span>
      </Link>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl">{title}</h1>
        {intro ? (
          <div className="text-sm text-muted-foreground">{intro}</div>
        ) : null}
      </div>
      {children}
    </main>
  )
}
