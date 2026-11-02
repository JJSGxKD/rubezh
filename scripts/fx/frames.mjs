// Раскадровка эффекта и замеры: pnpm fx:frames <сцена…> [флаги] (T-0213, Р142).
// Серверы сам не поднимает: нужен запущенный `pnpm dev` с VITE_DEV_TOOLS=1,
// как у pnpm screens. В гейт CI не входит (docs/17-testing-strategy.md, «Стенд эффектов»).

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { contextOptions, isLocalUrl, seedConsent } from "../screens/steps.mjs";
import { AS_USERS } from "../screens/shoot.mjs";
import { FRAME_MS, TICKS_PER_FRAME, changedShare, framePlan, meanBrightness, parseArgs, resolveScenes, summarize } from "./frames-core.mjs";

const VIEWPORT = { width: 390, height: 844 };
const SHEET_COLUMNS = 6;
const SHEET_FRAME_WIDTH = 195;
const LIVE_MS = 3_000;
const CLIENT_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const STAND_TIMEOUT_MS = 40_000;

function sceneUrl(base, scene, ground) {
  const url = new URL(base);
  url.searchParams.set("fx", scene);
  url.searchParams.set("ground", ground);
  url.searchParams.set("dev-user", AS_USERS.owner);
  return url.toString();
}

