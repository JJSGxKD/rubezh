// Сборка атласов арта забега: SVG-кадры → Chromium → PNG-атлас и JSON Phaser.
//
//   node design/art/src/build.mjs
//
// Нужен Playwright с Chromium (в облачной среде — /opt/node-tools, локально —
// `PLAYWRIGHT_MODULE=путь/к/playwright/index.mjs`). Результат — design/art/out/.
// Это черновой конвейер дизайнера: в сборку игры он не входит, атласы
// подключаются отдельной задачей (design/art/characters.md, «Интеграция»).

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENEMY_ART } from "./creatures.mjs";
import { HERO_DEFS, HERO_RADIUS, HERO_SKINS, HERO_STATES, heroDefs, withHeroPalette } from "./hero.mjs";
import { SECRETS } from "./secrets.mjs";
import { creaturePalette, enemyBody, enemyEye, GOLD_RIM, hex, NAV_GLOW, STAGES } from "./palette.mjs";
import { FX } from "./fx.mjs";
import { PICKUPS } from "./pickups.mjs";
import { decorFrames, groundTile, ZONES } from "./env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "out");
mkdirSync(OUT, { recursive: true });

/**
 * Пикселей атласа на игровую единицу. Телефон 390×844 с DPR 3 видит 2,8 физ.
 * пикселя на единицу в движении и 3,4 — стоя (content/maps.ts, площадь
 * обзора): 2,5 даёт растяжение не больше 1,35×, плоский рисунок его не
 * выдаёт, а атлас на треть легче, чем при 3 (design/art/characters.md, «Форматы»).
 */
export const PPU = Number(process.env.ART_PPU ?? 2.5);
/**
 * Сторона ячейки в радиусах хитбокса. Тело существа в рисунке занимает
 * ≈0,57 поля, поэтому 1,75 ставит тело вровень с хитбоксом: игрок не получает
 * урон «не коснувшись», а хвосты, крылья и копья выходят за круг.
 */
const CELL_K = 1.75;
const WALK_FRAMES = 4;

/** Какие враги в каком паке: core — первые три минуты таймлайна, late — остальное (docs/27 §3.5). */
const CORE_ENEMIES = new Set(["swarm_rat", "dasher_wolf", "shooter_wisp", "bone_walker", "circler_crow", "elite_ghoul"]);

function rimFilter(id, color, radius) {
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" filterUnits="objectBoundingBox">
<feMorphology in="SourceAlpha" operator="dilate" radius="${radius}" result="d"/>
<feFlood flood-color="${color}"/><feComposite in2="d" operator="in" result="o"/>
<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
}

/**
 * Обёртка кадра. Кайма ранга и стиль концепции — здесь, а не в рисунке:
 * рисунок не знает, рядовой он, элита или вариант для сравнения.
 * Толщина каймы — в игровых единицах, как `enemyRim` в looks.ts (2 у элиты, 3 у босса).
 */
/**
 * Кадр врага: рисунок в клетке −50…50, кайма ранга, свечение Нави под ногами.
 * `pad` — запас клетки для рисунка, который выходит за неё (копьё, рог, меч):
 * клетка шире во столько раз, а масштаб рисунка тот же — движок берёт размер
 * из пикселей кадра, и тело в мире не меняется. Сколько запаса нужно, меряет
 * `node design/art/src/frame-fit.mjs`.
 */
