import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Отдельный конфиг под `pnpm balance:sim` (docs/26-stage2-plan.md, WP4.6).
//
// Свод калибровки — это десятки секунд симуляции ради таблицы, которую читает
// геймдизайнер. В обычный `pnpm test` он не входит: гейт перед PR должен
// оставаться быстрым, а свойства баланса, обязательные всегда, проверяет
// balance-properties.test.ts на нескольких seed.
const repoRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/balance/**/*.ts"],
    // Прогон длинный по замыслу: таймаут по умолчанию его обрывает.
    testTimeout: 600_000,
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@bh/shared-types": `${repoRoot}packages/shared-types/src/index.ts`,
    },
  },
});
