/**
 * Стартовые пресеты промо с артом мира (design/art/backlog.md п. 15,
 * docs/35-stage4-plan.md Р159, T-0275). Фон — кадр того же мира, что
 * `promo.mjs`, но без знака и надписей: знак, заголовок, `{code}`,
 * `{reward}`, QR и плашки — слои документа `promo-kit`, их правят в редакторе
 * панели, а партнёр — отмеченные (`partner`).
 *
 * Картинка фона в документе — `{ media: <id> }`, а id картинки на сервере —
 * sha256 её байтов (`imageIdOf`, media/image-rules.ts). Поэтому id известен
 * заранее: панель загружает WebP профилем `promo_asset` при создании пресета
 * из стартового и подставляет id, который вернул сервер.
 *
 *   node design/art/src/promo-presets.mjs
 * пишет `apps/admin/src/screens/promo/art-starters/` (`<id>.webp` и
 * `presets.json`), макет `mockups/promo-presets-v2.html` и лист
 * `out/sheet-promo-presets.png`. Правится здесь, а не там.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runeMark, wordmark } from "./logo.mjs";
import { page } from "./promo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const STARTERS = join(ROOT, "apps/admin/src/screens/promo/art-starters");
const MOCKUPS = join(HERE, "../mockups");
const OUT = join(HERE, "../out");

/** Предел профиля `promo_asset` — 600 КБ (T-0273); берём с запасом. */
const MAX_BYTES = 560 * 1024;

/** Размеры форматов — те же, что `FORMATS` в `packages/promo-kit/src/formats.ts`. */
const SIZES = {
  story: { w: 1080, h: 1920 },
  square: { w: 1080, h: 1080 },
  portrait: { w: 1080, h: 1350 },
  wide: { w: 1280, h: 720 },
  link_preview: { w: 1200, h: 630 },
};

/**
 * Палитра пресетов — цвета `@bh/design-tokens`: из неё же партнёр выбирает
 * цвет отмеченного слоя. Восемь — предел `MAX_PALETTE`.
 */
const C = {
  accent: "#ff8f3f",
  gold: "#ffd15c",
  text: "#f3eee6",
  muted: "#aeaac4",
  sunken: "#17162a",
  onAccent: "#230f02",
  secondary: "#46d9c6",
  hp: "#ff6f90",
};
const PALETTE = Object.values(C);

const text = (id, x, y, width, height, value, o) => ({
  id,
  type: "text",
  x,
  y,
  width,
  height,
  text: value,
  font: o.font ?? "ibm_plex_sans",
  size: o.size,
  weight: o.weight ?? 400,
  color: o.color ?? C.text,
  align: o.align ?? "left",
  lineHeight: o.lineHeight ?? 1.15,
  ...(o.partner ? { partner: o.partner } : {}),
});
const rect = (id, x, y, width, height, fill, o = {}) => ({
  id,
  type: "rect",
  x,
  y,
  width,
  height,
  fill,
  ...(o.radius !== undefined ? { radius: o.radius } : {}),
  ...(o.opacity !== undefined ? { opacity: o.opacity } : {}),
  ...(o.stroke ? { stroke: o.stroke, strokeWidth: o.strokeWidth ?? 3 } : {}),
  ...(o.partner ? { partner: o.partner } : {}),
});
// QR — тёмный на светлом: так его читает любая камера (T-0274).
const qr = (id, x, y, side) => ({ id, type: "qr", x, y, width: side, height: side, fg: C.sunken, bg: C.text });
const logo = (id, x, y, width, height, variant = "full") => ({ id, type: "logo", x, y, width, height, variant });

