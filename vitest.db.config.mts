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
    environment: "node",
    setupFiles: ["./src/test/setup-db.ts"],
  },
});