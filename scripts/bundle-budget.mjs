#!/usr/bin/env node
// Бюджет бандла (docs/27-design-system-and-app-shell.md §3.4, WP5).
//
// Проверяется после сборки: `pnpm build && pnpm budget`. Смысл не в том, чтобы
// запретить рост, а в том, чтобы он был решением, а не случайностью —
// добавленная библиотека роняет проверку, и в PR видно, чем за неё заплатили.
//
// JS и CSS считаются в gzip — на устройство едет именно он; шрифты — как есть.

import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Какое приложение считаем эталоном: оно уходит в закрытый тест первым. */
const APP_DIST = "apps/web-telegram/dist";
const ASSETS = join(APP_DIST, "assets");

/**
 * Движок забега и стенд испытаний — отдельные двери с устойчивыми именами
 * чанков: у них свой бюджет, потому что вес Phaser живёт по своим законам.
 */
const ENGINE = /^(phaser-host|run-engine|bench-stand|stress-engine)-.*\.js$/;

/**
 * Звук — своя дверь: движок звука, рецепты и музыка приходят после первого
 * касания (docs/31-audio-and-haptics.md). Отдельная строка, чтобы рост
 * звука был виден сам по себе, а не съедал молча запас экранов.
 */
const AUDIO = /^(sound-director|recipes|lab-overrides|music|synth|audio-engine)-.*\.js$/;

/**
 * Первая загрузка — то, что браузер качает до интерактивной главной: скрипт
 * и `modulepreload` из index.html и всё, что они статически импортируют.
 *
 * Считается по ссылкам, а не по именам файлов: сборщик вправе выделить общий
 * модуль в чанк с любым именем, и такой чанк молча выпал бы из бюджета — так
 * уже случилось при переходе на Vite 8. Всё прочее — экраны по требованию.
 */
function firstLoadChunks(files) {
  const html = readFileSync(join(APP_DIST, "index.html"), "utf8");
  const queue = [...html.matchAll(/(?:src|href)="\.\/assets\/([^"]+\.js)"/g)].map((match) => match[1]);
  const seen = new Set();

  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name) || !files.includes(name)) continue;
    seen.add(name);

    // Статические импорты: `import … from "./x.js"` и `import "./x.js"`.
    // Динамический `import("./x.js")` сюда не попадает — после `import` у него
    // скобка.
    const code = readFileSync(join(ASSETS, name), "utf8");
    for (const match of code.matchAll(/\bimport\s*(?:[^"'()]*?\bfrom\s*)?["']\.\/([^"']+\.js)["']/g)) {
      queue.push(match[1]);
    }
  }
  return seen;
}

function measure() {
  const files = readdirSync(ASSETS).filter((name) => statSync(join(ASSETS, name)).isFile());
  const firstLoad = firstLoadChunks(files);
  const isJs = (name) => name.endsWith(".js");

  const budgets = [
    { name: "Оболочка, первая загрузка", limitKb: 150, matches: (name) => firstLoad.has(name) },
    { name: "CSS", limitKb: 30, matches: (name) => name.endsWith(".css") },
    {
      name: "Экраны по требованию",
      limitKb: 60,
      matches: (name) => isJs(name) && !firstLoad.has(name) && !ENGINE.test(name) && !AUDIO.test(name),
    },
    { name: "Движок и стенд", limitKb: 380, matches: (name) => ENGINE.test(name) },
    { name: "Звук", limitKb: 15, matches: (name) => AUDIO.test(name) && !firstLoad.has(name) },
    {
      // woff2 уже сжат, gzip его не уменьшает. Браузер качает подмножество,
      // только встретив его символы, но русскому интерфейсу нужны оба:
      // кириллица и латиница с цифрами.
      name: "Шрифты",
      limitKb: 120,
      matches: (name) => name.endsWith(".woff2"),
      compressed: true,
    },
  ];

  return budgets.map((budget) => {
    const matched = files.filter((name) => budget.matches(name));
    const bytes = matched.reduce((total, name) => {
      const content = readFileSync(join(ASSETS, name));
      return total + (budget.compressed === true ? content.length : gzipSync(content).length);
    }, 0);
    return { ...budget, files: matched, kb: bytes / 1024 };
  });
}

/**
 * Сборка для игрока обязана быть production. Отладочный JSX (`jsxDEV`)
 * появляется, только если собрали development, — как это и случилось, когда
 * Vite взял `NODE_ENV` из общего `.env` (scripts/vite/production-node-env.ts).
 * Такой бандл вдвое тяжелее, и бюджет мерил бы не то, что получит игрок.
 */
function findDevelopmentBuild() {
  const files = readdirSync(ASSETS).filter((name) => name.endsWith(".js"));
  return files.filter((name) => readFileSync(join(ASSETS, name), "utf8").includes("jsxDEV"));
}

/**
 * Чанк движка в первой загрузке — не рост, а сломанная раскладка: вместе с ним
 * игрок качает Phaser до главной. Так уже было, когда сборщик слил общие
 * runtime-хелперы в чанк движка (scripts/vite/chunking.ts), и одно число
 * «452 КБ» не говорило, что именно случилось.
 */
function findEngineInFirstLoad() {
  const files = readdirSync(ASSETS).filter((name) => statSync(join(ASSETS, name)).isFile());
  return [...firstLoadChunks(files)].filter((name) => ENGINE.test(name));
}

function main() {
  let failed = false;
  console.log("Бюджет бандла:\n");

  const engineInFirstLoad = findEngineInFirstLoad();
  if (engineInFirstLoad.length > 0) {
    console.error(
      `  Движок попал в первую загрузку: ${engineInFirstLoad.join(", ")}.\n` +
        "  Какой-то чанк первой загрузки импортирует его статически — проверьте\n" +
        "  раскладку чанков (scripts/vite/chunking.ts) и импорты из core-game.\n",
    );
    failed = true;
  }

  const development = findDevelopmentBuild();
  if (development.length > 0) {
    console.error(
      `  Сборка development, а не production: отладочный JSX в ${development.join(", ")}.\n` +
        "  Проверьте NODE_ENV в окружении и scripts/vite/production-node-env.ts.\n",
    );
    failed = true;
  }

  for (const row of measure()) {
    const over = row.kb > row.limitKb;
    failed = failed || over;
    const mark = over ? "ПРЕВЫШЕН" : "ок";
    console.log(
      `  ${row.name.padEnd(28)} ${row.kb.toFixed(1).padStart(7)} КБ / ${String(row.limitKb).padStart(4)} КБ  ${mark}`,
    );
    if (process.argv.includes("--files")) {
      for (const file of row.files) console.log(`      ${file}`);
    }
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
