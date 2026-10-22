/**
 * Логотип v2 (design/art/direction-v2.md §7.1): словесный знак «РУБЕЖ» и
 * знак-оберег. Буквы нарисованы многоугольниками на сетке, а не набраны
 * шрифтом: логотип не зависит от того, какой шрифт стоит в интерфейсе, и
 * одинаков в игре, в картинках бота и на промо.
 *
 * Сетка: высота прописной — 100, толщина штриха — 24, срез угла — 12, как
 * «срез» у карточек и кнопок (design/README.md). Ж — руна-оберег: в её
 * начертании уже есть вертикаль и две диагонали, как у знаков на воротах, а в
 * перекрестье — ромб прежнего знака, бирюзой оберегов.
 *
 * Слои — как у игровых логотипов, которые читаются на любом фоне: тёмный
 * контур, выдавленный низ (объём), лицо материалом и блик по верхней грани.
 *
 *   node design/art/src/logo.mjs
 * пишет `out/brand/*.svg`, файлы знака оболочки (`design-system/brand/`) и
 * снимок `out/preview/logo-v2.png`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../out");

/** Буквы: путь в своей системе координат (0…ширина, 0…100) и ширина. */
const LETTERS = {
  Р: { w: 72, d: "M12 0H58L72 14V48L58 62H24V100H0V12ZM24 22V40H48V22Z" },
  У: { w: 74, d: "M0 0H25L41 40L52 0H74L46 88L37 100H8V80H26L30 68Z" },
  Б: { w: 72, d: "M0 12L12 0H70V22H24V38H58L72 52V86L58 100H0ZM24 60V78H48V60Z" },
  Е: { w: 64, d: "M12 0H64V22H24V39H56V61H24V78H64V100H0V12Z" },
};
const ZHE_W = 104;
const GAP = 12;
const STEM = 20;
const ARM = 18;

/** Цвета материалов — токены направления «Сумеречный рубеж» (`packages/design-tokens`). */
export const BRAND = {
  ink: "#120f1e",
  depth: "#3b2f5c",
  steelTop: "#ffffff",
  steelMid: "#ece7f8",
  steelLow: "#a99fcb",
  emberTop: "#ffe7a3",
  emberMid: "#ffb22e",
  emberLow: "#e0700f",
  emberDepth: "#7a3208",
  wardTop: "#c9fff6",
  wardLow: "#25c4b4",
  sky: "#1b1830",
};

/**
 * Фигуры словесного знака одним слоем. `grow` утолщает штрихи — так рисуется
 * контур: те же фигуры, толще и тёмным, под лицом.
 */
function letterShapes({ fill, rune, grow = 0, dy = 0, gem = null, id, letters = ["Р", "У", "Б", "Е"] }) {
  const parts = [];
  let x = 0;
  for (const ch of letters) {
    const stroke = grow > 0 ? ` stroke="${fill}" stroke-width="${grow * 2}" stroke-linejoin="miter"` : "";
    parts.push(`<path transform="translate(${x} ${dy})" d="${LETTERS[ch].d}" fill="${fill}" fill-rule="evenodd"${stroke}/>`);
    x += LETTERS[ch].w + GAP;
  }
  const c = x + ZHE_W / 2;
  // Диагонали — толстые линии, обрезанные по строке: концы ложатся
  // горизонтальным срезом, как у прямых букв. Контур обрезан рамкой шире на
  // свою толщину — иначе концы диагоналей торчали бы шипами.
  const clipId = `${id}-zhe-${String(grow)}`;
  const clip = ` clip-path="url(#${clipId})"`;
  const top = -grow;
  const bottom = 100 + grow;
  parts.push(`<clipPath id="${clipId}"><rect x="${x - grow}" y="${top}" width="${ZHE_W + grow * 2}" height="${bottom - top}"/></clipPath>`);
  parts.push(`<g transform="translate(0 ${dy})"${clip}>
    <path d="M${c} ${top - 8}V${bottom + 8}" stroke="${rune}" stroke-width="${STEM + grow * 2}"/>
    <path d="M${c - 56} -6L${c} 50L${c + 56} 106M${c + 56} -6L${c} 50L${c - 56} 106" stroke="${rune}" stroke-width="${ARM + grow * 2}" fill="none"/>
  </g>`);
  if (gem !== null) {
    const r = 21 + (gem.grow ?? 0);
    parts.push(`<path transform="translate(0 ${dy})" d="M${c} ${50 - r}L${c + r} 50L${c} ${50 + r}L${c - r} 50Z" fill="${gem.fill}" stroke="${gem.stroke ?? "none"}" stroke-width="${gem.strokeWidth ?? 0}" stroke-linejoin="round"/>`);
  }
  return { parts: parts.join(""), width: x + ZHE_W, zheX: x, gemX: c };
}

