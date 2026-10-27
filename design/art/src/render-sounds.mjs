// Прослушка предложенных звуков: рецепты из design/art/audio/recipes-proposed.json
// рисуются синтезатором самой игры (packages/app-shell/src/audio/synth.ts) и
// сохраняются в OGG. Так файл звучит ровно как рецепт в игре, а не как
// похожая на него поделка.
//
//   pnpm dev:telegram                         # dev-сервер отдаёт synth.ts как модуль
//   node design/art/src/render-sounds.mjs     # → design/art/audio/*.ogg
//
// Рецепт проверяется той же схемой, что правки звуковой лаборатории
// (`recipeSchema` в audio/lab-overrides.ts). Нужны Playwright с Chromium и ffmpeg.

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const OUT = join(HERE, "..", "audio");
const DEV_URL = process.env.DEV_URL ?? "http://127.0.0.1:5173/";
const RATE = 44100;

/** Монофонический WAV из отсчётов −1…1. */
function wav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

async function main() {
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  const { chromium } = await import(pathToFileURL(path).href);
  const recipes = JSON.parse(readFileSync(join(OUT, "recipes-proposed.json"), "utf8"));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(DEV_URL);
  const rendered = await page.evaluate(
    async ({ recipes, root, rate }) => {
      const synth = await import(`/@fs${root}/packages/app-shell/src/audio/synth.ts`);
      const lab = await import(`/@fs${root}/packages/app-shell/src/audio/lab-overrides.ts`);
      const out = {};
      for (const [id, recipe] of Object.entries(recipes)) {
        const parsed = lab.recipeSchema.safeParse(recipe);
        if (!parsed.success) throw new Error(`${id}: рецепт не проходит схему лаборатории — ${parsed.error.message}`);
        const buffer = await synth.renderRecipe(rate, parsed.data, 0);
        out[id] = Array.from(buffer.getChannelData(0));
      }
      return out;
    },
    { recipes, root: ROOT, rate: RATE },
  );
  await browser.close();

  for (const [id, samples] of Object.entries(rendered)) {
    const peak = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
    const tmp = join(OUT, `${id}.wav`);
    writeFileSync(tmp, wav(samples, RATE));
    const ogg = join(OUT, `${id}.ogg`);
    const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", tmp, "-c:a", "libvorbis", "-q:a", "4", ogg]);
    rmSync(tmp);
    if (result.status !== 0) throw new Error(`ffmpeg: ${String(result.stderr)}`);
    console.log(`${id}: ${(samples.length / RATE).toFixed(2)} с, пик ${peak.toFixed(2)}`);
  }
}

await main();
