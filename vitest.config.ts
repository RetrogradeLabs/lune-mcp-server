import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**"],
    },
  },
});
