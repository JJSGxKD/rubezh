import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Один раннер на весь монорепо (docs/16-tech-stack-decisions.md §8).
const repoRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  // NestJS опирается на метаданные декораторов: без них DI в тестах бэкенда
  // не соберётся. Oxc, которым Vite 8 разбирает TypeScript, умеет их сам —
  // unplugin-swc, который закладывался под esbuild, не нужен. Для кода без
  // декораторов настройка ничего не меняет.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    environment: "node",
    include: [
      "packages/**/test/**/*.test.ts",
      "backend/**/test/**/*.test.ts",
      "scripts/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Тесты не зависят друг от друга и от порядка
    // (docs/17-testing-strategy.md §10), поэтому файлы гоняются параллельно —
    // это умолчание Vitest, и отдельной настройки оно не требует.
  },
  resolve: {
    alias: {
      "@bh/shared-types": `${repoRoot}packages/shared-types/src/index.ts`,
      // У @bh/fx настоящий dist для бэкенда; тестам сборка не нужна — они
      // читают исходники, как и у остальных пакетов.
      "@bh/fx": `${repoRoot}packages/fx/src/index.ts`,
    },
  },
});
