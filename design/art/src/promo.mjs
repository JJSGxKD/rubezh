/**
 * Промо для рекламы (design/art/direction-v2.md §7.9): 1:1, 16:9, 21:9.
 * Ключевой арт собран из настоящих спрайтов игры — герой, орды Нави, элиты,
 * босс, обереги, кристаллы — на сумеречном небе с частоколом: реклама
 * обещает ровно то, что игрок увидит, а не нарисованное отдельно.
 *
 * Раскладка детерминирована (свой генератор с зерном): одинаковый запуск —
 * одинаковые картинки, и правка в одном месте видна в диффе снимков.
 *
 * Варианты для A/B — разные крючки на одном и том же хранителе (`VARIANTS`):
 * сила, награда, вызов. Облики, которых в игре нет, и английский текст при
 * русской игре в рекламу не идут: она обещает только то, что игрок увидит.
 *
 *   node design/art/src/promo.mjs
 * пишет `out/promo/promo-<формат>.png` (сила) и
 * `promo-<вариант>-<формат>.png`, и их HTML-макеты (`mockups/promo-*.html` —
 * правятся здесь, а не там).
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
import { PICKUPS } from "./pickups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../out/promo");
const MOCKUPS = join(HERE, "../mockups");

const FORMATS = {
  "1x1": { w: 1080, h: 1080 },
  "16x9": { w: 1920, h: 1080 },
  "21x9": { w: 2520, h: 1080 },
};

/**
 * Крючки A/B. Каждое обещание — то, что есть в игре: сундук падает с элиты,
 * оружие и навыки набираются за забег, бесконечный рубеж злеет с каждой
 * минутой. `density` — сколько орды от обычного, `extra` — что добавить в кадр.
 */
const VARIANTS = {
  power: { suffix: "", headline: "Держи рубеж, пока хватает сил", sub: "Оружие бьёт само — твоё дело не попасться.", density: 1, shift: 0, extra: null },
  reward: { suffix: "-reward", headline: "Сундук с элиты — и ты сильнее", sub: "Каждый забег — новое оружие и навыки.", density: 0.7, shift: 0.1, extra: "chest" },
  challenge: { suffix: "-challenge", headline: "Сколько продержишься ты?", sub: "Навь не кончается, и каждая минута злее.", density: 1.35, shift: 0, extra: "timer" },
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
  "1x1": { heroX: 0.3, heroH: 0.44, horizon: 0.5, horde: [0.42, 1.06], count: 70, boss: [0.84, 0.47, 0.3], text: "top", moon: false, chestDX: 0.29, timerX: 0.5 },
  "16x9": { heroX: 0.5, heroH: 0.46, horizon: 0.5, horde: [0.58, 1.04], count: 95, boss: [0.88, 0.44, 0.32], text: "left", moon: true, chestDX: 0.2, timerX: 0.63 },
  "21x9": { heroX: 0.5, heroH: 0.5, horizon: 0.5, horde: [0.58, 1.03], count: 120, boss: [0.9, 0.44, 0.34], text: "left", moon: true, chestDX: 0.17, timerX: 0.62 },
};

/**
 * Кадр формата. `opts` — для пресетов генератора (`promo-presets.mjs`):
 * `size` и `layout` — свой холст и раскладка, `seed` — своя толпа,
 * `text: false` — только мир, без знака и надписей: их ставит документ
 * пресета слоями поверх.
 */
