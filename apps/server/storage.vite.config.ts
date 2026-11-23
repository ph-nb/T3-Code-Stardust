import { defineConfig } from "vite-plus";
import config from "./vite.config.ts";

export default defineConfig({
  ...config,
  root: import.meta.dirname,
  test: {
    ...config.test,
    include: ["src/persistence/*.storage.test.ts"],
    exclude: (config.test?.exclude ?? []).filter(
      (pattern: string) => pattern !== "**/*.storage.test.ts",
    ),
  },
});