/** Плашка-реликвия под кодом и кнопкой: тёмная, в золотой кайме, как окна v2. */
const plaque = (id, x, y, width, height) => rect(id, x, y, width, height, C.sunken, { radius: 28, opacity: 0.9, stroke: C.gold, strokeWidth: 3, partner: "color" });
/** Кнопка-призыв: на картинке не нажимается, но читается как вход в игру. */
const cta = (id, x, y, width, height, size) => [
  rect(`${id}_bg`, x, y, width, height, C.accent, { radius: Math.round(height * 0.22), partner: "color" }),
  text(id, x, y + Math.round((height - size * 1.15) / 2), width, Math.round(size * 1.3), "Играть бесплатно", { font: "russo_one", size, color: C.onAccent, align: "center", partner: "text" }),
];

/**
 * Пресеты. `scene` — раскладка кадра `promo.mjs` (доли холста): где герой,
 * горизонт, толпа и босс; `floor` — где кончается земля с толпой, ниже стоят
 * плашки. Слои — в точках формата, снизу вверх. Крупное и важное — внутри
 * безопасной зоны сторис: сверху и снизу 250 точек закрывает интерфейс
 * площадки.
 */
const PRESETS = [
  {
    id: "art_story_code",
    title: "Промокод · сторис с артом",
    format: "story",
    variant: "power",
    seed: 101,
    scene: { heroX: 0.34, heroH: 0.21, heroY: 0.59, horizon: 0.42, floor: 0.62, unit: 1.15, horde: [0.46, 1.08], count: 60, boss: [0.8, 0.36, 0.15], moon: false, chestDX: 0.3, timerX: 0.5, shade: [{ side: "top", extent: 0.3 }] },
    layers: [
      logo("logo", 160, 250, 760, 240),
      text("headline", 60, 510, 960, 100, "Подарок на рубеж", { font: "russo_one", size: 84, align: "center", partner: "text" }),
      text("sub", 90, 615, 900, 56, "Введи код в игре — и забирай {reward}", { size: 40, color: C.muted, align: "center", partner: "text" }),
      plaque("panel", 60, 1180, 960, 480),
      text("code_label", 110, 1220, 560, 48, "Промокод", { size: 36, weight: 700, color: C.muted }),
      text("code", 110, 1272, 580, 120, "{code}", { font: "russo_one", size: 96, color: C.gold }),
      text("reward", 110, 1400, 560, 52, "{reward} на старт", { size: 40, weight: 700 }),
      qr("qr", 740, 1220, 240),
      ...cta("cta", 110, 1500, 860, 112, 52),
    ],
  },
  {
    id: "art_story_challenge",
    title: "Вызов · сторис с рекордом",
    format: "story",
    variant: "challenge",
    seed: 211,
    scene: { heroX: 0.38, heroH: 0.18, heroY: 0.635, horizon: 0.46, floor: 0.66, unit: 1.15, horde: [0.46, 1.08], count: 80, boss: [0.82, 0.4, 0.15], moon: false, chestDX: 0.3, timerX: 0.5, shade: [{ side: "top", extent: 0.36 }] },
    layers: [
      logo("logo", 260, 250, 560, 176),
      text("headline", 60, 450, 960, 200, "Сколько продержишься ты?", { font: "russo_one", size: 84, align: "center", lineHeight: 1.1, partner: "text" }),
      rect("record_bg", 300, 680, 480, 150, C.sunken, { radius: 24, opacity: 0.88, stroke: C.gold, strokeWidth: 3 }),
      text("record", 300, 690, 480, 100, "12:47", { font: "russo_one", size: 96, color: C.text, align: "center", partner: "text" }),
      text("record_label", 300, 784, 480, 40, "МОЙ РЕКОРД", { size: 30, weight: 700, color: C.gold, align: "center", partner: "text" }),
      plaque("panel", 60, 1240, 960, 420),
      text("code_label", 110, 1280, 560, 48, "Побей с кодом", { size: 36, weight: 700, color: C.muted, partner: "text" }),
      text("code", 110, 1332, 580, 120, "{code}", { font: "russo_one", size: 96, color: C.gold }),
      text("reward", 110, 1460, 560, 52, "{reward} на старт", { size: 40, weight: 700 }),
      qr("qr", 740, 1280, 240),
      ...cta("cta", 110, 1545, 860, 90, 44),
    ],
  },
  {
    id: "art_square_invite",
    title: "Приглашение · пост 1:1 с артом",
    format: "square",
    variant: "power",
    seed: 307,
    scene: { heroX: 0.3, heroH: 0.34, heroY: 0.66, horizon: 0.44, floor: 0.74, horde: [0.42, 1.06], count: 64, boss: [0.84, 0.42, 0.26], moon: false, chestDX: 0.29, timerX: 0.5, shade: [{ side: "top", extent: 0.28 }] },
    layers: [
      logo("logo", 300, 40, 480, 152),
      text("headline", 40, 196, 1000, 80, "Держим рубеж вместе?", { font: "russo_one", size: 64, align: "center", partner: "text" }),
      plaque("panel", 40, 790, 1000, 250),
      text("invite", 80, 822, 680, 96, "Заходи по моей ссылке — на старт {reward}", { size: 38, weight: 700, lineHeight: 1.2, partner: "text" }),
      text("code", 80, 940, 680, 64, "Код {code}", { font: "russo_one", size: 52, color: C.gold }),
      qr("qr", 812, 810, 200),
    ],
  },
  {
    id: "art_portrait_season",
    title: "Новый сезон · пост 4:5 с артом",
    format: "portrait",
    variant: "challenge",
    seed: 401,
    scene: { heroX: 0.3, heroH: 0.3, heroY: 0.72, horizon: 0.48, floor: 0.82, horde: [0.4, 1.06], count: 90, boss: [0.74, 0.43, 0.3], moon: false, chestDX: 0.29, timerX: 0.5, shade: [{ side: "top", extent: 0.32 }] },
    layers: [
      logo("logo", 300, 44, 480, 152),
      text("headline", 40, 206, 1000, 90, "Новый сезон на рубеже", { font: "russo_one", size: 72, align: "center", partner: "text" }),
      text("sub", 90, 304, 900, 52, "Навь злее, награды щедрее — заходи первым", { size: 36, color: C.text, align: "center", partner: "text" }),
      plaque("panel", 40, 1120, 1000, 190),
      text("code", 80, 1150, 560, 64, "Код {code}", { font: "russo_one", size: 52, color: C.gold }),
      text("reward", 80, 1224, 560, 48, "{reward} каждому, кто зайдёт", { size: 34, weight: 700, partner: "text" }),
      ...cta("cta", 660, 1166, 340, 98, 30),
    ],
  },
  {
    id: "art_wide_banner",
    title: "Баннер 16:9 с артом",
    format: "wide",
    variant: "power",
    seed: 503,
    scene: { heroX: 0.58, heroH: 0.46, horizon: 0.5, horde: [0.64, 1.04], count: 80, boss: [0.9, 0.44, 0.32], moon: true, chestDX: 0.2, timerX: 0.63, shade: [{ side: "left", extent: 0.55 }] },
    layers: [
      logo("logo", 48, 48, 460, 145),
      text("headline", 48, 214, 520, 120, "Держи рубеж, пока хватает сил", { font: "russo_one", size: 48, lineHeight: 1.1, partner: "text" }),
      text("sub", 48, 344, 520, 76, "Оружие бьёт само — твоё дело не попасться", { size: 28, color: C.text, lineHeight: 1.25, partner: "text" }),
      plaque("panel", 40, 446, 540, 92),
      text("code", 70, 466, 500, 56, "Код {code} — {reward}", { font: "russo_one", size: 36, color: C.gold }),
      ...cta("cta", 48, 572, 400, 92, 40),
    ],
  },
  {
    id: "art_link_preview",
    title: "Превью ссылки с артом",
    format: "link_preview",
    variant: "reward",
    seed: 601,
    scene: { heroX: 0.62, heroH: 0.46, horizon: 0.5, horde: [0.68, 1.04], count: 70, boss: [0.9, 0.44, 0.32], moon: true, chestDX: 0.2, timerX: 0.63, shade: [{ side: "left", extent: 0.55 }] },
    layers: [
      logo("logo", 50, 60, 480, 152),
      text("headline", 50, 240, 520, 120, "Держи рубеж вместе с нами", { font: "russo_one", size: 50, lineHeight: 1.1, partner: "text" }),
      text("reward", 50, 380, 520, 90, "{reward} по приглашению", { size: 34, weight: 700, color: C.gold, lineHeight: 1.2 }),
      text("platform", 50, 500, 520, 44, "Бесплатно, в Telegram", { size: 30, color: C.text, partner: "text" }),
    ],
  },
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Фон без надписей: PNG из браузера → WebP с наименьшим сжатием, которое влезает в предел. */
async function background(browser, preset, tmp) {
  const { w, h } = SIZES[preset.format];
  const html = page(preset.format, preset.variant, { size: { w, h }, layout: { ...preset.scene, text: "none" }, seed: preset.seed, text: false });
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(html);
  await p.waitForTimeout(300);
  const png = join(tmp, `${preset.id}.png`);
  await p.screenshot({ path: png });
  await p.close();
  for (let quality = 90; quality >= 50; quality -= 5) {
    const webp = join(tmp, `${preset.id}-${quality}.webp`);
    // Один кадр без метаданных: сервер не берёт анимацию и EXIF/XMP (image-rules.ts).
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", png, "-map_metadata", "-1", "-frames:v", "1", "-c:v", "libwebp", "-quality", String(quality), "-compression_level", "6", "-f", "webp", webp]);
    const bytes = readFileSync(webp);
    if (bytes.length <= MAX_BYTES) return bytes;
  }
  throw new Error(`${preset.id}: фон не влезает в ${MAX_BYTES} байт`);
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SAMPLE = { code: "ПРИМЕР", reward: "300 монет", link: "https://t.me/example_bot?startapp=promo" };
const fill = (s) => s.replace(/\{(code|link|reward)\}/g, (_, name) => SAMPLE[name]);

/** Макет: документ, как его нарисует редактор, с примером из T-0275. */
function renderDoc(starter, imageUrl, qrSvg, scale) {
  const { w, h } = SIZES[starter.format];
  const b64 = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const layers = starter.doc.layers
    .map((l) => {
      const box = `left:${l.x}px;top:${l.y}px;width:${l.width}px;height:${l.height}px;${l.opacity !== undefined ? `opacity:${l.opacity};` : ""}`;
      if (l.type === "rect") return `<i style="${box}background:${l.fill};border-radius:${l.radius ?? 0}px;${l.stroke ? `box-shadow:inset 0 0 0 ${l.strokeWidth}px ${l.stroke};` : ""}"></i>`;
      if (l.type === "logo") return `<img style="${box}object-fit:contain" src="${b64(l.variant === "full" ? wordmark({ id: `wm-${starter.id}` }).svg : runeMark({ id: `rm-${starter.id}` }))}" alt="">`;
      if (l.type === "qr") return `<img style="${box}background:${l.bg}" src="${b64(qrSvg)}" alt="">`;
      // Имя шрифта в одинарных кавычках: атрибут style — в двойных.
      const font = l.font === "russo_one" ? "'Russo One'" : "'IBM Plex Sans'";
      return `<div style="${box}font:${l.weight} ${l.size}px/${l.lineHeight} ${font},system-ui;color:${l.color};text-align:${l.align}">${escapeHtml(fill(l.text))}</div>`;
    })
    .join("");
  return `<figure><div class="frame" style="width:${w * scale}px;height:${h * scale}px"><div class="doc" style="width:${w}px;height:${h}px;transform:scale(${scale});background-image:url(${imageUrl})">${layers}</div></div><figcaption><b>${escapeHtml(starter.title)}</b><span>${w}×${h} · ${starter.doc.layers.filter((l) => l.partner).length} слоёв партнёру</span></figcaption></figure>`;
}

function mockup(starters, qrSvg) {
  const fonts = relative(MOCKUPS, ROOT);
  const imageUrl = (s) => `${relative(MOCKUPS, STARTERS)}/${s.image}`;
  const cards = starters.map((s) => renderDoc(s, imageUrl(s), qrSvg, 360 / SIZES[s.format].h)).join("\n");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Пресеты промо v2</title>
<!-- Сгенерировано design/art/src/promo-presets.mjs — правится там. -->
<style>
@font-face { font-family: "Russo One"; src: url("${fonts}/packages/app-shell/node_modules/@fontsource/russo-one/files/russo-one-cyrillic-400-normal.woff2") format("woff2"); unicode-range: U+0400-045F; }
@font-face { font-family: "Russo One"; src: url("${fonts}/packages/app-shell/node_modules/@fontsource/russo-one/files/russo-one-latin-400-normal.woff2") format("woff2"); unicode-range: U+0000-00FF, U+2000-206F; }
@font-face { font-family: "IBM Plex Sans"; font-weight: 100 700; src: url("${fonts}/apps/admin/node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-cyrillic-wght-normal.woff2") format("woff2"); unicode-range: U+0400-045F; }
@font-face { font-family: "IBM Plex Sans"; font-weight: 100 700; src: url("${fonts}/apps/admin/node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2") format("woff2"); unicode-range: U+0000-00FF, U+2000-206F; }
body{margin:0;background:#1d1c31;color:#f3eee6;font:15px/1.5 "IBM Plex Sans",system-ui}
main{display:flex;flex-wrap:wrap;gap:28px;padding:28px;align-items:flex-start}
h1{font:28px "Russo One",system-ui;margin:28px 28px 0}
p{margin:6px 28px 0;color:#aeaac4;max-width:70ch}
figure{margin:0;display:grid;gap:8px}
.frame{position:relative;overflow:hidden;border-radius:8px;box-shadow:0 0 0 1px #43425f}
.doc{position:absolute;left:0;top:0;transform-origin:0 0;background-size:cover}
.doc>*{position:absolute;margin:0;overflow:hidden}
figcaption{display:grid;font-size:13px;color:#aeaac4}
figcaption b{color:#f3eee6;font-weight:600}
</style></head><body>
<h1>Пресеты промо с артом</h1>
<p>Стартовые макеты «Промо» → «Пресеты» → «Новый пресет» (T-0275). Пример подстановки — как переключатель «С примером»: код «${SAMPLE.code}», награда «${SAMPLE.reward}».</p>
<main>
${cards}
</main></body></html>`;
}

async function main() {
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  const { chromium } = await import(pathToFileURL(path).href);
  const { renderSVG } = await import(pathToFileURL(join(ROOT, "apps/admin/node_modules/uqr/dist/index.mjs")).href);
  mkdirSync(STARTERS, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "promo-presets-"));
  const browser = await chromium.launch();
  const starters = [];
  try {
    for (const preset of PRESETS) {
      const bytes = await background(browser, preset, tmp);
      const image = `${preset.id}.webp`;
      writeFileSync(join(STARTERS, image), bytes);
      starters.push({
        id: preset.id,
        title: preset.title,
        format: preset.format,
        image,
        doc: { version: 1, format: preset.format, background: { media: sha256(bytes) }, palette: PALETTE, layers: preset.layers },
      });
      console.log(`${image} ${(bytes.length / 1024).toFixed(0)} КБ`);
    }
    writeFileSync(join(STARTERS, "presets.json"), `${JSON.stringify({ starters }, null, 2)}\n`);

    const qrSvg = renderSVG(SAMPLE.link, { border: 4, blackColor: C.sunken, whiteColor: C.text });
    const file = join(MOCKUPS, "promo-presets-v2.html");
    writeFileSync(file, mockup(starters, qrSvg));
    const p = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await p.goto(pathToFileURL(file).href);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(500);
    await p.screenshot({ path: join(OUT, "sheet-promo-presets.png"), fullPage: true });
    await p.close();
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