export function page(format, variantId = "power", opts = {}) {
  const { w, h } = opts.size ?? FORMATS[format];
  const L = opts.layout ?? LAYOUT[format];
  const V = VARIANTS[variantId];
  const count = Math.round(L.count * V.density);
  const rand = rng(opts.seed ?? format.length * 7919 + 17);
  const horizonY = h * L.horizon;
  // Где кончается земля с толпой и масштаб спрайтов: на сторис толпа стоит
  // выше нижней плашки, а спрайты меряются шириной сцены, а не высотой холста.
  const floorY = (L.floor ?? 1) * h;
  const unit = L.unit ?? h / 1080;
  // Высота, от которой меряются частокол, луна и жар очага: по умолчанию — холст.
  const H = L.unit !== undefined ? L.unit * 1080 : h;
  const sprites = {};
  const use = (key, svg) => {
    sprites[key] = svg;
    return key;
  };
  const items = [];

  // Орда: глубина d — 0 у горизонта, 1 у нижнего края; ближние крупнее и светлее.
  for (let k = 0; k < count; k++) {
    let pick = rand();
    const kind = HORDE.find((x) => (pick -= x.share) < 0) ?? HORDE[0];
    const d = Math.pow(rand(), 0.8);
    const x = (L.horde[0] + V.shift + (L.horde[1] - L.horde[0] - V.shift) * Math.pow(rand(), 0.7)) * w;
    const y = horizonY + d * (floorY - horizonY) * 0.92 + 10;
    const stage = rand() < 0.2 ? 1 : 0;
    const key = use(`${kind.id}-${stage}-${k % 3}`, enemy(kind.id, stage, (k % 3) / 3).svg);
    const art = ENEMY_ART.find((a) => a.id === kind.id);
    const size = art.radius * 2 * 1.25 * (1.4 + d * 4.2) * unit * 1.9;
    items.push({ key, x, y, size, z: y, dim: 0.55 + d * 0.45, flip: false });
  }
  // Вороны — над толпой, крупные пятна на небе.
  for (let k = 0; k < Math.round(count / 10); k++) {
    const key = use(`crow-${k % 2}`, enemy("circler_crow", 0, k % 2 ? 0.5 : 0).svg);
    const x = (L.horde[0] + (L.horde[1] - L.horde[0]) * rand()) * w;
    const y = horizonY * (0.45 + rand() * 0.45);
    items.push({ key, x, y, size: 70 * unit * (0.8 + rand() * 0.6), z: y - 2000, dim: 0.8 });
  }
  // Элиты — ближе к герою, в золотой кайме.
  // У награды элиты уже пали: на месте ближней стоит сундук.
  const elites = V.extra === "chest" ? [] : [["elite_ghoul", 0.12, 0.62], ["elite_grave_knight", 0.2, 0.86]];
  for (const [id, dx, dd] of elites) {
    const key = use(id, enemy(id, 0, 0.3).svg);
    const art = ENEMY_ART.find((a) => a.id === id);
    const x = (L.heroX + dx + 0.06) * w;
    const y = horizonY + dd * (floorY - horizonY) * 0.9;
    items.push({ key, x, y, size: art.radius * 2 * 1.25 * (1.4 + dd * 4.2) * unit * 1.9, z: y, dim: 1 });
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
    const y = horizonY + (0.45 + rand() * 0.5) * (floorY - horizonY);
    fxItems.push({ key: gemKey, x, y, size: 34 * unit, z: y - 1 });
  }
  for (let k = 0; k < 12; k++) {
    const target = items[Math.floor(rand() * Math.min(items.length, count))];
    fxItems.push({ key: hitKey, x: target.x, y: target.y - target.size * 0.15, size: target.size * 0.9, z: target.z + 1, glow: true });
  }

  const heroH = h * L.heroH;
  const heroKey = use("hero", hero("keeper"));
  const heroX = L.heroX * w;
  const heroY = L.heroY !== undefined ? L.heroY * h : horizonY + (h - horizonY) * 0.62;
  const wardKey = use("ward", fx("orbiter_ward", 0));
  const sparkKey = use("spark", fx("proj_spark", 0));

  // Обереги кольцом вокруг героя и искры, летящие в орду.
  // Обереги — по бокам героя на разной высоте: кольцо в кадре сбоку, а не
  // значком на плаще.
  const wards = [[-0.5, -0.42], [0.52, -0.5], [-0.42, -0.1], [0.46, -0.06]].map(([dx, dy], k) => ({
    key: wardKey, x: heroX + dx * heroH, y: heroY + dy * heroH, size: heroH * 0.15, z: heroY + (k < 2 ? -5 : 5),
  }));
  const sparks = [0, 1, 2, 3, 4].map((k) => ({ key: sparkKey, x: heroX + heroH * (0.6 + k * 0.32), y: heroY - heroH * (0.46 - (k % 3) * 0.1), size: heroH * 0.16, z: 99999, rot: -8 + (k % 3) * 6, trail: true }));

  // Сундук с элиты — открытый, со столбом света, как на поле, и наградами
  // в медальонах, как в окне сундука.
  const extras = [];
  // Время забега, как в HUD, с короной рекорда, как на экране итогов.
  const crown = `<svg viewBox="0 0 24 24" style="width:.62em;height:.62em"><path d="M3 18.5h18l1-11-5.5 4.5L12 4.5 7.5 12 2 7.5z" fill="#ffd15c" stroke="#a8740f" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
  const timerInner = `${crown}12:47<span class="rec">рекорд</span>`;
  let under = "";
  let over = "";
  if (V.extra === "chest") {
    const chestKey = use("chest", PICKUPS.find((x) => x.id === "chest5").frames[1]);
    const size = heroH * 0.62;
    const cx = (L.heroX + L.chestDX) * w;
    const cy = horizonY + 0.66 * (h - horizonY) * 0.9;
    // Сундук — главное в кадре: впереди орды, а не за её спинами.
    extras.push({ key: chestKey, x: cx, y: cy, size, z: h * 2, dim: 1 });
    under = `<i class="beam" style="left:${(cx - size * 0.32).toFixed(1)}px;top:${(cy - h * 0.62).toFixed(1)}px;width:${(size * 0.64).toFixed(1)}px;height:${(h * 0.62).toFixed(1)}px"></i><i class="pool" style="left:${(cx - size).toFixed(1)}px;top:${(cy - size * 0.55).toFixed(1)}px;width:${(size * 2).toFixed(1)}px;height:${(size * 1.1).toFixed(1)}px"></i>`;
    const loot = ["proj_knife", "orbiter_ward", "proj_sting"];
    over = loot
      .map((id, k) => {
        const m = size * 0.42;
        // Дуга чуть вправо от сундука: слева стоит герой с посохом.
        const mx = cx + (k - 0.6) * m * 1.15;
        const my = cy - size * (1.05 + (k === 1 ? 0.22 : 0));
        return `<i class="medal" style="left:${(mx - m / 2).toFixed(1)}px;top:${(my - m / 2).toFixed(1)}px;width:${m.toFixed(1)}px;height:${m.toFixed(1)}px;background-image:url(${b64(fx(id, 0))})"></i>`;
      })
      .join("");
  } else if (V.extra === "timer" && L.text !== "top" && opts.text !== false) {
    over = `<div class="timer" style="position:absolute;left:${(L.timerX * w).toFixed(1)}px;top:${(0.08 * h).toFixed(1)}px;font-size:${(h * 0.075).toFixed(1)}px">${timerInner}</div>`;
  }

  const all = [...items, ...extras, ...fxItems, ...wards, ...sparks, { key: heroKey, x: heroX, y: heroY, size: heroH * 1.35, z: heroY, dim: 1, hero: true }].sort((a, b) => a.z - b.z);

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

  // В квадрате таймер — строкой между знаком и подписью: сбоку ему нет места.
  const timerRow = V.extra === "timer" ? `<div class="timer" style="display:inline-flex;transform:none;margin-top:${(h * 0.01).toFixed(1)}px;font-size:${(h * 0.062).toFixed(1)}px">${timerInner}</div>` : "";
  // Затемнение под надписи пресета: слои документа без тени, и текст поверх
  // частокола и толпы читается только на тёмном.
  const SHADE_DIR = { left: "90deg", top: "180deg", bottom: "0deg" };
  const shade = (L.shade ?? [])
    .map(({ side, extent }) => `<div style="position:absolute;inset:0;background:linear-gradient(${SHADE_DIR[side]},#0c0a16e0 0%,#0c0a16b3 ${(extent * 55).toFixed(0)}%,transparent ${(extent * 100).toFixed(0)}%)"></div>`)
    .join("");
  const text = opts.text === false ? "" : L.text === "top"
    ? `<div class="txt" style="left:0;right:0;top:${h * 0.04}px;text-align:center"><img class="wm" src="${b64(wm)}" style="width:${w * (timerRow === "" ? 0.62 : 0.5)}px">${timerRow}<div class="tag" style="font-size:${h * 0.036}px">${V.headline}</div></div>
       <div class="cta" style="left:50%;transform:translateX(-50%);bottom:${h * 0.05}px;font-size:${h * 0.04}px">Играть бесплатно — в Telegram</div>`
    : `<div class="txt" style="left:${w * 0.04}px;top:${h * 0.08}px;width:${w * (format === "21x9" ? 0.32 : 0.4)}px"><img class="wm" src="${b64(wm)}" style="width:100%"><div class="tag" style="font-size:${h * 0.036}px;text-align:left;margin-top:${h * 0.012}px">${V.headline}${/[.?!]$/.test(V.headline) ? "" : "."}<br><span style="color:#d7d2ea;font-size:.82em">${V.sub}</span></div><div class="cta" style="position:relative;display:inline-block;margin-top:${h * 0.035}px;font-size:${h * 0.04}px">Играть бесплатно — в Telegram</div></div>`;

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Промо ${format}</title>
<!-- Сгенерировано design/art/src/promo.mjs — правится там. -->
<style>
@font-face { font-family: "Russo One"; src: url("../../../packages/app-shell/node_modules/@fontsource/russo-one/files/russo-one-cyrillic-400-normal.woff2") format("woff2"); unicode-range: U+0400-045F; }
@font-face { font-family: "Russo One"; src: url("../../../packages/app-shell/node_modules/@fontsource/russo-one/files/russo-one-latin-400-normal.woff2") format("woff2"); unicode-range: U+0000-00FF, U+2000-206F; }
body{margin:0}
.art{position:relative;width:${w}px;height:${h}px;overflow:hidden;background:linear-gradient(180deg,#2a1d4a 0%,#3a2860 ${L.horizon * 45}%,#4b3470 ${L.horizon * 92}%,#2c475e ${L.horizon * 100}%,#2c475e 70%,#1d2c3c 100%);font-family:"Russo One",system-ui}
.moon{position:absolute;right:${w * 0.1}px;top:${H * 0.07}px;width:${H * 0.16}px;height:${H * 0.16}px;border-radius:50%;background:radial-gradient(circle at 40% 40%,#fff6e0,#f2d9b0 60%,#d9b98a);box-shadow:0 0 ${H * 0.08}px ${H * 0.03}px #ffe7b855}
.star{position:absolute;border-radius:50%;background:#fff}
.hearth{position:absolute;left:${L.heroX * w - H * 0.5}px;top:${horizonY - H * 0.25}px;width:${H}px;height:${H * 0.9}px;background:radial-gradient(closest-side,#ff8f3f66,#ff8f3f22 55%,transparent);}
.ground{position:absolute;left:0;right:0;top:${horizonY}px;bottom:0;background:radial-gradient(120% 90% at ${L.heroX * 100}% 30%,#3d5c74,#2c475e 55%,#1a2836)}
.stakes{position:absolute;left:0;right:0;top:${horizonY - H * 0.1}px;height:${H * 0.12}px;background:url(${b64(`<svg xmlns="http://www.w3.org/2000/svg" width="44" height="120"><path d="M2 120V30L22 4L42 30V120Z" fill="#120d20" stroke="#ff8f3f" stroke-opacity=".5" stroke-width="2"/></svg>`)}) repeat-x bottom/${H * 0.045}px ${H * 0.12}px}
.s{position:absolute;background-size:contain;background-repeat:no-repeat;background-position:center}
.trail{position:absolute;border-radius:99px;background:linear-gradient(90deg,transparent,#ffe7a3cc);filter:blur(2px);transform-origin:right center}
.beam{position:absolute;background:linear-gradient(0deg,#ffd15ccc,#ffd15c44 45%,transparent);filter:blur(6px);mix-blend-mode:screen;border-radius:40%}
.pool{position:absolute;border-radius:50%;background:radial-gradient(closest-side,#ffd15caa,#ffb22e44 55%,transparent);mix-blend-mode:screen}
.medal{position:absolute;z-index:4;border-radius:50%;background-color:#17162a;background-size:78%;background-repeat:no-repeat;background-position:center;box-shadow:0 0 0 .2em #ffd15c,0 0 0 .34em #7a4a33,0 0 1.2em .3em #ffd15c88;font-size:${unit * 16}px}
.timer{z-index:5;transform:translateX(-50%);display:flex;align-items:center;gap:.25em;padding:.12em .5em .1em;border-radius:.22em;color:#fff;background:#17162ae6;box-shadow:inset 0 0 0 .05em #ffd15c88,0 .2em .8em #000a;font-variant-numeric:tabular-nums;letter-spacing:.02em}
.timer .rec{color:#ffd15c;font-size:.32em;text-transform:uppercase;letter-spacing:.12em;align-self:flex-end;margin-bottom:.55em}
.vig{position:absolute;inset:0;background:radial-gradient(120% 100% at 50% 45%,transparent 55%,#0c0a16cc);pointer-events:none}
.txt{position:absolute;z-index:5;text-shadow:0 4px 14px #000a}
.wm{display:block;margin:0 auto;filter:drop-shadow(0 8px 20px #000a)}
.tag{color:#f3eee6;margin-top:6px}
.cta{position:absolute;z-index:5;padding:.55em 1.2em;border-radius:.4em;color:#230f02;background:linear-gradient(180deg,#ffd08f,#ff8f3f 45%,#f0782a);box-shadow:inset 0 -.18em 0 #a0582a,0 .3em 1.2em #000a,0 0 1.6em #ff8f3f66;white-space:nowrap}
${css}
</style></head><body><div class="art">
${L.moon ? '<div class="moon"></div>' : ""}${stars}<div class="hearth"></div><div class="ground"></div><div class="stakes"></div>
${under}${all.map(sprite).join("\n")}${over}
<div class="vig"></div>${shade}${text}
</div></body></html>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  const { chromium } = await import(pathToFileURL(path).href);
  const browser = await chromium.launch();
  for (const [variant, { suffix }] of Object.entries(VARIANTS)) {
    for (const [format, { w, h }] of Object.entries(FORMATS)) {
      const name = `promo${suffix}-${format}`;
      const file = join(MOCKUPS, `${name}.html`);
      writeFileSync(file, page(format, variant));
      const p = await browser.newPage({ viewport: { width: w, height: h } });
      await p.goto(pathToFileURL(file).href);
      await p.waitForTimeout(500);
      await p.screenshot({ path: join(OUT, `${name}.png`) });
      await p.close();
      console.log(`${name}.png`);
    }
  }
  await browser.close();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
