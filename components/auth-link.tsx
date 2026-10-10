import Link from "next/link"

/**
 * The quiet line under a sign-in or setup form that leads somewhere else:
 * grey words, then the link in the accent colour.
 */
export function AuthLink({
  href,
  prompt,
  children,
}: {
  href: string
  /** The grey words before the link ("Forgot it?"). */
  prompt?: string
  children: React.ReactNode
}) {
  return (
    <p className="text-center text-sm text-muted-foreground">
      {prompt ? `${prompt} ` : null}
      <Link href={href} className="text-primary hover:underline">
        {children}
      </Link>
    </p>
  )
}
