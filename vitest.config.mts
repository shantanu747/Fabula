import { defineConfig } from "vitest/config";
import unitConfig from "./vitest.unit.config.mts";
import dbConfig from "./vitest.db.config.mts";

export default defineConfig({
  projects: [unitConfig, dbConfig],
});
