import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated SpectaQL documentation bundles (vendored/minified, not our source).
    "docs/api/**",
    "public/docs/**",
  ]),
  {
    rules: {
      // Allow deliberately-unused bindings when prefixed with `_`. Used for
      // parameters that must stay in a signature (GraphQL resolver `context`,
      // route handler `request`) but aren't needed by that particular handler.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          // `const { omitted, ...rest } = obj` is a legitimate way to drop a key.
          ignoreRestSiblings: true,
        },
      ],
    },
  },
]);

export default eslintConfig;
