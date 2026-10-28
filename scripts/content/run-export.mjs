#!/usr/bin/env node
/**
 * Запуск выгрузки снимка контента: `pnpm content:export [--out <каталог>]`.
 * Логика — в `export-snapshot.ts`; исходники движка и скрипта — TypeScript,
 * их грузит `runnerImport` Vite, как в `scripts/replay.mjs`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { runnerImport } = await import("vite");
const { module } = await runnerImport(join(repoRoot, "scripts", "content", "export-snapshot.ts"), {
  configFile: false,
  root: repoRoot,
  logLevel: "silent",
});
process.exitCode = module.main(process.argv.slice(2));
