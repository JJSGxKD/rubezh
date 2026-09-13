import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Один раннер на весь монорепо (docs/16-tech-stack-decisions.md §8).
//
// Когда появятся тесты бэкенда, сюда добавляется unplugin-swc: NestJS
// опирается на emitDecoratorMetadata, которого esbuild — движок Vitest по
// умолчанию — не поддерживает, и DI в тестах просто не соберётся. Пока
// бэкенд-тестов нет, зависимость не ставим, чтобы не тащить неиспользуемое.
const repoRoot = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
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
    },
  },
});
