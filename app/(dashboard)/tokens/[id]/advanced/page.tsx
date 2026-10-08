import type { Metadata } from "next"

import { LocalDate } from "@/components/local-date"
import { PageColumn } from "@/components/page-column"
import { PageHeader } from "@/components/page-header"
import { TokenCopyAccess } from "@/components/token-detail"
import { TOKEN_OPTIONS, TokenOptionRow } from "@/components/token-options"
import { TokenSettingsForm } from "@/components/token-settings-form"
import { TokenTools } from "@/components/token-tools"
import { WebFetchCard } from "@/components/web-fetch-card"
import { Input, Select } from "@/components/ui/input"
import { List, ListRow, ListSection, RowValue } from "@/components/ui/list"
import { listApiTokens } from "@/lib/core/api-tokens"
import { listTokenToolAccess } from "@/lib/core/tool-access"
import { listFetchRules } from "@/lib/core/web-fetch"
import { requireContext } from "@/lib/server/session"

import { loadToken } from "../load-token"

export const metadata: Metadata = { title: "Advanced" }

const rowClassName =
  "flex min-h-14 flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-2.5"

/**
 * Everything an assistant's token may do, set once and looked at now and
 * then: its name and expiry, copying another token's access, every tool's
 * level with the All tokens box, web fetch methods and sites, and what it
 * may propose.
 */
export default async function TokenAdvancedPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const ctx = await requireContext()
  const { id } = await params
  const { token, kinds, browser, locked } = await loadToken(ctx, id)
  const [access, tokens, fetchRules] = await Promise.all([
    listTokenToolAccess(ctx, id),
    listApiTokens(ctx),
    token.webFetch || browser ? listFetchRules(ctx, id) : null,
  ])
  const otherTokens = tokens
    .filter((other) => other.id !== id)
    .map(({ id, name }) => ({ id, name }))

  return (
    <PageColumn width="narrow">
      <PageHeader
        back={{ href: `/tokens/${id}`, label: token.name }}
        title="Advanced"
        description={
          locked
            ? "This token is revoked; nothing about it can change."
            : "Everything this assistant may do, tool by tool. A level set here is this token's own, and wins over the one for all tokens."
        }
      />

      <ListSection
        title="Access"
        description={
          token.oauthClient
            ? `${token.oauthClient.name} stays signed in with it.`
            : "The token itself stays the same, so the assistant using it keeps working."
        }
      >
        <TokenSettingsForm
          token={token}
          shows={["name", "expires"]}
          locked={locked}
          saveLabel="Save name and expiry"
        >
          <List>
            <div className={rowClassName}>
              <label
                htmlFor="token-name"
                className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5"
              >
                <span className="text-[15px]">Name</span>
                <span className="text-xs text-muted-foreground">
                  You see it on every request it makes.
                </span>
              </label>
              <Input
                id="token-name"
                name="name"
                required
                maxLength={80}
                defaultValue={token.name}
                className="h-9 w-full sm:w-72"
              />
            </div>
            <div className={rowClassName}>
              <label
                htmlFor="token-expires"
                className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5"
              >
                <span className="text-[15px]">Expires</span>
                <span className="text-xs text-muted-foreground">
                  Now: <LocalDate value={token.expiresAt} />
                </span>
              </label>
              <Select
                id="token-expires"
                name="expiresIn"
                defaultValue="keep"
                className="h-9 w-auto"
              >
                <option value="keep">Keep as it is</option>
                <option value="never">Never</option>
                <option value="7">In 7 days</option>
                <option value="30">In 30 days</option>
                <option value="90">In 90 days</option>
                <option value="365">In a year</option>
              </Select>
            </div>
          </List>
        </TokenSettingsForm>
        <List>
          {otherTokens.length > 0 && !locked ? (
            <TokenCopyAccess tokenId={id} otherTokens={otherTokens} />
          ) : null}
          <ListRow
            title={token.oauthClient ? "Signed in from" : "API token"}
            trailing={
              <RowValue>
                {token.oauthClient ? (
                  token.oauthClient.name
                ) : (
                  <code>{token.prefix}…</code>
                )}
              </RowValue>
            }
          />
          <ListRow
            title="Created"
            trailing={
              <RowValue>
                <LocalDate value={token.createdAt} />
              </RowValue>
            }
          />
        </List>
      </ListSection>

      <TokenTools
        tokenId={id}
        access={access}
        kinds={kinds}
        locked={locked}
        advanced
      />

      {fetchRules ? (
        <WebFetchCard
          tokenId={id}
          rules={fetchRules}
          locked={locked}
          webFetch={token.webFetch}
          browser={browser}
        />
      ) : null}

      <ListSection
        title="It may propose"
        description="What it proposes waits for you: you read it whole and decide on PCP's own page."
      >
        <TokenSettingsForm
          token={token}
          shows={["manageEndpoints", "manageWrappers"]}
          locked={locked}
          saveLabel="Save"
        >
          <List>
            <TokenOptionRow
              option="manageEndpoints"
              id="token-manage"
              label="Changes to API endpoints"
              caption={TOKEN_OPTIONS.manageEndpoints.detail}
              defaultChecked={token.manageEndpoints}
            />
            <TokenOptionRow
              option="manageWrappers"
              id="token-wrappers"
              label="Wrappers"
              caption={TOKEN_OPTIONS.manageWrappers.detail}
              defaultChecked={token.manageWrappers}
            />
            <ListRow
              title="New servers and tool levels"
              description="Any token may propose a server, an API endpoint or a mail account, and which tools it may run. You review and save them yourself."
              trailing={<RowValue>Always on</RowValue>}
            />
          </List>
        </TokenSettingsForm>
      </ListSection>
    </PageColumn>
  )
}
