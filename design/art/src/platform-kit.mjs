/**
 * Набор для площадок (design/art/direction-v2.md §7.1, meta-v2.md §9):
 * значок приложения нужных размеров и превью Mini App — из тех же
 * исходников, что игра, а не руками в редакторе.
 *
 * - `icon-<N>.png` — квадрат во весь край (`app-icon-square.svg`): площадки
 *   скругляют углы сами, и скруглённый исходник в их рамке дал бы двойной
 *   угол. От 32 px и меньше — упрощённый знак вкладки (`favicon.svg`): небо
 *   и частокол там сливаются в пятно, остаётся только руна.
 * - `icon-rounded-512.png` — со своим скруглением (`app-icon.svg`): туда, где
 *   значок показывается как есть — сайт, документы, презентация.
 * - `miniapp-640x360.png` — превью Mini App, которое просит BotFather при
 *   заведении приложения; уменьшено браузером из промо 16:9, так что
 *   превью и реклама — одна картинка.
 *
 * Размер, который просит кабинет VK или MAX, сверяется в самом кабинете:
 * набор покрывает типовые квадраты от 16 до 1024.
 *
 *   node design/art/src/logo.mjs && node design/art/src/promo.mjs
 *   node design/art/src/platform-kit.mjs
 * пишет `out/platform/`.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAND = join(HERE, "../out/brand");
const PROMO = join(HERE, "../out/promo");
const OUT = join(HERE, "../out/platform");

const SQUARE_SIZES = [1024, 512, 278, 256, 192, 180, 128, 64];
const SMALL_SIZES = [32, 16];

const dataUrl = (file, type) => `data:${type};base64,${readFileSync(file).toString("base64")}`;

/** Страница с одной картинкой во весь кадр: браузер и рисует SVG, и уменьшает PNG. */
const frame = (src, w, h) =>
  `<!doctype html><html><body style="margin:0;background:transparent"><img src="${src}" style="display:block;width:${w}px;height:${h}px"></body></html>`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  const { chromium } = await import(pathToFileURL(path).href);
  const browser = await chromium.launch();

  const shoot = async (src, w, h, name) => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(frame(src, w, h));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(OUT, name), omitBackground: true });
    await page.close();
    console.log(name);
  };

  const square = dataUrl(join(BRAND, "app-icon-square.svg"), "image/svg+xml");
  for (const size of SQUARE_SIZES) await shoot(square, size, size, `icon-${String(size)}.png`);
  const small = dataUrl(join(BRAND, "favicon.svg"), "image/svg+xml");
  for (const size of SMALL_SIZES) await shoot(small, size, size, `icon-${String(size)}.png`);
  await shoot(dataUrl(join(BRAND, "app-icon.svg"), "image/svg+xml"), 512, 512, "icon-rounded-512.png");
  await shoot(dataUrl(join(PROMO, "promo-16x9.png"), "image/png"), 640, 360, "miniapp-640x360.png");

  await browser.close();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
