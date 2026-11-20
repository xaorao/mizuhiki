import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The web app's "@/..." imports (tsconfig paths), for its unit tests. A pattern, so "@mizuhiki/..." is untouched.
const webSrc = fileURLToPath(new URL("./apps/web/src/", import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          alias: [{ find: /^@\//, replacement: webSrc }],
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