async function openStand(browser, options, scene, ground, extra = {}) {
  const url = sceneUrl(options.base, scene, ground);
  const context = await browser.newContext({ ...contextOptions({ width: VIEWPORT.width, height: VIEWPORT.height, url }), reducedMotion: "no-preference", ...extra });
  try {
    await seedConsent(context);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForFunction(() => window.__fxStand !== undefined, undefined, { timeout: STAND_TIMEOUT_MS });
    await page.evaluate(() => window.__fxStand.ready);
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Каталог сцен отдаёт сама страница стенда: второго списка в скрипте нет. */
async function readCatalog(browser, options) {
  const { context, page } = await openStand(browser, options, "dynamite", "map");
  try {
    return await page.evaluate(() => window.__fxCatalog ?? []);
  } finally {
    await context.close();
  }
}

/** PNG → RGBA и лист кадров собираются в `<canvas>` отдельной страницы: без картинных зависимостей. */
async function decodeFrames(decoder, pngs) {
  const bases = pngs.map((png) => png.toString("base64"));
  const raws = await decoder.evaluate(async (list) => {
    const out = [];
    for (const b64 of list) {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let text = "";
      for (let i = 0; i < data.length; i += 0x8000) text += String.fromCharCode(...data.subarray(i, i + 0x8000));
      out.push(btoa(text));
    }
    return out;
  }, bases);
  return raws.map((raw) => new Uint8Array(Buffer.from(raw, "base64")));
}

async function buildSheet(decoder, pngs, labels) {
  const bases = pngs.map((png) => png.toString("base64"));
  const dataUrl = await decoder.evaluate(
    async ({ list, names, columns, width }) => {
      const first = await createImageBitmap(await (await fetch(`data:image/png;base64,${list[0]}`)).blob());
      const height = Math.round((first.height * width) / first.width);
      const labelH = 18;
      const rows = Math.ceil(list.length / columns);
      const canvas = document.createElement("canvas");
      canvas.width = columns * width;
      canvas.height = rows * (height + labelH);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#222";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = "12px sans-serif";
      for (let i = 0; i < list.length; i += 1) {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${list[i]}`)).blob());
        const x = (i % columns) * width;
        const y = Math.floor(i / columns) * (height + labelH);
        ctx.drawImage(bitmap, x, y, width, height);
        ctx.fillStyle = "#fff";
        ctx.fillText(names[i], x + 4, y + height + 13);
      }
      return canvas.toDataURL("image/png");
    },
    { list: bases, names: labels, columns: SHEET_COLUMNS, width: SHEET_FRAME_WIDTH },
  );
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

async function shootScene(browser, decoder, options, scene, ground) {
  const { context, page } = await openStand(browser, options, scene, ground);
  try {
    const ticks = await page.evaluate(() => window.__fxStand.scene.ticks);
    const pngs = [];
    const objects = [];
    for (const tick of framePlan(ticks)) {
      if (tick > 0) await page.evaluate((n) => window.__fxStand.step(n), TICKS_PER_FRAME);
      pngs.push(await page.screenshot({ type: "png" }));
      objects.push((await page.evaluate(() => window.__fxStand.stats()))?.displayObjects ?? null);
    }
    const frames = await decodeFrames(decoder, pngs);
    const shares = frames.map((frame, i) => (i === 0 ? 0 : changedShare(frames[i - 1], frame)));
    const brightness = frames.map((frame) => meanBrightness(frame));
    const frameTimes = await page.evaluate((ms) => window.__fxStand.play(ms), LIVE_MS);

    const labels = pngs.map((_, i) => (i === 0 ? "старт" : `+${i * FRAME_MS} мс`));
    const sheet = await buildSheet(decoder, pngs, labels);
    const base = join(options.out, `${scene}-${ground}`);
    await writeFile(`${base}.png`, sheet);
    const metrics = { scene, ground, ...summarize({ shares, brightness, objects, frameTimes }) };
    await writeFile(`${base}.json`, `${JSON.stringify(metrics, null, 2)}\n`);
    return metrics;
  } finally {
    await context.close();
  }
}

/** Видео для человека: те же три секунды живого проигрывания на обычной земле. */
async function recordVideo(browser, options, scene) {
  const dir = join(options.out, `.video-${scene}`);
  const { context, page } = await openStand(browser, options, scene, "map", { recordVideo: { dir, size: VIEWPORT } });
  const video = page.video();
  try {
    await page.evaluate((ms) => window.__fxStand.play(ms), LIVE_MS);
  } finally {
    await context.close();
  }
  if (video !== null) await rename(await video.path(), join(options.out, `${scene}.webm`));
}

function formatRow(m) {
  const life = m.lifeMs === null ? "—" : `${m.lifeMs} мс`;
  const flashes = `${m.flashes.perSecond.toFixed(1)}/с${m.flashes.warning === null ? "" : " (!)"}`;
  const p95 = m.frameTimeP95Ms === null ? "—" : `${m.frameTimeP95Ms.toFixed(1)} мс`;
  return [m.scene, m.ground, life, `${(m.changedShare.max * 100).toFixed(1)}%`, flashes, String(m.displayObjects.max), p95].join("\t");
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
    const catalog = await readCatalog(browser, options);
    const scenes = resolveScenes(options.scenes, catalog);
    await mkdir(options.out, { recursive: true });
    const decoder = await browser.newPage();
    const rows = [];
    const warnings = [];
    for (const scene of scenes) {
      for (const ground of options.grounds) {
        try {
          const metrics = await shootScene(browser, decoder, options, scene, ground);
          rows.push(formatRow(metrics));
          if (metrics.flashes.warning !== null) warnings.push(`${scene}-${ground}: ${metrics.flashes.warning}`);
          if (metrics.lifeNote !== null) warnings.push(`${scene}-${ground}: ${metrics.lifeNote}`);
          log(`лист ${join(options.out, `${scene}-${ground}.png`)}`);
        } catch (error) {
          failed = true;
          log(`ОШИБКА ${scene}-${ground}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        }
      }
      try {
        await recordVideo(browser, options, scene);
        log(`видео ${join(options.out, `${scene}.webm`)}`);
      } catch (error) {
        failed = true;
        log(`ОШИБКА видео ${scene}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
    log(`\nсцена\tземля\tжизнь\tмакс. доля\tвспышки\tмакс. объектов\tp95 кадра`);
    for (const row of rows) log(row);
    for (const warning of warnings) log(`ПРЕДУПРЕЖДЕНИЕ ${warning}`);
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
    console.error(`pnpm fx:frames: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exitCode = await run(options);
}
