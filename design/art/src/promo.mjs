/**
 * Промо для рекламы (design/art/direction-v2.md §7.9): 1:1, 16:9, 21:9.
 * Ключевой арт собран из настоящих спрайтов игры — герой, орды Нави, элиты,
 * босс, обереги, кристаллы — на сумеречном небе с частоколом: реклама
 * обещает ровно то, что игрок увидит, а не нарисованное отдельно.
 *
 * Раскладка детерминирована (свой генератор с зерном): одинаковый запуск —
 * одинаковые картинки, и правка в одном месте видна в диффе снимков.
 *
 *   node design/art/src/promo.mjs
 * пишет `out/promo/promo-1x1.png`, `promo-16x9.png`, `promo-21x9.png` и их
 * HTML-макеты (`mockups/promo-*.html` — правятся здесь, а не там).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { svgFrame } from "./build.mjs";
import { ENEMY_ART } from "./creatures.mjs";
import { FX } from "./fx.mjs";
import { HERO_SKINS, HERO_STATES, heroDefs, withHeroPalette } from "./hero.mjs";
import { wordmark } from "./logo.mjs";
import { creaturePalette, enemyBody, enemyEye } from "./palette.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../out/promo");
const MOCKUPS = join(HERE, "../mockups");

const FORMATS = {
  "1x1": { w: 1080, h: 1080 },
  "16x9": { w: 1920, h: 1080 },
  "21x9": { w: 2520, h: 1080 },
};

const b64 = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Спрайт врага кадром атласа: та же палитра v2 и свечение Нави, что в игре. */
function enemy(id, stage = 0, t = 0) {
  const art = ENEMY_ART.find((a) => a.id === id);
  const palette = creaturePalette(enemyBody(art.pattern, art.rank, stage, art.id, 2), enemyEye(stage, 2));
  return { svg: svgFrame(art.draw(t, palette), { rank: art.rank, radius: art.radius, style: "C", hostile: true }), radius: art.radius };
}

