import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "packages/*/test/**/*.test.ts",
            "services/*/test/unit/**/*.test.ts",
            "apps/web/test/unit/**/*.test.ts",
          ],
          environment: "node",
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["services/*/test/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
