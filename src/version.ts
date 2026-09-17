// tsup replaces this global bundle-wide with package.json's MCP version.
declare const __LUNE_MCP_VERSION__: string | undefined;

/**
 * The stamped version, or undefined when nothing stamped it. Dev runs (`tsx`,
 * vitest) never substitute the token, which leaves it an undeclared global:
 * reading it throws ReferenceError, and `catch` is the only way to ask without
 * an operator that also has to survive substitution. Same shape as
 * the Lune CLI.
 */
function stampedVersion(): string | undefined {
  try {
    return __LUNE_MCP_VERSION__;
  } catch {
    return undefined;
  }
}

/** Reported as `serverInfo.version`, in `/health`, and in the API User-Agent. */
export const MCP_VERSION = stampedVersion() ?? "0.0.0-dev";