function gradients(id) {
  const b = BRAND;
  return `<linearGradient id="${id}-steel" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100"><stop offset="0" stop-color="${b.steelTop}"/><stop offset="0.5" stop-color="${b.steelMid}"/><stop offset="1" stop-color="${b.steelLow}"/></linearGradient>
  <linearGradient id="${id}-ember" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100"><stop offset="0" stop-color="${b.emberTop}"/><stop offset="0.45" stop-color="${b.emberMid}"/><stop offset="1" stop-color="${b.emberLow}"/></linearGradient>
  <linearGradient id="${id}-ward" gradientUnits="userSpaceOnUse" x1="0" y1="29" x2="0" y2="71"><stop offset="0" stop-color="${b.wardTop}"/><stop offset="1" stop-color="${b.wardLow}"/></linearGradient>
  <linearGradient id="${id}-gloss" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100"><stop offset="0" stop-color="#fff" stop-opacity="0.75"/><stop offset="0.16" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <radialGradient id="${id}-glow"><stop offset="0" stop-color="${b.wardTop}" stop-opacity="0.9"/><stop offset="0.35" stop-color="${b.wardLow}" stop-opacity="0.35"/><stop offset="1" stop-color="${b.wardLow}" stop-opacity="0"/></radialGradient>`;
}

/**
 * Слои знака: свечение ромба, контур, выдавленный низ, лицо материалом, блик
 * и ромб. `letters` — буквы перед руной: у словесного знака все четыре, у
 * знака-оберега ни одной.
 */
function layers({ id, letters, depth, outline, glow }) {
  const b = BRAND;
  const ink = { fill: b.ink, grow: outline + 2 };
  // Контур — под выдавленным низом и под лицом, тем же тёмным.
  const outer = letterShapes({ fill: b.ink, rune: b.ink, grow: outline, dy: depth, gem: ink, id, letters });
  const outerTop = letterShapes({ fill: b.ink, rune: b.ink, grow: outline, gem: ink, id, letters });
  const extrude = [];
  for (let k = depth; k > 0; k -= 1.5) extrude.push(letterShapes({ fill: b.depth, rune: b.emberDepth, dy: k, id, letters }).parts);
  const face = letterShapes({ fill: `url(#${id}-steel)`, rune: `url(#${id}-ember)`, id, letters });
  const gloss = letterShapes({ fill: `url(#${id}-gloss)`, rune: `url(#${id}-gloss)`, id, letters });
  const g = face.gemX;
  const gem = `<path d="M${g} 27L${g + 23} 50L${g} 73L${g - 23} 50Z" fill="${b.ink}"/>
    <path d="M${g} 31L${g + 19} 50L${g} 69L${g - 19} 50Z" fill="url(#${id}-ward)"/>
    <path d="M${g} 34L${g + 9} 43L${g - 6} 45Z" fill="#fff" fill-opacity="0.85"/>`;
  const halo = glow ? `<circle cx="${g}" cy="50" r="62" fill="url(#${id}-glow)"/>` : "";
  return { body: `${halo}${outer.parts}${outerTop.parts}${extrude.join("")}${face.parts}${gloss.parts}${gem}`, width: face.width };
}

/**
 * Словесный знак. `depth` — высота выдавленного низа, `outline` — толщина
 * контура; на мелком размере (шапка, подпись) их уменьшают, иначе буквы
 * слипаются.
 */
