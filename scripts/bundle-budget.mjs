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
/**
 * Чанки, которые грузятся по требованию и в первую загрузку не входят:
 * движок забега и стенд испытаний. Всё остальное считается первой загрузкой.
 *
 * Классификация «всё, кроме ленивого», а не список ожидаемых имён: сборщик
 * вправе выделить общий модуль в отдельный чанк, и такой чанк молча выпал бы
 * из бюджета. Так уже случилось при переходе на Vite 8.
 */
const LAZY = /^(phaser-host|run-engine|bench-stand)-.*\.js$/;

const BUDGETS = [
  {
    name: "Оболочка, первая загрузка",
    matches: (name) => name.endsWith(".js") && !LAZY.test(name),
    limitKb: 190,
  },
  { name: "CSS", matches: (name) => name.endsWith(".css"), limitKb: 30 },
  {
    name: "Чанки по требованию",
    matches: (name) => LAZY.test(name),
    limitKb: 380,
  },
  {
    // woff2 уже сжат, gzip его не уменьшает — считаем как есть. Браузер
    // качает подмножество, только встретив его символы, но на русском
    // интерфейсе нужны оба: кириллица и латиница с цифрами.
    name: "Шрифты",
    matches: (name) => name.endsWith(".woff2"),
    limitKb: 120,
    compressed: true,
  },
];

/** Какое приложение считаем эталоном: оно уходит в закрытый тест первым. */
const APP_DIST = "apps/web-telegram/dist/assets";

function measure() {
  const files = readdirSync(APP_DIST).filter((name) => statSync(join(APP_DIST, name)).isFile());
  const rows = [];

  for (const budget of BUDGETS) {
    const matched = files.filter((name) => budget.matches(name));
    const bytes = matched.reduce((total, name) => {
      const content = readFileSync(join(APP_DIST, name));
      return total + (budget.compressed === true ? content.length : gzipSync(content).length);
    }, 0);
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
      console.log(`    файлов не нашлось — сборка не та или её не делали`);
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
