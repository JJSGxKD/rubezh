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
import { pathToFileURL } from "node:url";

/** Какое приложение считаем эталоном: оно уходит в закрытый тест первым. */
const APP_DIST = "apps/web-telegram/dist";
const ASSETS = join(APP_DIST, "assets");

/**
 * Движок забега и стресс-тест — отдельные двери с устойчивыми именами
 * чанков: у них свой бюджет, потому что вес Phaser живёт по своим законам.
 */
const ENGINE = /^(phaser-host|run-engine|stress-engine)-.*\.js$/;

/**
 * Звук — своя дверь: движок звука, рецепты и музыка приходят после первого
 * касания (docs/31-audio-and-haptics.md). Отдельная строка, чтобы рост
 * звука был виден сам по себе, а не съедал молча запас экранов.
 */
const AUDIO = /^(sound-director|recipes|lab-overrides|music|synth|audio-engine)-.*\.js$/;

/**
 * Интерфейс забега: HUD, пауза, выбор улучшения, характеристики. Грузится не с
 * первой загрузкой, а из лобби в простое вместе с движком: без движка забег
 * всё равно не начнётся (docs/27-design-system-and-app-shell.md §3.4). Своей
 * строкой — иначе он съел бы запас экранов меню, которые игрок открывает
 * руками.
 *
 * 12,9 — радар вверху и зелёная аптечка в отдельной таблице цветов (T-0097,
 * +0,1 КБ).
 */
// Хэш чанка — восемь знаков: `run-engine-…` сюда не попадает, у него после
// `run-` идёт имя, а не хэш.
const RUN_UI = /^(RunScreen|overlays|run)-[\w-]{8}\.js$/;

/**
 * Инструменты команды — витрина компонентов с витриной состояний виджетов
 * главной, звуковая лаборатория, лист и техническая панель разработчика. Игроку они не открываются вовсе: доступ
 * решает сервер по ролям. Своя строка, чтобы они не съедали запас экранов,
 * которые качает игрок, и чтобы бюджет игровых экранов мерил то, что к
 * игроку и едет. Стресс-тест и диагностика сюда не входят: их видят
 * тестировщики закрытого теста.
 */
const TEAM = /^(gallery|home-showcase|sound-lab|DevSheet|DevTechPanel)-.*\.js$/;
/**
 * Реклама — обёртки SDK AdsGram, AdSonar и RichAds и учёт аудитории Taddy
 * (`adapter-telegram/src/ads/`) с прослойкой `Telegram.WebApp` для чужих SDK
 * (`adapter-telegram/src/webapp-compat.ts`), наш рекламный блок, который рисует
 * объявление сети с API (`app-shell/src/ads/ad-creative.tsx`), и поток
 * межстраничной при старте забега (`app-shell/src/state/interstitial.ts`).
 * Своя дверь, как звук: грузится по дороге к рекламе и только там, где она
 * есть, а не с экраном меню, и своей строкой — чтобы рост рекламы был виден
 * сам по себе. Сами SDK сетей сюда не входят: их скрипты сеть отдаёт со
 * своих адресов.
 */