export function wordmark({ id = "wm", depth = 9, outline = 6, glow = true } = {}) {
  const { body, width } = layers({ id, letters: ["Р", "У", "Б", "Е"], depth, outline, glow });
  const pad = outline + 4;
  const lift = glow ? 14 : 0;
  const viewBox = `${-pad} ${-pad - lift} ${width + pad * 2} ${100 + depth + pad * 2 + lift}`;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><defs>${gradients(id)}</defs>${body}</svg>`, width: width + pad * 2 };
}

/** Знак-оберег без фона: руна Ж с ромбом — для шапки, заставки и мелких мест. */
export function runeMark({ id = "rm", depth = 7, outline = 6, glow = true } = {}) {
  const { body } = layers({ id, letters: [], depth, outline, glow });
  const pad = outline + 4;
  const viewBox = `${-pad} ${-pad} ${ZHE_W + pad * 2} ${100 + depth + pad * 2}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><defs>${gradients(id)}</defs>${body}</svg>`;
}

/**
 * Значок приложения 512×512: сумеречное небо, жар очага снизу, частокол
 * рубежа и руна-оберег над ним. Детали частокола и искры пропадают на
 * мелком размере — там остаётся руна, ради неё значок и узнают.
 */
export function appIcon({ id = "ai", rounded = true } = {}) {
  const b = BRAND;
  const { body } = layers({ id, letters: [], depth: 8, outline: 7, glow: true });
  // Частокол: заострённые колья разной высоты, контур сверху — отсвет очага.
  const stakes = [];
  const stakeW = 46;
  for (let k = -1; k < 13; k++) {
    const x = k * stakeW - 8;
    const h = 92 + ((k * 37) % 5) * 9;
    const top = 512 - h;
    const d = `M${x} 512V${top + 22}L${x + stakeW / 2 - 2} ${top}L${x + stakeW - 4} ${top + 22}V512Z`;
    stakes.push(`<path d="${d}" fill="#0d0a18" stroke="${b.emberMid}" stroke-opacity="0.55" stroke-width="3" stroke-linejoin="round"/>`);
  }
  const stars = [
    [70, 70, 3], [140, 40, 2], [430, 60, 3], [470, 140, 2], [60, 180, 2], [390, 30, 2], [250, 26, 2],
  ].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" fill-opacity="0.7"/>`);
  const sparks = [
    [118, 330, 7], [402, 300, 6], [356, 372, 5], [160, 392, 5], [446, 380, 4], [72, 300, 4],
  ].map(([x, y, r]) => `<path d="M${x} ${y - r}L${x + r * 0.6} ${y}L${x} ${y + r}L${x - r * 0.6} ${y}Z" fill="${b.emberTop}" fill-opacity="0.9"/>`);
  // Кольцо-оберег за руной — печать: тонкий обод и ромбы по кругу.
  const beads = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const x = 256 + Math.cos(a) * 178;
    const y = 226 + Math.sin(a) * 178;
    const r = k % 4 === 0 ? 9 : 5;
    beads.push(`<path d="M${x.toFixed(1)} ${(y - r).toFixed(1)}L${(x + r * 0.7).toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${(y + r).toFixed(1)}L${(x - r * 0.7).toFixed(1)} ${y.toFixed(1)}Z" fill="${b.emberMid}" fill-opacity="${k % 4 === 0 ? 0.9 : 0.55}"/>`);
  }
  const ring = `<circle cx="256" cy="226" r="178" fill="none" stroke="${b.emberMid}" stroke-opacity="0.35" stroke-width="4"/><circle cx="256" cy="226" r="164" fill="#120f1e" fill-opacity="0.35"/>${beads.join("")}`;
  const clip = rounded ? `<clipPath id="${id}-card"><rect width="512" height="512" rx="112"/></clipPath>` : `<clipPath id="${id}-card"><rect width="512" height="512"/></clipPath>`;
  const bg = `<linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a2860"/><stop offset="0.6" stop-color="#1d1733"/><stop offset="1" stop-color="#120f1e"/></linearGradient>
    <radialGradient id="${id}-hearth" cx="0.5" cy="1" r="0.75"><stop offset="0" stop-color="#ff9a2e" stop-opacity="0.75"/><stop offset="0.45" stop-color="#e0700f" stop-opacity="0.25"/><stop offset="1" stop-color="#e0700f" stop-opacity="0"/></radialGradient>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs>${gradients(id)}${bg}${clip}</defs>
  <g clip-path="url(#${id}-card)">
    <rect width="512" height="512" fill="url(#${id}-sky)"/>
    ${stars.join("")}
    <rect width="512" height="512" fill="url(#${id}-hearth)"/>
    ${stakes.join("")}
    ${sparks.join("")}
    ${ring}
    <g transform="translate(256 226) scale(2.3) translate(-52 -54)">${body}</g>
  </g>
  ${rounded ? `<rect x="3" y="3" width="506" height="506" rx="110" fill="none" stroke="#fff" stroke-opacity="0.1" stroke-width="6"/>` : ""}
</svg>`;
}

