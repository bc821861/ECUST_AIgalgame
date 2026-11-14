import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@galgame/shared": r("./packages/shared/src/index.ts"),
      "@galgame/engine": r("./packages/engine/src/index.ts"),
      "@galgame/llm": r("./packages/llm/src/index.ts"),
      "@galgame/testkit": r("./packages/testkit/src/index.ts"),
    },
  },
  test: { include: ["packages/*/src/**/*.test.ts", "apps/server/src/**/*.test.ts"], environment: "node" },
});
