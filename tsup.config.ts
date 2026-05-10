import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Stamp the package.json version into the bundle so `serverInfo.version`
// (returned in every MCP `initialize` response) and `/health` reflect the
// actually-published version. Same pattern as packages/cli; the previous
// hardcoded `SERVER_VERSION = "1.0.0"` silently drifted from npm.
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  shims: true,
  // Source-level shebang in src/cli.ts is preserved.
  banner: { js: "#!/usr/bin/env node" },
  // Make the bin executable.
  outExtension: () => ({ js: ".js" }),
  define: {
    __LUNE_MCP_VERSION__: JSON.stringify(pkg.version),
  },
});
