import {
  LEGAL_URL,
  LICENSE_URL,
  OPERATOR_COUNTRY,
  OPERATOR_NAME,
  OPERATOR_URL,
  REPOSITORY_URL,
} from "@/lib/operator-identity"

const linkClassName = "transition-colors hover:text-foreground"

function ExternalLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={linkClassName}
    >
      {children}
    </a>
  )
}

/** Attribution, the licence and the legal documents, on every page. */
export function SiteFooter() {
  return (
    <footer className="mx-auto mt-auto w-full max-w-5xl px-4 sm:px-6">
      <div className="flex flex-col items-center justify-between gap-3 border-t py-5 text-xs text-muted-foreground sm:flex-row">
        <p>
          Made with care in {OPERATOR_COUNTRY} by{" "}
          <ExternalLink href={OPERATOR_URL}>{OPERATOR_NAME}</ExternalLink>
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-4">
          <ExternalLink href={LICENSE_URL}>MIT licence</ExternalLink>
          <ExternalLink href={LEGAL_URL}>Legal</ExternalLink>
          <ExternalLink href={REPOSITORY_URL}>Source</ExternalLink>
        </nav>
      </div>
    </footer>
  )
}
