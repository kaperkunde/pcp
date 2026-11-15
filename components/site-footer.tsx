import { OperatorCredit, SiteFooter as Footer } from "@kaperkunde/ui/footer"

import {
  LEGAL_URL,
  LICENSE_URL,
  OPERATOR_COUNTRY,
  OPERATOR_NAME,
  OPERATOR_URL,
  REPOSITORY_URL,
} from "@/lib/operator-identity"

const LINKS = [
  { href: LICENSE_URL, label: "MIT licence" },
  { href: LEGAL_URL, label: "Legal" },
  { href: REPOSITORY_URL, label: "Source" },
]

/** Attribution, the licence and the legal documents, on every page. */
export function SiteFooter() {
  return (
    <Footer
      className="mx-auto max-w-5xl"
      links={LINKS}
      credit={
        <OperatorCredit
          operator={{
            name: OPERATOR_NAME,
            url: OPERATOR_URL,
            country: OPERATOR_COUNTRY,
          }}
        />
      }
    />
  )
}
