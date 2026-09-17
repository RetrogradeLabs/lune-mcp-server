import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Stamp package.json into the bundle so serverInfo and /health cannot drift
// from the published npm version.
interface PackageManifest {
  version: string;
}

const pkg: PackageManifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
);

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  shims: true,
  sourcemap: true,
  // Source-level shebang in src/cli.ts is preserved.
  banner: { js: "#!/usr/bin/env node" },
  // Make the bin executable.
  outExtension: () => ({ js: ".js" }),
  define: {
    __LUNE_MCP_VERSION__: JSON.stringify(pkg.version),
  },
});
