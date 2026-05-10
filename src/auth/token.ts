/**
 * Token extraction for both transports.
 *
 * Stdio: read `LUNE_API_KEY` from the spawning process environment. The MCP
 * client (Claude Desktop, Cursor, etc.) is responsible for setting this when
 * launching the server.
 *
 * HTTP: read `Authorization: Bearer ...` from the request headers. The header
 * may carry either an OAuth 2.1 JWT (for OAuth-connected agents) or a Personal
 * Access Token (for hosted-PAT setups).
 */

export function extractTokenStdio(): string {
  const t = process.env.LUNE_API_KEY;
  if (!t || !t.trim()) {
    throw new Error(
      "LUNE_API_KEY env var is required for stdio MCP. Get a token at " +
        "https://luneresearch.com/dashboard/credentials.",
    );
  }
  return t.trim();
}

export function extractTokenHttp(
  headers: Record<string, string | string[] | undefined>,
): string {
  // Express normalises header keys to lowercase; tolerate either form.
  const raw = headers.authorization ?? headers.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error("missing Authorization header");
  if (!value.toLowerCase().startsWith("bearer ")) {
    throw new Error("expected Bearer scheme in Authorization header");
  }
  const token = value.slice(7).trim();
  if (!token) throw new Error("empty Bearer token");
  return token;
}