function hero(skinId, state = "walk", frame = 1) {
  const skin = HERO_SKINS.find((s) => s.id === skinId);
  return withHeroPalette(skin.palette, () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100"><defs>${heroDefs()}</defs>${HERO_STATES[state][frame]()}</svg>`);
}

const fx = (id, k = 0) => FX.find((x) => x.id === id).frames[k];

/** Состав орды: доля и разброс глубины. Крысы — масса, элиты — ближе к герою. */
const HORDE = [
  { id: "swarm_rat", share: 0.42 },
  { id: "mire_shambler", share: 0.12 },
  { id: "tank_ghoul", share: 0.14 },
  { id: "bone_walker", share: 0.1 },
  { id: "dasher_wolf", share: 0.12 },
  { id: "bomber_imp", share: 0.1 },
];

/**
 * Раскладка формата: где герой, где орда, где текст. Координаты — доли
 * ширины и высоты; орда растёт из глубины справа и обходит героя.
 */
const LAYOUT = {
  "1x1": { heroX: 0.3, heroH: 0.44, horizon: 0.5, horde: [0.42, 1.06], count: 70, boss: [0.84, 0.47, 0.3], text: "top", moon: false },
  "16x9": { heroX: 0.5, heroH: 0.46, horizon: 0.5, horde: [0.58, 1.04], count: 95, boss: [0.88, 0.44, 0.32], text: "left", moon: true },
  "21x9": { heroX: 0.5, heroH: 0.5, horizon: 0.5, horde: [0.58, 1.03], count: 120, boss: [0.9, 0.44, 0.34], text: "left", moon: true },
};

function page(format) {
  const { w, h } = FORMATS[format];
  const L = LAYOUT[format];
  const rand = rng(format.length * 7919 + 17);
  const horizonY = h * L.horizon;
  const sprites = {};
  const use = (key, svg) => {
    sprites[key] = svg;
    return key;
  };
  const items = [];

  // Орда: глубина d — 0 у горизонта, 1 у нижнего края; ближние крупнее и светлее.
  for (let k = 0; k < L.count; k++) {
    let pick = rand();
    const kind = HORDE.find((x) => (pick -= x.share) < 0) ?? HORDE[0];
    const d = Math.pow(rand(), 0.8);
    const x = (L.horde[0] + (L.horde[1] - L.horde[0]) * Math.pow(rand(), 0.7)) * w;
    const y = horizonY + d * (h - horizonY) * 0.92 + 10;
    const stage = rand() < 0.2 ? 1 : 0;
    const key = use(`${kind.id}-${stage}-${k % 3}`, enemy(kind.id, stage, (k % 3) / 3).svg);
    const art = ENEMY_ART.find((a) => a.id === kind.id);
    const size = art.radius * 2 * 1.25 * (1.4 + d * 4.2) * (h / 1080) * 1.9;
    items.push({ key, x, y, size, z: y, dim: 0.55 + d * 0.45, flip: false });
  }
  // Вороны — над толпой, крупные пятна на небе.
  for (let k = 0; k < Math.round(L.count / 10); k++) {
    const key = use(`crow-${k % 2}`, enemy("circler_crow", 0, k % 2 ? 0.5 : 0).svg);
    const x = (L.horde[0] + (L.horde[1] - L.horde[0]) * rand()) * w;
    const y = horizonY * (0.45 + rand() * 0.45);
    items.push({ key, x, y, size: 70 * (h / 1080) * (0.8 + rand() * 0.6), z: y - 2000, dim: 0.8 });
  }
  // Элиты — ближе к герою, в золотой кайме.
  const elites = [["elite_ghoul", 0.12, 0.62], ["elite_grave_knight", 0.2, 0.86]];
  for (const [id, dx, dd] of elites) {
    const key = use(id, enemy(id, 0, 0.3).svg);
    const art = ENEMY_ART.find((a) => a.id === id);
    const x = (L.heroX + dx + 0.06) * w;
    const y = horizonY + dd * (h - horizonY) * 0.9;
    items.push({ key, x, y, size: art.radius * 2 * 1.25 * (1.4 + dd * 4.2) * (h / 1080) * 1.9, z: y, dim: 1 });
  }
  // Босс — силуэт в глубине справа, крупно.
  const bossKey = use("boss", enemy("boss_matryoshka", 0, 0.2).svg);
  items.push({ key: bossKey, x: L.boss[0] * w, y: L.boss[1] * h + h * 0.14, size: h * L.boss[2] * 1.6, z: L.boss[1] * h, dim: 0.85 });

  // Кристаллы опыта у ног героя и вспышки попаданий в толпе.
  const gemKey = use("gem", fx("twinkle", 1));
  const hitKey = use("hit", fx("hit", 1));
  const fxItems = [];
  for (let k = 0; k < 18; k++) {
    const x = (L.heroX + (rand() - 0.2) * 0.3) * w;
    const y = horizonY + (0.45 + rand() * 0.5) * (h - horizonY);
    fxItems.push({ key: gemKey, x, y, size: 34 * (h / 1080), z: y - 1 });
  }
  for (let k = 0; k < 12; k++) {
    const target = items[Math.floor(rand() * Math.min(items.length, L.count))];
    fxItems.push({ key: hitKey, x: target.x, y: target.y - target.size * 0.15, size: target.size * 0.9, z: target.z + 1, glow: true });
  }

  const heroH = h * L.heroH;
  const heroKey = use("hero", hero("keeper"));
  const heroX = L.heroX * w;
  const heroY = horizonY + (h - horizonY) * 0.62;
  const wardKey = use("ward", fx("orbiter_ward", 0));
  const sparkKey = use("spark", fx("proj_spark", 0));

  // Обереги кольцом вокруг героя и искры, летящие в орду.
  // Обереги — по бокам героя на разной высоте: кольцо в кадре сбоку, а не
  // значком на плаще.
  const wards = [[-0.5, -0.42], [0.52, -0.5], [-0.42, -0.1], [0.46, -0.06]].map(([dx, dy], k) => ({
    key: wardKey, x: heroX + dx * heroH, y: heroY + dy * heroH, size: heroH * 0.15, z: heroY + (k < 2 ? -5 : 5),
  }));
  const sparks = [0, 1, 2, 3, 4].map((k) => ({ key: sparkKey, x: heroX + heroH * (0.6 + k * 0.32), y: heroY - heroH * (0.46 - (k % 3) * 0.1), size: heroH * 0.16, z: 99999, rot: -8 + (k % 3) * 6, trail: true }));

  const all = [...items, ...fxItems, ...wards, ...sparks, { key: heroKey, x: heroX, y: heroY, size: heroH * 1.35, z: heroY, dim: 1, hero: true }].sort((a, b) => a.z - b.z);

  const wm = wordmark({ id: `p${format}` }).svg;
  const css = Object.entries(sprites)
    .map(([key, svg]) => `.s-${key}{background-image:url(${b64(svg)})}`)
    .join("\n");
  const sprite = (it) => {
    const style = `left:${(it.x - it.size / 2).toFixed(1)}px;top:${(it.y - it.size * (it.hero ? 0.78 : 0.62)).toFixed(1)}px;width:${it.size.toFixed(1)}px;height:${it.size.toFixed(1)}px;${it.dim !== undefined && it.dim < 1 ? `filter:brightness(${it.dim.toFixed(2)});` : ""}${it.rot ? `transform:rotate(${it.rot}deg);` : ""}${it.glow ? "mix-blend-mode:screen;" : ""}`;
    // Искра со шлейфом: снаряд летит, а не висит.
    const trail = it.trail ? `<i class="trail" style="left:${(it.x - it.size * 2.2).toFixed(1)}px;top:${(it.y - it.size * 0.12).toFixed(1)}px;width:${(it.size * 2).toFixed(1)}px;height:${(it.size * 0.24).toFixed(1)}px;${it.rot ? `transform:rotate(${it.rot}deg);` : ""}"></i>` : "";
    return `${trail}<i class="s s-${it.key}" style="${style}"></i>`;
  };

  const stars = Array.from({ length: Math.round(w / 18) }, () => {
    const r = rand() < 0.15 ? 3 : 1.6;
    return `<i class="star" style="left:${(rand() * w).toFixed(0)}px;top:${(rand() * horizonY * 0.8).toFixed(0)}px;width:${r}px;height:${r}px;opacity:${(0.4 + rand() * 0.5).toFixed(2)}"></i>`;
  }).join("");

  const text = L.text === "top"
    ? `<div class="txt" style="left:0;right:0;top:${h * 0.04}px;text-align:center"><img class="wm" src="${b64(wm)}" style="width:${w * 0.62}px"><div class="tag" style="font-size:${h * 0.036}px">Держи рубеж, пока хватает сил</div></div>
       <div class="cta" style="left:50%;transform:translateX(-50%);bottom:${h * 0.05}px;font-size:${h * 0.04}px">Играть бесплатно — в Telegram</div>`
    : `<div class="txt" style="left:${w * 0.04}px;top:${h * 0.08}px;width:${w * (format === "21x9" ? 0.32 : 0.4)}px"><img class="wm" src="${b64(wm)}" style="width:100%"><div class="tag" style="font-size:${h * 0.036}px;text-align:left;margin-top:${h * 0.012}px">Держи рубеж, пока хватает сил.<br><span style="color:#d7d2ea;font-size:.82em">Оружие бьёт само — твоё дело не попасться.</span></div><div class="cta" style="position:relative;display:inline-block;margin-top:${h * 0.035}px;font-size:${h * 0.04}px">Играть бесплатно — в Telegram</div></div>`;

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Промо ${format}</title>
<!-- Сгенерировано design/art/src/promo.mjs — правится там. -->
<style>
@font-face { font-family: "Russo One"; src: url("../../../packages/app-shell/node_modules/@fontsource/russo-one/files/russo-one-cyrillic-400-normal.woff2") format("woff2"); unicode-range: U+0400-045F; }
@font-face { font-family: "Russo One"; src: url("../../../packages/app-shell/node_modules/@fontsource/russo-one/files/russo-one-latin-400-normal.woff2") format("woff2"); unicode-range: U+0000-00FF, U+2000-206F; }
body{margin:0}
.art{position:relative;width:${w}px;height:${h}px;overflow:hidden;background:linear-gradient(180deg,#2a1d4a 0%,#3a2860 ${L.horizon * 45}%,#4b3470 ${L.horizon * 92}%,#2c475e ${L.horizon * 100}%,#2c475e 70%,#1d2c3c 100%);font-family:"Russo One",system-ui}
.moon{position:absolute;right:${w * 0.1}px;top:${h * 0.07}px;width:${h * 0.16}px;height:${h * 0.16}px;border-radius:50%;background:radial-gradient(circle at 40% 40%,#fff6e0,#f2d9b0 60%,#d9b98a);box-shadow:0 0 ${h * 0.08}px ${h * 0.03}px #ffe7b855}
.star{position:absolute;border-radius:50%;background:#fff}
.hearth{position:absolute;left:${L.heroX * w - h * 0.5}px;top:${horizonY - h * 0.25}px;width:${h}px;height:${h * 0.9}px;background:radial-gradient(closest-side,#ff8f3f66,#ff8f3f22 55%,transparent);}
.ground{position:absolute;left:0;right:0;top:${horizonY}px;bottom:0;background:radial-gradient(120% 90% at ${L.heroX * 100}% 30%,#3d5c74,#2c475e 55%,#1a2836)}
.stakes{position:absolute;left:0;right:0;top:${horizonY - h * 0.1}px;height:${h * 0.12}px;background:url(${b64(`<svg xmlns="http://www.w3.org/2000/svg" width="44" height="120"><path d="M2 120V30L22 4L42 30V120Z" fill="#120d20" stroke="#ff8f3f" stroke-opacity=".5" stroke-width="2"/></svg>`)}) repeat-x bottom/${h * 0.045}px ${h * 0.12}px}
.s{position:absolute;background-size:contain;background-repeat:no-repeat;background-position:center}
.trail{position:absolute;border-radius:99px;background:linear-gradient(90deg,transparent,#ffe7a3cc);filter:blur(2px);transform-origin:right center}
.vig{position:absolute;inset:0;background:radial-gradient(120% 100% at 50% 45%,transparent 55%,#0c0a16cc);pointer-events:none}
.txt{position:absolute;z-index:5;text-shadow:0 4px 14px #000a}
.wm{display:block;margin:0 auto;filter:drop-shadow(0 8px 20px #000a)}
.tag{color:#f3eee6;margin-top:6px}
.cta{position:absolute;z-index:5;padding:.55em 1.2em;border-radius:.4em;color:#230f02;background:linear-gradient(180deg,#ffd08f,#ff8f3f 45%,#f0782a);box-shadow:inset 0 -.18em 0 #a0582a,0 .3em 1.2em #000a,0 0 1.6em #ff8f3f66;white-space:nowrap}
${css}
</style></head><body><div class="art">
${L.moon ? '<div class="moon"></div>' : ""}${stars}<div class="hearth"></div><div class="ground"></div><div class="stakes"></div>
${all.map(sprite).join("\n")}
<div class="vig"></div>${text}
</div></body></html>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  const { chromium } = await import(pathToFileURL(path).href);
  const browser = await chromium.launch();
  for (const [format, { w, h }] of Object.entries(FORMATS)) {
    const file = join(MOCKUPS, `promo-${format}.html`);
    writeFileSync(file, page(format));
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    await p.goto(pathToFileURL(file).href);
    await p.waitForTimeout(500);
    await p.screenshot({ path: join(OUT, `promo-${format}.png`) });
    await p.close();
    console.log(`promo-${format}.png`);
  }
  await browser.close();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
