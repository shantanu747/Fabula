import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      "node_modules",
      "dist",
      ".next",
      ".nuxt",
      "build", 
      "public",
      "scripts",
      "src/lib/db/migrations",
      "src/test",
    ],
    coverage: {
      provider: "v8",
      include: ["src/lib/**", "src/app/api/**"],
      exclude: [
        "src/lib/db/migrations/**",
        "src/lib/story/StoryContext.tsx",
        "src/lib/providers/{anthropic,openai,openrouter}.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        "src/lib/**": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/app/api/**": { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  },
});