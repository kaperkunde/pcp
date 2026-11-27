/** The owner's page for web_search's provider (Settings → Web search). */
export const WEB_SEARCH_LABEL = "Set up web search in PCP"

export function webSearchPage(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/settings#web-search`
}