/**
 * Значок вкладки: руна без объёма на тёмном скруглённом квадрате. Встаёт в
 * `index.html` строкой data-URL, поэтому без свечения и лишних слоёв.
 */
export function favicon() {
  const { body } = layers({ id: "fv", letters: [], depth: 0, outline: 7, glow: false });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs>${gradients("fv")}</defs><rect width="128" height="128" rx="28" fill="#1b1830"/><g transform="translate(64 64) scale(0.92) translate(-52 -50)">${body}</g></svg>`;
}

/** Оболочка берёт знак отсюда: `design-system/components/Brand.tsx`. */
const APP_BRAND = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/app-shell/src/design-system/brand");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(OUT, "brand"), { recursive: true });
  const files = {
    "wordmark.svg": wordmark().svg,
    "wordmark-flat.svg": wordmark({ id: "wf", depth: 4, outline: 4, glow: false }).svg,
    "rune.svg": runeMark(),
    "rune-flat.svg": runeMark({ id: "rf", depth: 4, outline: 5, glow: false }),
    "app-icon.svg": appIcon(),
    "app-icon-square.svg": appIcon({ id: "aq", rounded: false }),
  };
  files["favicon.svg"] = favicon();
  for (const [name, svg] of Object.entries(files)) {
    writeFileSync(join(OUT, "brand", name), svg + "\n");
    console.log(`${name} · ${String(Buffer.byteLength(svg))} Б`);
  }
  mkdirSync(APP_BRAND, { recursive: true });
  writeFileSync(join(APP_BRAND, "rune.svg"), files["rune.svg"] + "\n");
  writeFileSync(join(APP_BRAND, "wordmark.svg"), files["wordmark.svg"] + "\n");
  console.log(`оболочка: ${APP_BRAND}`);
  await bakePreview(files);
}

/** Лист бренда для документов: знак на тёмном и светлом, значок по размерам. */
async function bakePreview(files) {
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  let chromium;
  try {
    ({ chromium } = await import(pathToFileURL(path).href));
  } catch {
    console.log("playwright не найден — снимок out/preview/logo-v2.png не обновлён");
    return;
  }
  const icon = files["app-icon.svg"];
  const html = `<body style="margin:0;width:1200px;font:14px system-ui;color:#aeaac4">
  <div style="background:radial-gradient(120% 80% at 50% 0%,#3b2a55,#141322);padding:40px 48px;display:flex;gap:48px;align-items:center">
    <div style="width:560px">${files["wordmark.svg"]}</div>
    <div style="display:flex;gap:22px;align-items:end">${[220, 96, 48, 32, 16].map((w) => `<div style="width:${w}px">${icon}</div>`).join("")}</div>
  </div>
  <div style="display:flex">
    <div style="flex:1;background:#f3efe6;padding:28px 48px;display:flex;gap:40px;align-items:center"><div style="width:360px">${files["wordmark.svg"]}</div><div style="width:84px">${files["rune.svg"]}</div></div>
    <div style="flex:1;background:#1d1c31;padding:28px 48px;display:flex;gap:40px;align-items:center"><div style="width:220px">${files["wordmark-flat.svg"]}</div><div style="width:64px">${files["rune-flat.svg"]}</div><div style="width:32px">${files["favicon.svg"]}</div></div>
  </div></body>`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 100 } });
  await page.setContent(html);
  await page.screenshot({ path: join(OUT, "preview", "logo-v2.png"), fullPage: true });
  await browser.close();
  console.log("out/preview/logo-v2.png");
}
