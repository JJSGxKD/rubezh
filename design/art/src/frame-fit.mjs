/**
 * Влезает ли рисунок врага в свой кадр (design/art/backlog.md п. 4). Клетка
 * кадра — −50…50 единиц рисунка, умноженные на запас `pad` из `ENEMY_ART`;
 * что за ней, атлас срезает. На `size` 2 срез виден: копьё Чура кончалось
 * плоским торцом в золотой кайме.
 *
 * Каждый кадр шага рисуется с запасом 1,5 и мерится по альфе — с каймой ранга,
 * но без свечения Нави под ногами: оно намеренно уходит за низ и гаснет.
 *
 *   node design/art/src/frame-fit.mjs
 * печатает края рисунка и нужный запас; код выхода 1 — если какой-то рисунок
 * не влезает в свой `pad`.
 */
import { pathToFileURL } from "node:url";
import { svgFrame } from "./build.mjs";
import { ENEMY_ART } from "./creatures.mjs";
import { creaturePalette, enemyBody, enemyEye } from "./palette.mjs";

/** Запас под замер: шире любого разумного `pad`. */
const PROBE = 1.5;
/** Поле до края клетки, в единицах рисунка: сглаживание каймы. */
const MARGIN = 1;
const PHASES = [0, 0.25, 0.5, 0.75];

export async function measure(browser) {
  const items = [];
  for (const art of ENEMY_ART) {
    for (const t of PHASES) {
      const palette = creaturePalette(enemyBody(art.pattern, art.rank, 0, art.id, 2), enemyEye(0, 2));
      const svg = svgFrame(art.draw(t, palette), { rank: art.rank, radius: art.radius, style: "C", hostile: false, pad: PROBE });
      items.push({ id: art.id, src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` });
    }
  }
  const page = await browser.newPage();
  const extents = await page.evaluate(
    async ({ items, PROBE }) => {
      const N = 300;
      const out = {};
      for (const item of items) {
        const img = new Image();
        img.src = item.src;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = N;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, N, N);
        const data = ctx.getImageData(0, 0, N, N).data;
        let x0 = N, y0 = N, x1 = -1, y1 = -1;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            if (data[(y * N + x) * 4 + 3] <= 24) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
        const unit = (px) => (px / N) * 100 * PROBE - 50 * PROBE;
        const e = out[item.id] ?? { left: 0, right: 0, top: 0, bottom: 0 };
        e.left = Math.max(e.left, -unit(x0));
        e.right = Math.max(e.right, unit(x1 + 1));
        e.top = Math.max(e.top, -unit(y0));
        e.bottom = Math.max(e.bottom, unit(y1 + 1));
        out[item.id] = e;
      }
      return out;
    },
    { items, PROBE },
  );
  await page.close();
  return ENEMY_ART.map((art) => {
    const e = extents[art.id];
    const reach = Math.max(e.left, e.right, e.top, e.bottom);
    const need = Math.max(1, (reach + MARGIN) / 50);
    return { id: art.id, ...e, pad: art.pad ?? 1, need, fits: need <= (art.pad ?? 1) + 1e-9 };
  });
}

async function main() {
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  const { chromium } = await import(pathToFileURL(path).href);
  const browser = await chromium.launch();
  const rows = await measure(browser);
  await browser.close();
  for (const r of rows) {
    const edges = ["left", "right", "top", "bottom"].map((k) => `${k[0]}${r[k].toFixed(1)}`).join(" ");
    console.log(`${r.id.padEnd(20)} ${edges}  pad ${r.pad.toFixed(2)}  нужно ${r.need.toFixed(2)}${r.fits ? "" : "  — НЕ ВЛЕЗАЕТ"}`);
  }
  if (rows.some((r) => !r.fits)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
