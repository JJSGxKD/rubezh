// Рендер звуков в WAV и замеры: pnpm fx:sound [звук…] [флаги] (T-0214, Р142).
// Серверы сам не поднимает: нужен запущенный `pnpm dev` с VITE_DEV_TOOLS=1,
// как у pnpm screens. В гейт CI не входит.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contextOptions, isLocalUrl, seedConsent } from "../screens/steps.mjs";
import { AS_USERS } from "../screens/shoot.mjs";
import { encodeWav, findMarks, measure, parseArgs } from "./sound-core.mjs";

const VIEWPORT = { width: 390, height: 844 };
const CLIENT_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 40_000;

function pageUrl(base) {
  const url = new URL(base);
  url.searchParams.set("fx", "sound");
  url.searchParams.set("dev-user", AS_USERS.owner);
  return url.toString();
}

const fmt = (value, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "−∞");

function formatRow(entry, bus, m, marks) {
  const flags = marks.map((mark) => (mark.level === "error" ? "ОШИБКА" : mark.level === "warning" ? "!" : "·")).join("");
  return [`${entry.id}-${entry.variant}`, bus, fmt(m.peakDbfs), fmt(m.rmsDbfs), fmt(m.audibleMs, 0), fmt(m.tailMs, 0), flags].join("\t");
}

/** Запуск; возвращает код выхода. */
export async function run(options, log = console.log) {
  try {
    const response = await fetch(options.base, { signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) }).catch((error) => {
      if (isLocalUrl(options.base) && String(error?.cause?.code ?? "").includes("CERT")) return { ok: true };
      throw error;
    });
    if (!response.ok) throw new Error(`статус ${response.status}`);
  } catch {
    log(`Клиент на ${options.base} не отвечает — запустите pnpm dev`);
    return 1;
  }

  let browser;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ channel: options.browser });
  } catch (error) {
    log(`браузер ${options.browser} не запустился (${error instanceof Error ? error.message.split("\n")[0] : String(error)}). Поставьте Edge или Chrome, либо смените --browser`);
    return 1;
  }

  let failed = false;
  try {
    const url = pageUrl(options.base);
    const context = await browser.newContext(contextOptions({ width: VIEWPORT.width, height: VIEWPORT.height, url }));
    await seedConsent(context);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForFunction(() => window.__fxSound !== undefined, undefined, { timeout: PAGE_TIMEOUT_MS });

    // Каталог рецептов отдаёт сама страница: второго списка в скрипте нет.
    const catalog = await page.evaluate(() => window.__fxSound.catalog);
    const byId = new Map(catalog.map((entry) => [entry.id, entry]));
    const sounds = parseArgs(["--variant", options.variant, ...options.sounds], catalog.map((entry) => entry.id)).sounds;

    const rendered = await page.evaluate(([ids, variants]) => window.__fxSound.render(ids, variants), [sounds, options.variant]);
    const dir = join(options.out, "sound");
    await mkdir(dir, { recursive: true });

    const report = [];
    const rows = [];
    for (const item of rendered) {
      const recipe = byId.get(item.id);
      const m = measure(item.samples);
      const marks = findMarks(m, recipe);
      if (marks.some((mark) => mark.level === "error")) failed = true;
      const name = `${item.id}-${item.variant}`;
      await writeFile(join(dir, `${name}.wav`), encodeWav(item.samples));
      await writeFile(join(dir, `${name}.png`), Buffer.from(item.spectrogramPng.split(",")[1], "base64"));
      report.push({ id: item.id, variant: item.variant, bus: recipe.bus, gap: recipe.gap, voices: recipe.voices, dur: recipe.dur, ...m, marks });
      rows.push(formatRow(item, recipe.bus, m, marks));
      for (const mark of marks) {
        log(`${mark.level === "error" ? "ОШИБКА" : mark.level === "warning" ? "ПРЕДУПРЕЖДЕНИЕ" : "заметка"} ${name}: ${mark.text}`);
      }
    }
    await writeFile(join(dir, "sound.json"), `${JSON.stringify(report, null, 2)}\n`);
    log(`\nзвук\tшина\tпик, dBFS\tRMS, dBFS\tдлина, мс\tхвост, мс\tпометки`);
    for (const row of rows) log(row);
    log(`\nфайлы: ${dir}`);
    await context.close();
  } catch (error) {
    failed = true;
    log(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser.close();
  }
  return failed ? 1 : 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), null);
  } catch (error) {
    console.error(`pnpm fx:sound: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exitCode = await run(options);
}
