/**
 * Раскадровка пролога (design/art/backlog.md п. 9, Р151, T-0278…T-0280):
 * кадры телефона 320×568 из настоящих спрайтов игры, поверх — интерфейс
 * оболочки в облике v2 и тексты, которые T-0280 кладёт в словарь. Сцена —
 * схема (сколько врагов, где герой), интерфейс — как он должен выглядеть.
 *
 *   node design/art/src/prologue-board.mjs
 * пишет `mockups/prologue-v2.html` (правится здесь, а не там) и снимок
 * `out/preview/prologue-v2.png` для галереи.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { svgFrame } from "./build.mjs";
import { ENEMY_ART } from "./creatures.mjs";
import { FX } from "./fx.mjs";
import { HERO_SKINS, HERO_STATES, heroDefs, withHeroPalette } from "./hero.mjs";
import { runeMark, wordmark } from "./logo.mjs";
import { creaturePalette, enemyBody, enemyEye } from "./palette.mjs";
import { PICKUPS } from "./pickups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const MOCKUPS = join(HERE, "../mockups");
const OUT = join(HERE, "../out/preview");

const b64 = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/** Спрайты — те же функции, что у атласа: палитра v2, кайма ранга, свечение Нави. */
function enemySvg(id, t = 0.25) {
  const art = ENEMY_ART.find((a) => a.id === id);
  const palette = creaturePalette(enemyBody(art.pattern, art.rank, 0, art.id, 2), enemyEye(0, 2));
  return svgFrame(art.draw(t, palette), { rank: art.rank, radius: art.radius, style: "C", hostile: true, pad: art.pad });
}
const heroSvg = (state = "walk", k = 1) =>
  withHeroPalette(HERO_SKINS[0].palette, () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100"><defs>${heroDefs()}</defs>${HERO_STATES[state][k]()}</svg>`);
const fx = (id, k = 0) => FX.find((x) => x.id === id).frames[k];
const pickup = (id, k = 0) => PICKUPS.find((x) => x.id === id).frames[k];

/**
 * Размер спрайта на 320 стоя: 382 единицы мира на 320 точек (камера
 * `viewAreaIdle`, characters.md §2.3) — 0,84 точки на единицу. Кадр врага —
 * 1,75 радиуса на сторону и запас `pad`.
 */
const PX = 0.84;
const enemyPx = (id, size = 1) => {
  const art = ENEMY_ART.find((a) => a.id === id);
  return art.radius * 2 * 1.75 * (art.pad ?? 1) * size * PX;
};
const HERO_PX = 10 * 2 * 2.6 * PX;

const SPRITES = {
  hero: heroSvg(),
  rat: enemySvg("swarm_rat"),
  rat2: enemySvg("swarm_rat", 0.75),
  bone: enemySvg("bone_walker"),
  wolf: enemySvg("dasher_wolf"),
  elite: enemySvg("elite_ghoul"),
  chur: enemySvg("rubezh_guard"),
  gem: pickup("gem1"),
  gem2: pickup("gem2"),
  chest: pickup("chest3", 1),
  ward: fx("orbiter_ward"),
  spark: fx("proj_spark"),
  knife: fx("proj_knife"),
  hit: fx("hit", 1),
};

/** Детерминированный разброс: одна и та же раскладка при каждой сборке. */
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

const sprite = (key, x, y, size, extra = "") =>
  `<i class="sp s-${key}" style="left:${(x - size / 2).toFixed(1)}px;top:${(y - size * 0.62).toFixed(1)}px;width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;${extra}"></i>`;

/** Поле: герой в центре, враги вокруг на расстоянии — как камера стоя. */
function field({ seed, rats = 0, bones = 0, wolves = 0, gems = 0, elite = null, chur = false, hero = [160, 330], shield = false, hits = 0 }) {
  const rand = rng(seed);
  const items = [];
  const around = (n, key, minR, maxR, size) => {
    for (let k = 0; k < n; k++) {
      const a = rand() * Math.PI * 2;
      const r = minR + rand() * (maxR - minR);
      items.push({ key, x: hero[0] + Math.cos(a) * r * 1.0, y: hero[1] + Math.sin(a) * r * 1.25, size });
    }
  };
  around(gems, "gem", 26, 120, 13);
  around(rats, "rat", 90, 230, enemyPx("swarm_rat"));
  around(Math.ceil(rats / 3), "rat2", 110, 250, enemyPx("swarm_rat"));
  around(bones, "bone", 110, 230, enemyPx("bone_walker"));
  around(wolves, "wolf", 120, 240, enemyPx("dasher_wolf"));
  if (elite !== null) items.push({ key: "elite", x: elite[0], y: elite[1], size: enemyPx("elite_ghoul") });
  if (chur) items.push({ key: "chur", x: 214, y: 318, size: enemyPx("rubezh_guard", 2) });
  items.push({ key: "hero", x: hero[0], y: hero[1], size: HERO_PX * 1.35, hero: true });
  const wards = [-0.9, 0.9].map((dx) => ({ key: "ward", x: hero[0] + dx * 30, y: hero[1] - 8, size: 14 }));
  const hitFx = [];
  for (let k = 0; k < hits; k++) {
    const target = items[Math.floor(rand() * items.length)];
    if (!target.hero) hitFx.push({ key: "hit", x: target.x, y: target.y - 6, size: target.size * 0.9, glow: true });
  }
  const all = [...items, ...wards, ...hitFx].sort((a, b) => a.y - b.y);
  const sigil = `<i class="sigil" style="left:${hero[0] - 18}px;top:${hero[1] - 4}px"></i>`;
  const aegis = shield ? `<i class="aegis" style="left:${hero[0] - 30}px;top:${hero[1] - 40}px"></i>` : "";
  return `<div class="field">${sigil}${all.map((it) => sprite(it.key, it.x, it.y, it.size, it.glow ? "mix-blend-mode:screen;" : "")).join("")}${aegis}</div>`;
}

/** Верх HUD — как в забеге: здоровье, уровень, время, пауза, радар. */
function hud({ hp = 100, level = 1, time = "0:00", boss = null }) {
  const low = hp <= 30;
  const bar = boss === null ? "" : `<div class="boss"><div class="boss-name">${boss.name}<span>Фаза ${boss.phase}/3</span></div><div class="boss-bar"><i style="width:${boss.left}%"></i><b style="left:33.3%"></b><b style="left:66.6%"></b></div></div>`;
  return `<div class="hud"><div class="hp${low ? " low" : ""}"><span class="heart"></span><span>${hp}/100</span></div><div class="lvl">Уровень ${level}</div><div class="time">${time}</div><div class="pause"><i></i><i></i></div></div>${bar}<div class="radar"><i></i></div>`;
}

/** Подсказка — та же карточка, что `run.hint.*` сейчас: значок слева, текст. */
const hint = (text, icon = "steps") => `<div class="hint"><span class="hint-ico ${icon}"></span><p>${text}</p></div>`;
const loadout = (items) => `<div class="loadout">${items.map(([g, n]) => `<span><i class="g g-${g}"></i>${n}</span>`).join("")}</div>`;

function relic(title, body, { tone = "accent" } = {}) {
  return `<div class="veil"></div><div class="relic ${tone}"><div class="ribbon">${title}</div>${body}</div>`;
}

const card = (icon, name, line, { recommended = false, tag = "" } = {}) =>
  `<div class="card${recommended ? " rec" : ""}">${recommended ? '<span class="badge">Советуем</span>' : ""}<span class="medal" style="background-image:url(${b64(SPRITES[icon])})"></span><div><b>${name}</b>${tag !== "" ? `<em>${tag}</em>` : ""}<small>${line}</small></div></div>`;

const FRAMES = [
  {
    time: "0:00",
    title: "Начало без меню",
    step: "start",
    what: "«Играть» → сразу поле, без листа «Перед забегом». Строка поверх поля на 3 с, подсказка `move`.",
    body: () =>
      field({ seed: 1, rats: 4 }) +
      hud({ time: "0:01" }) +
      `<div class="banner">Навь идёт к рубежу.<br>Держи его</div>` +
      hint("Проведи пальцем по экрану — персонаж пойдёт следом. Оружие стреляет само.") +
      loadout([["spark", 1]]),
  },
  {
    time: "0:10",
    title: "Кристаллы",
    step: "first_gem",
    what: "Первый кристалл на поле — подсказка `gems`. Радиус сбора в прологе ×1,5: кристаллы летят сами.",
    body: () => field({ seed: 2, rats: 7, gems: 9, hits: 2 }) + hud({ time: "0:10", level: 1 }) + hint("Собирай кристаллы, которые остаются от врагов: за них растёт уровень.", "gem") + loadout([["spark", 1]]),
  },
  {
    time: "0:20",
    title: "Первый выбор — «Советуем»",
    step: "first_level",
    what: "Окно выбора как всегда; у карточки `recommended` — метка «Советуем» и светлая кайма. Выбор не навязан: любая карточка берётся одним касанием.",
    body: () =>
      field({ seed: 3, rats: 9, gems: 3 }) +
      hud({ time: "0:20", level: 2 }) +
      relic(
        "Уровень 2",
        `<p class="sub">Выбери улучшение</p>${card("knife", "Нож", "Веер снарядов по направлению движения", { recommended: true, tag: "новое оружие" })}${card("spark", "Искра", "урон 7 → 8")}${card("ward", "Мощь", "урон всего оружия +10 %")}<p class="tip">Выбери улучшение — «Советуем» подойдёт для начала</p>`,
      ),
  },
  {
    time: "0:40",
    title: "Оберег",
    step: null,
    what: "Урон не опускает здоровье ниже 25 %: вспышка щита на знаке под ногами (событие `ward`). Подсказка — один раз за пролог.",
    body: () =>
      field({ seed: 4, rats: 16, bones: 3, gems: 4, shield: true, hits: 3 }) +
      hud({ time: "0:41", level: 4, hp: 25 }) +
      hint("Оберег не даст пасть в первом бою.", "shield") +
      loadout([["spark", 2], ["knife", 1], ["might", 1]]),
  },
  {
    time: "1:15",
    title: "Первая элита",
    step: "first_elite",
    what: "Упырь-элита в золотой кайме — подсказка `dodge` с текстом пролога. Ударов по кругу у упыря нет (паттерн `chase`): совет — держать дистанцию.",
    body: () =>
      field({ seed: 5, rats: 14, bones: 4, gems: 3, elite: [236, 214], hits: 2 }) +
      hud({ time: "1:15", level: 6 }) +
      hint("Золотая кайма — элита: бьёт больнее. Держись на расстоянии — с неё упадёт сундук.", "elite") +
      loadout([["spark", 2], ["knife", 2], ["might", 1], ["haste", 1]]),
  },
  {
    time: "1:30",
    title: "Сундук с элиты",
    step: "first_chest",
    what: "Первый сундук пролога всегда на 3 награды (`firstChestSize`), окно сундука — как в обычном забеге.",
    body: () =>
      field({ seed: 6, rats: 10, gems: 6 }) +
      hud({ time: "1:31", level: 7 }) +
      relic(
        "Сундук",
        `<span class="chest" style="background-image:url(${b64(SPRITES.chest)})"></span><p class="sub">Улучшений: 3</p><div class="loot">${["knife", "spark", "ward"].map((k) => `<span class="medal big" style="background-image:url(${b64(SPRITES[k])})"></span>`).join("")}</div><p class="gain">Нож: снаряды 2 → 3 · Искра: урон 8 → 11 · Оберег</p><button class="cta">Забрать</button>`,
        { tone: "gold" },
      ),
  },
  {
    time: "2:40",
    title: "Страж рубежа",
    step: "guard",
    what: "Баннер «Страж рубежа!» (T-0124), полоса фаз. Здоровье Стража в прологе ×0,12 — бой на 30–40 с по силе набранного.",
    body: () =>
      field({ seed: 7, rats: 8, wolves: 2, chur: true, hits: 3, hero: [130, 420] }) +
      hud({ time: "2:41", level: 11, boss: { name: "Страж рубежа", phase: 1, left: 100 } }) +
      `<div class="banner boss-banner">Страж рубежа!</div>` +
      loadout([["spark", 3], ["knife", 3], ["ward", 1], ["might", 2], ["haste", 2]]),
  },
  {
    time: "3:04",
    title: "«Рубеж удержан!»",
    step: "won",
    what: "По `prologueWon` — окно-реликвия T-0232. Числа награды — из ответа записи забега; облик Знахарки — цель 10-го уровня, а не награда.",
    body: () =>
      field({ seed: 8, gems: 14 }) +
      relic(
        "Рубеж удержан!",
        `<span class="rune">${runeMark({ id: "pr", glow: false })}</span><p class="big-time">3:04</p><div class="rewards"><span class="coin">+500</span><span class="gemr">+10</span></div><p class="opened">Открыты <b>Награда дня</b> и <b>Задания</b></p><p class="goal">На 10-м уровне — облик Знахарки</p><button class="cta">На главную</button>`,
        { tone: "gold" },
      ),
  },
  {
    time: "до победы",
    title: "Сдаться в прологе",
    step: null,
    what: "«Сдаться» спрашивает по-другому; итог без окна смерти — сразу главная. Следующий «Играть» — снова пролог.",
    body: () =>
      field({ seed: 9, rats: 6, gems: 2 }) +
      hud({ time: "1:02", level: 5 }) +
      `<div class="veil"></div><div class="dialog"><h3>Сдаться?</h3><p>Пролог можно пройти позже — он начнётся заново.</p><button class="ghost">Нет, вернуться</button><button class="danger">Да, сдаться</button></div>`,
  },
  {
    time: "главная",
    title: "До победы",
    step: null,
    what: "Только «Играть» и строка. Виджетов награды дня и заданий, вкладки «Задания» нет; вход по ссылке на скрытый экран — эта же главная.",
    body: () => home({ before: true }),
  },
  {
    time: "главная",
    title: "После победы",
    step: null,
    what: "Виджеты на месте, у «Награды дня» и «Заданий» метка «Новое» до первого открытия. Подпись у «Играть» — до второго забега.",
    body: () => home({ before: false }),
  },
];

function home({ before }) {
  const wm = wordmark({ id: before ? "hb" : "ha", depth: 6, outline: 5, glow: false }).svg;
  const widgets = before
    ? ""
    : `<div class="widgets"><div class="widget"><span class="new">Новое</span><b>Награда дня</b><small>День 1 · забрать</small></div><div class="widget"><span class="new">Новое</span><b>Задания</b><small>0 из 3</small></div></div>`;
  const tabs = before ? ["Главная", "Арсенал", "Профиль"] : ["Главная", "Арсенал", "Задания", "Профиль"];
  return `<div class="home"><div class="sky"></div><img class="wm" src="${b64(wm)}" alt=""><div class="hero-big" style="background-image:url(${b64(SPRITES.hero)})"></div>${widgets}<button class="play">Играть</button><p class="play-line">${before ? "Первый бой — три минуты" : "Дальше — бесконечный рубеж: сколько продержишься?"}</p><nav class="tabs">${tabs.map((t, k) => `<span${k === 0 ? ' class="on"' : ""}>${t}</span>`).join("")}</nav></div>`;
}

function page() {
  const fonts = relative(MOCKUPS, ROOT);
  const css = Object.entries(SPRITES)
    .map(([k, svg]) => `.s-${k}{background-image:url(${b64(svg)})}`)
    .join("\n");
  const grass = b64(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path d="M10 50l2-9M14 51l-1-7M44 22l2-8M48 23l-1-6M30 60l1-6" stroke="#4d7186" stroke-width="2" stroke-linecap="round" opacity=".55"/></svg>`);
  const frames = FRAMES.map(
    (f, k) => `<figure><div class="phone">${f.body()}</div><figcaption><span class="num">${k + 1}</span><b>${f.title}</b><span class="when">${f.time} · ${f.step === null ? "без шага воронки" : `<code>tutorial_step: ${f.step}</code>`}</span><span>${f.what.replace(/`([^`]+)`/g, "<code>$1</code>")}</span></figcaption></figure>`,
  ).join("\n");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Пролог v2 — раскадровка</title>
<!-- Сгенерировано design/art/src/prologue-board.mjs — правится там. -->
<style>
@font-face { font-family: "Russo One"; src: url("${fonts}/packages/app-shell/node_modules/@fontsource/russo-one/files/russo-one-cyrillic-400-normal.woff2") format("woff2"); unicode-range: U+0400-045F; }
@font-face { font-family: "Russo One"; src: url("${fonts}/packages/app-shell/node_modules/@fontsource/russo-one/files/russo-one-latin-400-normal.woff2") format("woff2"); unicode-range: U+0000-00FF, U+2000-206F; }
@font-face { font-family: "IBM Plex Sans"; font-weight: 100 700; src: url("${fonts}/apps/admin/node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-cyrillic-wght-normal.woff2") format("woff2"); unicode-range: U+0400-045F; }
@font-face { font-family: "IBM Plex Sans"; font-weight: 100 700; src: url("${fonts}/apps/admin/node_modules/@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2") format("woff2"); unicode-range: U+0000-00FF, U+2000-206F; }
:root{--bg:#1d1c31;--surface:#28273f;--raised:#353452;--sunken:#17162a;--border:#43425f;--text:#f3eee6;--muted:#aeaac4;--accent:#ff8f3f;--accent-edge:#a0582a;--on-accent:#230f02;--gold:#ffd15c;--xp:#b6ff4a;--hp:#ff6f90;--danger:#ff5d5d;--ward:#46d9c6}
*{box-sizing:border-box}
body{margin:0;background:#12111f;color:var(--text);font:14px/1.4 "IBM Plex Sans",system-ui;padding:24px;width:2080px}
h1{font:26px/1.2 "Russo One";margin:0 0 6px}
.lead{color:var(--muted);max-width:120ch;margin:0 0 20px}
main{display:grid;grid-template-columns:repeat(6,320px);gap:28px 22px}
figure{margin:0;display:grid;gap:8px;align-content:start}
figcaption{display:grid;gap:3px;font-size:12.5px;color:var(--muted)}
figcaption b{color:var(--text);font:15px "Russo One"}
.num{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;background:var(--accent);color:var(--on-accent);font:13px "Russo One"}
.when{color:var(--gold)} code{font:11.5px ui-monospace,monospace;color:var(--muted)}
.phone{position:relative;width:320px;height:568px;overflow:hidden;border-radius:18px;box-shadow:0 0 0 1px #ffffff1c,0 18px 40px #0008;background:#2c475e}
.field{position:absolute;inset:0;background:url(${grass}) 0 0/64px 64px,radial-gradient(90% 70% at 50% 55%,#3d5c74,#2c475e 60%,#1d3040)}
.sp{position:absolute;background-size:contain;background-repeat:no-repeat;background-position:center}
.sigil{position:absolute;width:36px;height:12px;border-radius:50%;box-shadow:0 0 0 2px #ff6f9099;background:#ff6f9022}
.aegis{position:absolute;width:60px;height:60px;border-radius:50%;background:radial-gradient(closest-side,#46d9c600 55%,#46d9c6aa 80%,#c9fff600);box-shadow:0 0 22px 4px #46d9c688}
${css}
.hud{position:absolute;left:10px;right:10px;top:10px;display:grid;grid-template-columns:auto 1fr auto auto;align-items:start;gap:6px}
.hp{display:flex;align-items:center;gap:5px;font:600 12.5px "IBM Plex Sans";color:#d9d4e8}
.hp .heart{width:16px;height:14px;background:var(--hp);clip-path:path("M8 14L1.5 7.5A4 4 0 0 1 8 2.5A4 4 0 0 1 14.5 7.5Z")}
.hp.low span:last-child{color:var(--danger)}
.lvl{grid-column:1;grid-row:2;justify-self:start;padding:2px 7px;border-radius:5px;background:#3c5a2a;color:var(--xp);font:12px "Russo One"}
.time{grid-column:2;grid-row:1/3;justify-self:center;padding:4px 14px;border-radius:12px;background:#17162ae6;font:22px "Russo One";box-shadow:inset 0 0 0 1px #ffffff14}
.pause{grid-column:4;grid-row:1/3;width:40px;height:40px;border-radius:50%;background:#17162ae6;display:flex;gap:5px;align-items:center;justify-content:center}
.pause i{width:5px;height:15px;border-radius:2px;background:var(--muted)}
.radar{position:absolute;right:10px;top:64px;width:66px;height:66px;border-radius:50%;background:#17162acc;box-shadow:inset 0 0 0 1px #ffffff1c}
.radar i{position:absolute;left:30px;top:30px;width:6px;height:6px;border-radius:50%;background:var(--xp)}
.boss{position:absolute;left:12px;right:12px;top:58px}
.boss-name{display:flex;justify-content:space-between;font:12px "Russo One";color:var(--gold)}
.boss-name span{color:var(--muted);font:600 11px "IBM Plex Sans"}
.boss-bar{position:relative;height:9px;margin-top:3px;border-radius:5px;background:#00000066;box-shadow:inset 0 0 0 1px #ffd15c88}
.boss-bar i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#ff8f3f,#ffd15c)}
.boss-bar b{position:absolute;top:-2px;width:2px;height:13px;background:#17162a}
.boss ~ .radar{top:92px}
.banner{position:absolute;left:0;right:0;top:150px;padding:12px 10px;text-align:center;font:24px/1.15 "Russo One";color:var(--text);text-shadow:0 3px 10px #000c;background:linear-gradient(90deg,transparent,#17162ad0 18%,#17162ad0 82%,transparent)}
.boss-banner{color:var(--gold);font-size:28px;top:128px}
.hint{position:absolute;left:10px;right:10px;bottom:56px;display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:12px;background:#28273ff2;box-shadow:inset 0 0 0 1px #ffffff1a,0 6px 18px #0009}
.hint p{margin:0;font:13.5px/1.35 "IBM Plex Sans";color:var(--text)}
.hint-ico{flex:none;width:34px;height:34px;border-radius:8px;background:#ff8f3f2e;position:relative}
.hint-ico::after{content:"";position:absolute;inset:8px;border-radius:4px;background:var(--accent)}
.hint-ico.gem::after{inset:10px;transform:rotate(45deg);background:var(--xp);border-radius:2px}
.hint-ico.shield::after{inset:7px;border-radius:50% 50% 45% 45%;background:var(--ward)}
.hint-ico.elite::after{inset:8px;border-radius:50%;background:transparent;box-shadow:inset 0 0 0 3px var(--gold)}
.loadout{position:absolute;left:10px;right:10px;bottom:12px;display:flex;gap:5px;flex-wrap:wrap}
.loadout span{display:flex;align-items:center;gap:4px;padding:3px 7px;border-radius:6px;background:#17162ae6;box-shadow:inset 0 0 0 1px #ffffff1a;font:12px "Russo One";color:var(--text)}
.g{width:12px;height:12px;border-radius:3px;background:var(--gold)}
.g-knife{background:#c9d4e8}.g-ward{background:var(--ward);border-radius:50%}.g-might{background:#c47dff}.g-haste{background:#c47dff;border-radius:50%}
.veil{position:absolute;inset:0;background:#0c0a16a8}
.relic{position:absolute;left:14px;right:14px;top:96px;padding:30px 14px 16px;border-radius:14px;background:linear-gradient(180deg,#2b2944,#1f1d33);box-shadow:0 0 0 2px var(--accent-edge),0 0 0 4px #ff8f3f55,0 18px 40px #000b;text-align:center}
.relic.gold{box-shadow:0 0 0 2px #a8740f,0 0 0 4px #ffd15c66,0 0 40px #ffd15c33,0 18px 40px #000b}
.ribbon{position:absolute;left:24px;right:24px;top:-18px;padding:7px 8px;font:19px "Russo One";color:var(--on-accent);background:linear-gradient(180deg,#ffd08f,#ff8f3f);clip-path:polygon(0 0,100% 0,96% 50%,100% 100%,0 100%,4% 50%)}
.relic.gold .ribbon{background:linear-gradient(180deg,#ffe9a8,#ffd15c)}
.sub{margin:0 0 10px;color:var(--muted);font:600 12.5px "IBM Plex Sans"}
.card{position:relative;display:flex;gap:10px;align-items:center;text-align:left;margin-top:8px;padding:10px;border-radius:10px;background:#17162a;box-shadow:inset 0 0 0 1px #ffffff17}
.card b{display:block;font:15px "Russo One"} .card small{display:block;color:var(--muted);font-size:12px;line-height:1.3}
.card em{display:inline-block;margin:2px 0;font:normal 600 10.5px "IBM Plex Sans";letter-spacing:.06em;text-transform:uppercase;color:var(--gold)}
.card.rec{box-shadow:inset 0 0 0 2px var(--accent),0 0 18px #ff8f3f55;background:#241c2e}
.badge{position:absolute;right:8px;top:-9px;padding:2px 8px;border-radius:6px;background:var(--accent);color:var(--on-accent);font:11px "Russo One"}
.medal{flex:none;width:44px;height:44px;border-radius:50%;background-color:#0f0e1c;background-size:70%;background-repeat:no-repeat;background-position:center;box-shadow:0 0 0 2px #ffd15c,0 0 0 4px #7a4a33}
.medal.big{width:58px;height:58px}
.tip{margin:12px 0 0;color:var(--text);font:600 12.5px "IBM Plex Sans"}
.chest{display:block;width:96px;height:96px;margin:-6px auto 2px;background-size:contain;background-repeat:no-repeat;background-position:center;filter:drop-shadow(0 0 16px #ffd15c88)}
.loot{display:flex;gap:16px;justify-content:center;margin:6px 0 10px}
.gain{margin:0 0 12px;color:var(--muted);font-size:12px}
.cta{width:100%;padding:13px;border:0;border-radius:10px;font:18px "Russo One";text-transform:uppercase;color:var(--on-accent);background:linear-gradient(180deg,#ffd08f,#ff8f3f 45%,#f0782a);box-shadow:inset 0 -3px 0 #a0582a}
.rune{display:block;width:62px;margin:0 auto}
.big-time{margin:4px 0 6px;font:40px "Russo One"}
.rewards{display:flex;gap:18px;justify-content:center;margin-bottom:10px;font:22px "Russo One"}
.rewards span{display:flex;align-items:center;gap:6px}
.coin::before{content:"";width:18px;height:18px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#fff16a,#ffd400 55%,#b45f00)}
.gemr::before{content:"";width:15px;height:15px;transform:rotate(45deg);background:linear-gradient(135deg,#ffc9cc,#ff515e 55%,#9e1020)}
.opened{margin:0 0 4px;font-size:13px} .opened b{color:var(--gold)}
.goal{margin:0 0 14px;color:var(--muted);font-size:12.5px}
.dialog{position:absolute;left:24px;right:24px;top:170px;padding:18px;border-radius:14px;background:var(--surface);box-shadow:0 0 0 1px #ffffff1c,0 18px 40px #000b;text-align:center}
.dialog h3{margin:0 0 8px;font:20px "Russo One"} .dialog p{margin:0 0 14px;color:var(--muted);font-size:13.5px}
.dialog button{display:block;width:100%;margin-top:8px;padding:11px;border-radius:10px;font:15px "Russo One";border:0}
.ghost{background:var(--raised);color:var(--text)} .danger{background:#3a1c26;color:#ff8a9a;box-shadow:inset 0 0 0 1px #ff5d5d66}
.home{position:absolute;inset:0;background:radial-gradient(120% 70% at 50% 0%,#3b2a55,#1d1c31 60%);text-align:center}
.home .sky{position:absolute;left:0;right:0;top:0;height:260px;background:radial-gradient(50% 40% at 50% 92%,#ff8f3f33,transparent 70%)}
.home .wm{position:relative;width:200px;margin-top:40px}
.hero-big{position:relative;width:150px;height:150px;margin:18px auto 0;background-size:contain;background-repeat:no-repeat;background-position:center}
.widgets{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 14px 0}
.widget{position:relative;padding:10px;border-radius:10px;background:var(--surface);box-shadow:inset 0 0 0 1px #ffffff17;text-align:left}
.widget b{display:block;font:14px "Russo One"} .widget small{color:var(--muted);font-size:12px}
.new{position:absolute;right:6px;top:-8px;padding:1px 7px;border-radius:6px;background:var(--xp);color:#1a2a06;font:10.5px "Russo One"}
.play{position:relative;display:block;width:calc(100% - 28px);margin:14px auto 0;padding:15px;border:0;border-radius:12px;font:22px "Russo One";text-transform:uppercase;color:var(--on-accent);background:linear-gradient(180deg,#ffd08f,#ff8f3f 45%,#f0782a);box-shadow:inset 0 -4px 0 #a0582a,0 0 26px #ff8f3f55}
.play-line{position:relative;margin:8px 20px 0;color:var(--muted);font-size:13px}
.tabs{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-around;padding:10px 6px 14px;background:#17162af0;box-shadow:0 -1px 0 #ffffff14;font:600 11.5px "IBM Plex Sans";color:var(--muted)}
.tabs .on{color:var(--accent)}
</style></head><body>
<h1>Пролог v2 — раскадровка</h1>
<p class="lead">Первый забег нового аккаунта (Р151, T-0278…T-0280): три минуты без меню, подсказки по одной по событию, «Советуем» на первом выборе, оберег вместо смерти, сундук с элиты, Страж рубежа и окно «Рубеж удержан!». Поле — схема из настоящих спрайтов в масштабе 320 стоя; интерфейс и тексты — как должно быть. Под кадром — шаг воронки <code>tutorial_step</code> из T-0280.</p>
<main>
${frames}
</main></body></html>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const file = join(MOCKUPS, "prologue-v2.html");
  writeFileSync(file, page());
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  const { chromium } = await import(pathToFileURL(path).href);
  const browser = await chromium.launch();
  const p = await browser.newPage({ viewport: { width: 2128, height: 900 } });
  await p.goto(pathToFileURL(file).href);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(400);
  await p.screenshot({ path: join(OUT, "prologue-v2.png"), fullPage: true });
  await browser.close();
  console.log("mockups/prologue-v2.html, out/preview/prologue-v2.png");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
