#!/usr/bin/env node
// Бюджет бандла (docs/27-design-system-and-app-shell.md §3.4, WP5).
//
// Проверяется после сборки: `pnpm build && pnpm budget`. Смысл не в том, чтобы
// запретить рост, а в том, чтобы он был решением, а не случайностью —
// добавленная библиотека роняет проверку, и в PR видно, чем за неё заплатили.
//
// Считается gzip: на устройство едет именно он.

import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Бюджеты в килобайтах gzip. Числа — замеренная сборка плюс запас на
 * колебания минификатора, а не желаемое: первоначальные бюджеты документа
 * (150 КБ на оболочку) исходили из оценки React в ~60 КБ gzip, а React 19
 * вместе с react-dom весит заметно больше. Расхождение вынесено в §3.4 и
 * ждёт решения команды — до него бюджет держит текущий вес, не давая ему
 * расти дальше.
 */
const BUDGETS = [
  { name: "Оболочка, первая загрузка", pattern: /^index-.*\.js$/, limitKb: 190 },
  { name: "CSS", pattern: /\.css$/, limitKb: 30 },
  { name: "Чанк движка", pattern: /^(phaser-host|run-engine)-.*\.js$/, limitKb: 380 },
];

/** Какое приложение считаем эталоном: оно уходит в закрытый тест первым. */
const APP_DIST = "apps/web-telegram/dist/assets";

function measure() {
  const files = readdirSync(APP_DIST).filter((name) => statSync(join(APP_DIST, name)).isFile());
  const rows = [];

  for (const budget of BUDGETS) {
    const matched = files.filter((name) => budget.pattern.test(name));
    const bytes = matched.reduce(
      (total, name) => total + gzipSync(readFileSync(join(APP_DIST, name))).length,
      0,
    );
    rows.push({ ...budget, files: matched, kb: bytes / 1024 });
  }
  return rows;
}

function main() {
  let failed = false;
  console.log("Бюджет бандла (gzip):\n");

  for (const row of measure()) {
    const over = row.kb > row.limitKb;
    failed = failed || over;
    const mark = over ? "ПРЕВЫШЕН" : "ок";
    console.log(
      `  ${row.name.padEnd(28)} ${row.kb.toFixed(1).padStart(7)} КБ / ${String(row.limitKb).padStart(4)} КБ  ${mark}`,
    );
    if (row.files.length === 0) {
      console.log(`    нет файлов под шаблон ${String(row.pattern)} — сборка не та или не собрана`);
      failed = true;
    }
  }

  if (failed) {
    console.error(
      "\nБюджет превышен. Это не повод подвинуть число: сначала посмотрите, чем за рост заплатили.",
    );
    process.exit(1);
  }
  console.log("\nВсё в бюджете.");
}

main();