export function svgFrame(inner, { rank, radius, style = "C", defs = "", hostile = false, pad = 1 } = {}) {
  const unitsPerBox = (radius * 2 * CELL_K) / 100;
  let filters = defs;
  let body = inner;
  // Свечение Нави под врагом (палитра v2): общий знак враждебности вместо
  // сплошного красного. Под каймой ранга, чтобы кайма обводила только тело.
  const glow = hostile
    ? `<radialGradient id="nav"><stop offset="0" stop-color="${hex(NAV_GLOW)}" stop-opacity="0.75"/><stop offset="1" stop-color="${hex(NAV_GLOW)}" stop-opacity="0"/></radialGradient>`
    : "";
  filters += glow;
  if (rank !== undefined) {
    const width = (rank === "boss" ? 3 : 2) / unitsPerBox;
    filters += rimFilter("rank", hex(GOLD_RIM), (width * 0.5).toFixed(2));
    body = `<g filter="url(#rank)">${body}</g>`;
  }
  if (style === "A") {
    filters += rimFilter("outlineA", "#1d0b22", (1.4 / unitsPerBox).toFixed(2));
    body = `<g filter="url(#outlineA)">${body}</g>`;
  }
  if (style === "B") {
    filters += rimFilter("rimB", "#ff4d5a", (0.9 / unitsPerBox).toFixed(2));
    body = `<g filter="url(#rimB)">${body}</g>`;
  }
  const under = hostile ? `<ellipse cx="0" cy="42" rx="34" ry="9" fill="url(#nav)"/>` : "";
  const box = pad === 1 ? "-50 -50 100 100" : `${-50 * pad} ${-50 * pad} ${100 * pad} ${100 * pad}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"><defs>${filters}</defs>${under}${body}</svg>`;
}

function enemyFrames(art, stage, style = "C", version = 2) {
  const body = enemyBody(art.pattern, art.rank, stage, art.id, version);
  const palette =
    style === "B" ? creaturePalette(0x3a1830, 0xff6a5a) : creaturePalette(body, enemyEye(stage, version));
  const hostile = version === 2 && style === "C";
  return Array.from({ length: WALK_FRAMES }, (_, k) => svgFrame(art.draw(k / WALK_FRAMES, palette), { rank: art.rank, radius: art.radius, style, hostile, pad: art.pad }));
}

export { CELL_K };

export function cellSize(radius, k = CELL_K) {
  return Math.ceil(radius * 2 * k * PPU);
}

