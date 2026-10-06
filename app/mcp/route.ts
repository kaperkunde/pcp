import { createMcpHandler } from "@modelcontextprotocol/server"

import { resolveApiToken } from "@/lib/core/api-tokens"
import {
  buildGatewayServer,
  ensureCatalogue,
  loadGatewayServers,
  type GatewayScope,
} from "@/lib/core/gateway"
import { instructionMemories } from "@/lib/core/memories"
import { bearerChallenge } from "@/lib/core/oauth-server/metadata"
import {
  ACCESS_TOKEN_PREFIX,
  resolveAccessToken,
} from "@/lib/core/oauth-server/tokens"
import { checkRateLimit } from "@/lib/core/rate-limit"
import { publicUrlFor, publicUrlWithoutSession } from "@/lib/server/public-url"

/**
 * The gateway endpoint: https://<pcp>/mcp
 *
 * A stateless Streamable HTTP MCP server. Every request carries a bearer
 * token: an API token, or an access token from PCP's own authorization
 * server (lib/core/oauth-server/) for an assistant that signed in. Either
 * names the vault and unwraps its key, so this one endpoint can serve any
 * number of vaults without knowing about them in advance. Without a valid
 * token the answer is 401, whose challenge points at the resource's
 * metadata: that is how a client that signs in finds out where.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const RATE_LIMIT = { max: 240, windowMs: 60_000 }

const mcpHandler = createMcpHandler(
  async (ctx) => {
    const scope = ctx.authInfo?.extra?.scope as GatewayScope | undefined

    if (!scope) {
      throw new Error("the gateway was called without a resolved token")
    }

    const servers = await ensureCatalogue(
      scope,
      await loadGatewayServers(scope),
    )

    return buildGatewayServer(scope, servers, {
      memories: scope.keepMemories
        ? await instructionMemories(scope.ctx, scope.tokenId)
        : null,
    })
  },
  {
    legacy: "stateless",
    onerror: (error) => console.error("[mcp] request error", error),
  },
)

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id",
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers)

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function jsonRpcError(
  status: number,
  message: string,
  extra: HeadersInit = {},
) {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
    {
      status,
      headers: { "Content-Type": "application/json", ...extra },
    },
  )
}

function bearerTokenFrom(request: Request): string | null {
  const header = request.headers.get("authorization") ?? ""
  const match = header.match(/^Bearer\s+(.+)$/i)

  return match ? match[1].trim() : null
}

async function handle(request: Request): Promise<Response> {
  const token = bearerTokenFrom(request)
  const resolved = !token
    ? null
    : token.startsWith(ACCESS_TOKEN_PREFIX)
      ? await resolveAccessToken(token)
      : await resolveApiToken(token)

  if (!resolved) {
    return withCors(
      jsonRpcError(
        401,
        "This endpoint needs a PCP API token as a bearer token, or an assistant that signs in with OAuth.",
        {
          "WWW-Authenticate": bearerChallenge(
            await publicUrlWithoutSession(request),
            token !== null,
          ),
        },
      ),
    )
  }

  if (!checkRateLimit(`mcp:${resolved.tokenId}`, RATE_LIMIT)) {
    return withCors(
      jsonRpcError(429, "Too many requests; slow down.", {
        "Retry-After": "30",
      }),
    )
  }

  // The rate limit counts requests. A JSON-RPC batch is many calls in one, so
  // it would get around it: the current protocol has no batches either.
  if (request.method === "POST") {
    const start = (await request.clone().text()).trimStart().slice(0, 1)

    if (start === "[") {
      return withCors(
        jsonRpcError(
          400,
          "Send one message per request; batches are not supported.",
        ),
      )
    }
  }

  const scope: GatewayScope = {
    ...resolved,
    publicUrl: await publicUrlFor(resolved.ctx, request),
  }

  const response = await mcpHandler.fetch(request, {
    authInfo: {
      token: "",
      clientId: resolved.tokenId,
      scopes: [],
      extra: { scope },
    },
  })

  return withCors(response)
}

export { handle as GET, handle as POST, handle as DELETE }

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
