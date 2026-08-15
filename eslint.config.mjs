import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/test/**"],
    rules: {
      "no-restricted-syntax": ["error",
        { selector: "CallExpression[callee.name='__setDbForTests']",
          message: "__setDbForTests is a test-only seam." },
        { selector: "CallExpression[callee.property.name='transaction']",
          message: "neon-http throws 'No transactions support' at runtime. Express atomicity as a single statement — see src/lib/db/paragraphs.ts and docs/adr/0013." },
        { selector: "CallExpression[callee.property.name='batch']",
          message: "db.batch() works on neon-http but does not exist on node-postgres, so it cannot be covered by tests. Use a single statement." },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
  ]),
]);

export default eslintConfig;