/** Все кадры атласов: имя → { svg, size }. */
export function collectFrames() {
  const packs = { core: [], late: [], env: decorFrames(PPU) };
  // Тайники — в паке мира рядом с декором: грузятся вместе с землёй, а их
  // кадров немного. Имя — `secret/<вид>/<состояние>`, вид — как `SecretKind`
  // в движке; центр кадра — центр тайника (T-0260).
  for (const secret of SECRETS) {
    for (const [state, draw] of Object.entries(secret.states)) {
      packs.env.push({ name: `secret/${secret.id}/${state}`, svg: draw(), size: Math.ceil(secret.units * PPU) });
    }
  }
  for (const [state, frames] of Object.entries(HERO_STATES)) {
    frames.forEach((draw, k) => {
      packs.core.push({
        name: `hero/${state}${k}`,
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100"><defs>${HERO_DEFS}</defs>${draw()}</svg>`,
        size: cellSize(HERO_RADIUS, 2.6),
      });
    });
  }
  // Облики — пак на облик (`skin-<id>`): в забеге нужен только свой, и с каждым
  // окрасом пасса общий пак рос бы для всех. Только покой и шаг: ранение и
  // смерть — кадры обычного героя. Имена кадров — `hero-<id>/…`, как раньше.
  for (const skin of HERO_SKINS.slice(1)) {
    const frames = [];
    for (const state of ["idle", "walk"]) {
      HERO_STATES[state].forEach((draw, k) => {
        // Запас клетки (`pad`) — для головы архетипа выше общей позы: шлем,
        // венец, бубенцы. Масштаб рисунка тот же, тело героя в мире прежнее.
        const pad = skin.pad ?? 1;
        const box = `${-50 * pad} ${-50 * pad} ${100 * pad} ${100 * pad}`;
        const svg = withHeroPalette(skin.palette, () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"><defs>${heroDefs()}</defs>${draw()}</svg>`);
        frames.push({ name: `hero-${skin.id}/${state}${k}`, svg, size: cellSize(HERO_RADIUS * pad, 2.6) });
      });
    }
    packs[`skin-${skin.id}`] = frames;
  }
  for (const art of ENEMY_ART) {
    const pack = CORE_ENEMIES.has(art.id) ? packs.core : packs.late;
    // Ступени — только у рядовых: элита и боссы ступеней не получают (content/stages.ts).
    const stages = art.rank === undefined ? STAGES.length : 1;
    for (let stage = 0; stage < stages; stage++) {
      enemyFrames(art, stage).forEach((svg, k) => {
        pack.push({ name: `${art.id}/s${stage}/walk${k}`, svg, size: cellSize(art.radius * (art.pad ?? 1)) });
      });
    }
  }
  // Подборы — в core: кристаллы и аптечки падают с первой минуты.
  for (const pickup of PICKUPS) {
    pickup.frames.forEach((svg, k) => packs.core.push({ name: `pickup/${pickup.id}/${k}`, svg, size: Math.ceil(pickup.units * PPU) }));
  }
  for (const fx of FX) {
    fx.frames.forEach((svg, k) => packs.core.push({ name: `fx/${fx.id}${k}`, svg, size: Math.ceil(fx.units * PPU) }));
  }
  return packs;
}

/**
 * Полочная упаковка прямоугольников: высокие первыми. Кадр — обрезанный по
 * альфе прямоугольник `w × h` (без обрезки — квадрат ячейки).
 */
export function pack(frames, maxWidth = 1024, pad = 2) {
  const w = (frame) => frame.w ?? frame.size;
  const h = (frame) => frame.h ?? frame.size;
  const sorted = [...frames].sort((a, b) => h(b) - h(a) || a.name.localeCompare(b.name));
  let x = pad;
  let y = pad;
  let shelf = 0;
  let right = 0;
  for (const frame of sorted) {
    if (x + w(frame) + pad > maxWidth) {
      x = pad;
      y += shelf + pad;
      shelf = 0;
    }
    frame.x = x;
    frame.y = y;
    x += w(frame) + pad;
    right = Math.max(right, x);
    shelf = Math.max(shelf, h(frame));
  }
  // Высота и ширина — кратные четырём, а не степень двойки: WebGL2 и Phaser держат
  // такие текстуры без мип-карт, а степень двойки съедала бы до половины атласа.
  // Ширина — по самому правому кадру: пак облика в шесть кадров не тянет полосу в 1024.
  const width = Math.min(maxWidth, Math.ceil(right / 4) * 4);
  const height = Math.ceil((y + shelf + pad) / 4) * 4;
  return { width, height, frames: sorted };
}

async function loadPlaywright() {
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  return import(pathToFileURL(path).href);
}

/** Отрисовать список SVG в ячейки одного холста в браузере, вернуть PNG. */
export async function renderSheet(page, layout, mime = "image/png") {
  return page.evaluate(async ({ width, height, frames, mime }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    for (const frame of frames) {
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(frame.svg)}`;
      await img.decode();
      ctx.drawImage(img, frame.x, frame.y, frame.size, frame.size);
    }
    return canvas.toDataURL(mime, 0.82).split(",")[1];
  }, { ...layout, mime });
}

/**
 * Отрисовать кадры в браузере и найти у каждого границы непрозрачного.
 * Холсты кадров остаются в странице до `composeAtlas`.
 */
async function trimFrames(page, frames) {
  const bounds = await page.evaluate(async (list) => {
    window.__frames = {};
    const out = [];
    for (const frame of list) {
      const canvas = document.createElement("canvas");
      canvas.width = frame.size;
      canvas.height = frame.size;
      const ctx = canvas.getContext("2d");
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(frame.svg)}`;
      await img.decode();
      ctx.drawImage(img, 0, 0, frame.size, frame.size);
      const data = ctx.getImageData(0, 0, frame.size, frame.size).data;
      let x0 = frame.size, y0 = frame.size, x1 = -1, y1 = -1;
      for (let y = 0; y < frame.size; y++) for (let x = 0; x < frame.size; x++) {
        if (data[(y * frame.size + x) * 4 + 3] > 2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      // Пустой кадр (погасший эффект) — точка 1×1, чтобы атлас не терял имя.
      if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; }
      // Поле в пиксель: линейная фильтрация не должна тянуть цвет соседа по атласу.
      x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(frame.size - 1, x1 + 1); y1 = Math.min(frame.size - 1, y1 + 1);
      window.__frames[frame.name] = canvas;
      out.push({ tx: x0, ty: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return out;
  }, frames.map(({ name, svg, size }) => ({ name, svg, size })));
  frames.forEach((frame, i) => Object.assign(frame, bounds[i]));
}

/** Сложить обрезанные кадры в атлас по раскладке `pack`. */
async function composeAtlas(page, layout) {
  return page.evaluate(({ width, height, frames }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    for (const f of frames) ctx.drawImage(window.__frames[f.name], f.tx, f.ty, f.w, f.h, f.x, f.y, f.w, f.h);
    return canvas.toDataURL("image/png").split(",")[1];
  }, { width: layout.width, height: layout.height, frames: layout.frames.map(({ name, tx, ty, w, h, x, y }) => ({ name, tx, ty, w, h, x, y })) });
}

function phaserJson(layout, image) {
  const frames = {};
  for (const frame of layout.frames) {
    // Обрезанный кадр: Phaser ставит его на место в исходной ячейке, и
    // центр спрайта остаётся центром ячейки — масштаб и якорь прежние.
    frames[frame.name] = {
      frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
      rotated: false,
      trimmed: true,
      spriteSourceSize: { x: frame.tx, y: frame.ty, w: frame.w, h: frame.h },
      sourceSize: { w: frame.size, h: frame.size },
    };
  }
  return { frames, meta: { app: "design/art/src/build.mjs", image, format: "RGBA8888", size: { w: layout.width, h: layout.height }, scale: String(PPU) } };
}

async function main() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const packs = collectFrames();
  const report = [];
  for (const [name, frames] of Object.entries(packs)) {
    await trimFrames(page, frames);
    const layout = pack(frames);
    const png = Buffer.from(await composeAtlas(page, layout), "base64");
    const file = join(OUT, `atlas-${name}.png`);
    writeFileSync(file, png);
    // Палитра — отдельным шагом на Python (Pillow): без него атлас остаётся полноцветным.
    const quantized = spawnSync("python3", [join(HERE, "quantize.py"), file], { stdio: "inherit" }).status === 0;
    if (!quantized) console.warn(`без палитры: ${file}`);
    writeFileSync(join(OUT, `atlas-${name}.json`), `${JSON.stringify(phaserJson(layout, `atlas-${name}.png`), null, 1)}\n`);
    const used = frames.reduce((sum, frame) => sum + frame.w * frame.h, 0);
    const cells = frames.reduce((sum, frame) => sum + frame.size * frame.size, 0);
    report.push({ pack: name, frames: frames.length, atlas: `${layout.width}×${layout.height}`, fill: `${Math.round((used / (layout.width * layout.height)) * 100)}%`, trim: `${Math.round((used / cells) * 100)}% ячейки`, png: `${Math.round(statSync(join(OUT, `atlas-${name}.png`)).size / 1024)} КБ`, gpu: `${((layout.width * layout.height * 4) / 1048576).toFixed(1)} МБ` });
  }
  // Плитки земли — отдельными текстурами: TileSprite повторяет текстуру целиком.
  // WebP, а не PNG: у плитки нет прозрачности, а размытые пятна сжимаются
  // в 3–4 КБ против 210 КБ PNG без видимой разницы.
  // Нужна одна нейтральная плитка: цвет зоны рендер кладёт окраской по вершинам.
  // Плитки зон собираются только для сравнения: `ART_ZONE_TILES=1`.
  const tiles = process.env.ART_ZONE_TILES === "1" ? Object.keys(ZONES) : ["neutral"];
  for (const zone of tiles) {
    const size = 512;
    const png = Buffer.from(await renderSheet(page, { width: size, height: size, frames: [{ svg: groundTile(zone, size), x: 0, y: 0, size }] }, "image/webp"), "base64");
    writeFileSync(join(OUT, `ground-${zone}.webp`), png);
    report.push({ pack: `ground-${zone}`, frames: 1, atlas: `${size}×${size}`, fill: "100%", png: `${Math.round(png.length / 1024)} КБ`, gpu: `${((size * size * 4) / 1048576).toFixed(2)} МБ` });
  }
  console.table(report);
  writeFileSync(join(OUT, "atlas-report.json"), `${JSON.stringify(report, null, 1)}\n`);
  await browser.close();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