const ADS = /^(ad-shower|ad-creative|interstitial)-.*\.js$/;

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
  const isScreen = (name) =>
    isJs(name) && !firstLoad.has(name) && !ENGINE.test(name) && !AUDIO.test(name) && !TEAM.test(name) && !RUN_UI.test(name) && !ADS.test(name);

  const budgets = [
    // Пороги — с запасом около пятой части (решение владельца от
    // 18.10.2026): замер на dev × 1,2, вверх до 5 КБ у строк больше 50 КБ и
    // до 1 КБ у остальных; ниже прежнего порог не опускается. Задачи пороги
    // не двигают: строку, у которой запас упал ниже 5%, поднимает тимлид
    // отдельным PR по тому же правилу. Превышение при таком запасе значит,
    // что кто-то принёс заметный вес, — сначала разбор, потом число
    // (docs/27-design-system-and-app-shell.md §3.4).
    { name: "Оболочка, первая загрузка", limitKb: 185, matches: (name) => firstLoad.has(name) },
    { name: "CSS", limitKb: 30, matches: (name) => name.endsWith(".css") },
    {
      // Самый большой ленивый экран — единственное из экранов, что
      // проваливает гейт (T-0142): ловить надо один раздутый экран, который
      // игрок ждёт при открытии. Сумма экранов растёт с каждой фичей по
      // определению и порогом быть не может — она ниже строкой «следим».
      name: "Самый большой экран",
      limitKb: 16,
      kind: "fail",
      measure: "max",
      matches: isScreen,
    },
    {
      // Сумма ленивых экранов: только пометка «следим», гейт не
      // проваливает. Порог — по общему правилу, чтобы пометка появлялась от
      // заметного роста, а не от каждой новой фичи.
      name: "Экраны по требованию, всего",
      limitKb: 190,
      kind: "watch",
      matches: isScreen,
    },
    // Интерфейс забега — своим чанком после первой загрузки: HUD, пауза,
    // выбор улучшения, характеристики и их словарь. 19 КБ — с 24.10.2026:
    // окна-реликвии и сцена сундука (PR #452, #453) подняли замер до 15,3 КБ.
    { name: "Интерфейс забега", limitKb: 19, matches: (name) => RUN_UI.test(name) && !firstLoad.has(name) },
    { name: "Инструменты команды", limitKb: 17, matches: (name) => TEAM.test(name) && !firstLoad.has(name) },
    { name: "Движок и стенд", limitKb: 430, matches: (name) => ENGINE.test(name) },
    { name: "Звук", limitKb: 15, matches: (name) => AUDIO.test(name) && !firstLoad.has(name) },
    // Обёртки SDK сетей, наш рекламный блок и поток межстраничной — своими
    // чанками, не в первой загрузке: рекламу видят не все и не сразу.
    { name: "Реклама", limitKb: 9, matches: (name) => ADS.test(name) && !firstLoad.has(name) },
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

  const sized = files.map((name) => {
    const content = readFileSync(join(ASSETS, name));
    // Шрифтам gzip не нужен: считаются как есть.
    return { name, bytes: name.endsWith(".woff2") ? content.length : gzipSync(content).length, rawBytes: content.length };
  });
  return budgetRows(sized, budgets);
}

/**
 * Строки отчёта по размерам файлов. Чистая функция — тест без сборки
 * (`scripts/test/bundle-budget.test.ts`). Размеры в байтах: `bytes` — gzip,
 * `rawBytes` — как есть (для групп с `compressed`).
 *
 * `kind: "fail"` (по умолчанию) — превышение проваливает гейт; `"watch"` —
 * только пометка «следим»: так следят за суммой, которая растёт сама.
 * `measure: "max"` — мера группы это самый большой чанк, а не сумма.
 */
export function budgetRows(files, groups) {
  return groups.map((group) => {
    const matched = files.filter((file) => group.matches(file.name));
    const size = (file) => (group.compressed === true ? file.rawBytes : file.bytes);
    const bytes = group.measure === "max" ? Math.max(0, ...matched.map(size)) : matched.reduce((total, file) => total + size(file), 0);
    const largest = group.measure === "max" ? matched.reduce((top, file) => (top === undefined || size(file) > size(top) ? file : top), undefined) : undefined;
    const kb = bytes / 1024;
    return {
      name: group.name,
      kb,
      limitKb: group.limitKb,
      kind: group.kind ?? "fail",
      over: kb > group.limitKb,
      files: matched.map((file) => file.name),
      ...(largest === undefined ? {} : { largest: largest.name }),
    };
  });
}

/** Гейт падает от строки «fail» за порогом и от группы без файлов (сборка не та). */
export function budgetFailed(rows) {
  return rows.some((row) => row.files.length === 0 || (row.kind === "fail" && row.over));
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

  const rows = measure();
  for (const row of rows) {
    const mark = row.over ? (row.kind === "watch" ? "следим" : "ПРЕВЫШЕН") : "ок";
    console.log(
      `  ${row.name.padEnd(28)} ${row.kb.toFixed(1).padStart(7)} КБ / ${String(row.limitKb).padStart(4)} КБ  ${mark}`,
    );
    // Какой экран раздулся — в отчёте, а не в поиске по dist.
    if (row.largest !== undefined && row.over) console.log(`      самый большой: ${row.largest}`);
    if (process.argv.includes("--files")) {
      for (const file of row.files) console.log(`      ${file}`);
    }
    if (row.files.length === 0) {
      console.log(`    файлов не нашлось — сборка не та или её не делали`);
    }
  }
  failed = failed || budgetFailed(rows);

  if (failed) {
    console.error(
      "\nБюджет превышен. Это не повод подвинуть число: сначала посмотрите, чем за рост заплатили.",
    );
    process.exit(1);
  }
  console.log("\nВсё в бюджете.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
