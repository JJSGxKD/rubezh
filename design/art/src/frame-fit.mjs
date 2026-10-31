/**
 * Влезает ли рисунок врага и облика героя в свой кадр (design/art/backlog.md
 * п. 4 и п. 7). Клетка кадра — −50…50 единиц рисунка, умноженные на запас
 * `pad` из `ENEMY_ART` или `HERO_SKINS`; что за ней, атлас срезает. На `size` 2 срез виден: копьё Чура кончалось
 * плоским торцом в золотой кайме.
 *
 * Каждый кадр шага рисуется с запасом 1,5 и мерится по альфе — с каймой ранга,
 * но без свечения Нави под ногами: оно намеренно уходит за низ и гаснет.
 *
 *   node design/art/src/frame-fit.mjs
 * печатает края рисунка и нужный запас, затем сверяет собранные атласы: кадр
 * врага или облика, обрезанный вплотную к краю слева, сверху или справа, —
 * срезанный рисунок (снизу край задевает свечение Нави, оно гаснет само).
 * Код выхода 1 — если рисунок не влезает в свой `pad` или кадр атласа
 * касается края.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { svgFrame } from "./build.mjs";
import { ENEMY_ART } from "./creatures.mjs";
import { HERO_SKINS, HERO_STATES, HERO_VIEWS, heroDefs, withHeroPalette } from "./hero.mjs";
import { creaturePalette, enemyBody, enemyEye } from "./palette.mjs";

/** Запас под замер: шире любого разумного `pad`. */
const PROBE = 1.5;
/**
 * Поле до края клетки — в пикселях атласа: сглаживание каймы и пиксель поля,
 * который оставляет обрезка. В единицах рисунка оно у мелкого врага больше:
 * на единицу у крысы приходится 0,6 пикселя, у героя — 1,3.
 */
const MARGIN_PX = 2;
const PPU = 2.5;
const pxPerUnit = (radius, k) => (radius * 2 * k * PPU) / 100;
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
  // Облики героя: голова и предмет архетипа — на общей позе, кадры покоя и
  // шага сбоку, спереди и спиной (у вида анфас предмет слева, у бокового — справа).
  const box = `${-50 * PROBE} ${-50 * PROBE} ${100 * PROBE} ${100 * PROBE}`;
  for (const skin of HERO_SKINS) {
    for (const states of [HERO_STATES, HERO_VIEWS.front, HERO_VIEWS.back]) {
      for (const draw of [...states.idle, ...states.walk]) {
        const svg = withHeroPalette(skin.palette, () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"><defs>${heroDefs()}</defs>${draw()}</svg>`);
        items.push({ id: `hero-${skin.id}`, src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` });
      }
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
  const owners = [
    ...ENEMY_ART.map((art) => ({ id: art.id, pad: art.pad, ppu: pxPerUnit(art.radius, 1.75) })),
    ...HERO_SKINS.map((skin) => ({ id: `hero-${skin.id}`, pad: skin.pad, ppu: pxPerUnit(10, 2.6) })),
  ];
  return owners.map(({ id, pad, ppu }) => {
    const e = extents[id];
    const reach = Math.max(e.left, e.right, e.top, e.bottom);
    // Запас округляется вверх до сотых: это число и пишется в `pad`.
    const need = Math.max(1, Math.ceil(((reach + MARGIN_PX / ppu) / 50) * 100) / 100);
    return { id, ...e, pad: pad ?? 1, need, fits: need <= (pad ?? 1) + 1e-9 };
  });
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../out");

/** Кадры врагов и обликов из собранных атласов, обрезанные вплотную к краю. */
export function atlasContacts() {
  const files = readdirSync(OUT).filter((f) => /^atlas-(core|late|r157|skin-.+)\.json$/.test(f));
  const found = [];
  for (const file of files) {
    const { frames } = JSON.parse(readFileSync(join(OUT, file), "utf8"));
    for (const [name, f] of Object.entries(frames)) {
      if (/^(fx|pickup|secret|decor)\//.test(name)) continue;
      const s = f.spriteSourceSize;
      const edges = `${s.x <= 0 ? "слева " : ""}${s.y <= 0 ? "сверху " : ""}${s.x + s.w >= f.sourceSize.w ? "справа" : ""}`.trim();
      if (edges !== "") found.push(`${name}: ${edges}`);
    }
  }
  return found;
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
  const contacts = atlasContacts();
  for (const line of contacts) console.log(`атлас — кадр у края: ${line}`);
  if (rows.some((r) => !r.fits) || contacts.length > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
