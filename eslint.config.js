import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "contracts/**",
      "packages/chain/src/abi.ts",
      "packages/chain/src/bytecode.ts",
      "**/*.config.*",
      "tools/**",
      "**/tools/*.mjs",
      "**/playwright-report/**",
      "**/test-results/**",
      "apps/web/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true, allowNullish: false },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-unnecessary-condition": ["error", { allowConstantLoopConditions: true }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[optional=true] AwaitExpression",
          message:
            "An optional call skips evaluating its arguments when the callee is missing; do the awaited work first, then report it.",
        },
      ],
    },
  },
  {
    // Plain browser scripts served as-is (no build step, not in any tsconfig): lint as JavaScript.
    files: ["apps/web/public/**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { sourceType: "script", globals: { ...globals.browser } },
  },
  {
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
  {
    files: ["**/test/**", "tests/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
