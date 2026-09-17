import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      MCP_ALLOWED_ORIGINS:
        '["https://claude.ai","https://chatgpt.com","http://localhost:3000"]',
      LUNE_POSTHOG_HOST: "https://analytics.example.test",
      LUNE_MCP_ANALYTICS_DAILY_CAP: "10000",
      LUNE_MCP_ANALYTICS_PER_IDENTITY_DAILY_CAP: "1000",
    },
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    // Wipe mock call history + implementations between tests so a return value
    // or call count set in one test cannot bleed into the next.
    mockReset: true,
    // Shuffle file + test order to surface ordering dependencies (the printed
    // seed reproduces a failing order).
    sequence: { shuffle: true },
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**"],
    },
  },
});
