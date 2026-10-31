import { build } from "esbuild";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Сборка sim-worker (docs/35-stage4-plan.md Р15, tasks/T-0302): один файл со
 * своей сборкой движка — `@bh/core-game` (только `game/sim`, `game/balance`,
 * `content`), BullMQ, ioredis и Zod ложатся внутрь, образу не нужны ни
 * `node_modules`, ни исходники монорепо.
 *
 * - Phaser — внешний и намеренно пустой: воркер его не импортирует, а если
 *   импорт однажды просочится, сборка не утащит в файл полтора мегабайта
 *   молча, а процесс упадёт при старте с понятным именем модуля.
 * - `msgpackr-extract` — необязательное нативное ускорение BullMQ: без него
 *   работает чистый JavaScript.
 * - Баннер даёт CommonJS-зависимостям `require` внутри ESM-файла.
 */
const root = fileURLToPath(new URL("./", import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  legalComments: "none",
  external: ["phaser", "msgpackr-extract"],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  logLevel: "info",
});

const size = statSync(new URL("./dist/main.js", import.meta.url)).size;
console.log(`dist/main.js — ${(size / 1024 / 1024).toFixed(2)} МБ`);
