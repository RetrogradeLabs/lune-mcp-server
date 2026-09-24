import runtimeDefaults from "./runtime-defaults.json";

/**
 * The settings that point the server at Lune's services and name its public
 * identity, each with the value used when it is absent. The published stdio
 * package runs on these defaults, whatever NODE_ENV its host shell exports; only
 * the hosted `--http` server must inject each one, which
 * `assertHostedConfiguration` checks before it listens. Optional knobs (the
 * cache, analytics, the port) are read where they are used.
 */
const RUNTIME_SETTINGS = {
  LUNE_API_BASE_URL: runtimeDefaults.api_public_url,
  LUNE_AUTH_SERVER_URL: runtimeDefaults.api_public_url,
  LUNE_SITE_ORIGIN: runtimeDefaults.site_origin,
  MCP_PUBLIC_URL: runtimeDefaults.mcp_public_url,
  MCP_DOCS_URL: runtimeDefaults.docs_url,
  MCP_ALLOWED_ORIGINS: '["http://localhost:3000","http://localhost:1420"]',
  OPENAI_APPS_CHALLENGE_TOKEN: "local-development-token",
} as const;

export type RuntimeSettingName = keyof typeof RUNTIME_SETTINGS;

export function runtimeSetting(name: RuntimeSettingName): string {
  return process.env[name]?.trim() || RUNTIME_SETTINGS[name];
}

/**
 * Refuse to serve hosted production on a fallback. Called at boot rather than
 * on each read because module constants resolve at import, before the CLI has
 * parsed which transport it is starting.
 */
export function assertHostedConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;

  const missing = Object.keys(RUNTIME_SETTINGS).filter(
    (name) => !process.env[name]?.trim(),
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required production configuration: ${missing.join(", ")}`,
    );
  }
}

export function runtimeSiteUrl(path: `/${string}`): string {
  const parsed = new URL(runtimeSetting("LUNE_SITE_ORIGIN"));

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "LUNE_SITE_ORIGIN must be an HTTPS origin without credentials or a path",
    );
  }

  return new URL(path, parsed.origin).href;
}
