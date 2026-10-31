/**
 * Значки знаков у имени (Р149, п. 11 и 18 очереди дизайнера) и знаков мира
 * для эволюций и «Метеора» (п. 3) — тем же языком, что значки оружия
 * (`packages/app-shell/src/screens/game-glyphs.tsx`): сетка 24, контур 2,
 * слои `f` — заливка тоном с контуром, `d` — сплошная деталь, `s` — линия,
 * `s3` — толстая линия.
 *
 *   node design/art/src/emblem-glyphs.mjs
 *
 * Пишет packages/app-shell/src/screens/meta/emblem-glyphs.tsx (карта знаков)
 * и лист design/art/mockups/emblems-v2.html. Значки эволюций переносятся в
 * WEAPON_GLYPHS руками: там они живут рядом с базовым оружием.
 *
 * Знак читается на 16 px в строке рейтинга, поэтому у каждого — одна главная
 * форма и не больше одной детали; мелкое теряется первым.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");

/**
 * Повернуть путь из абсолютных команд M, L, Q, C, Z вокруг центра сетки:
 * три одинаковых лезвия «Вихря» рисуются одним, а не тремя от руки.
 */
function rotate(d, degrees) {
  const a = (degrees * Math.PI) / 180;
  const round = (n) => Math.round(n * 10) / 10;
  const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+/g) ?? [];
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i];
    if (/[MLQCZ]/.test(token)) {
      out.push(token);
      i++;
      continue;
    }
    const x = Number(token) - 12;
    const y = Number(tokens[i + 1]) - 12;
    out.push(`${round(12 + x * Math.cos(a) - y * Math.sin(a))} ${round(12 + x * Math.sin(a) + y * Math.cos(a))}`);
    i += 2;
  }
  return out.join(" ").replace(/ ?([MLQCZ]) ?/g, "$1");
}

const BLADE = "M13.3 10.7Q14.5 5.5 19.5 4.5Q18.5 9.5 13.8 12.2Z";

/** Значки эволюций и «Метеора» для WEAPON_GLYPHS: связаны с базовым оружием, но «выросли». */
export const EVOLUTION_GLYPHS = {
  // «Метеор» — камень с огненным хвостом; «Ливень» — три камня поменьше.
  meteor: [["f", "M15 9.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z"], ["s", "M3 3l7.5 7.5M7 2.5l4.5 4.5M2.5 7l4.5 4.5"], ["d", "M14.3 13.2a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"]],
  fire_rain: [["d", "M9 7a2.3 2.3 0 1 0 0 4.6A2.3 2.3 0 0 0 9 7zM17 10.5a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6zM10.5 16.5a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z"], ["s", "M3 3.5l4.3 4.3M11 7l4.3 4.3M4.5 13l4.3 4.3"]],
  // «Звездопад» — искра «Искры» и следы падающих звёзд.
  starfall: [["f", "M15.5 3l1.4 4.1L21 8.5l-4.1 1.4L15.5 14l-1.4-4.1L10 8.5l4.1-1.4z"], ["s", "M3 21l6-6M3.5 15.5l3-3M8.5 20.5l3-3"]],
  // «Буря» — туча «Грозы» с двумя молниями.
  tempest: [["f", "M6.5 12.5a4 4 0 1 1 .8-7.9A5.5 5.5 0 0 1 17.5 6.5a3 3 0 0 1-.5 6z"], ["s", "M9 14.5l-2 3.5h3l-1.5 3.5M15.5 14.5l-2 3.5h3L15 21.5"]],
  // «Вихрь клинков» — три лезвия ножа вокруг оси.
  blade_whirl: [["f", [0, 120, 240].map((angle) => rotate(BLADE, angle)).join("")], ["d", "M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"]],
  // «Ледяной венец» — камень-оберег стал короной из льдинок.
  frost_crown: [["f", "M3.5 19.5h17l.5-10-4.5 3.5L12 4l-4.5 9L3 9.5z"], ["d", "M12 13.5l1.5 2-1.5 2-1.5-2z"]],
  // «Горн» — наковальня с огнём «Очага».
  forge: [["f", "M3 10h13.5a4 4 0 0 1-4 4H12v2.5h2.5V20h-8v-3.5H9V14h-.5C5.5 14 3 12.5 3 10z"], ["d", "M18.5 2.5c1.4 1.5 2.5 2.7 2.5 4.2a2.5 2.5 0 0 1-5 0c0-.9.4-1.6 1-2.2 0 .9.4 1.5 1 1.6-.1-1.3.1-2.5.5-3.6z"]],
  // «Гадюка» — жало стало змеёй.
  viper: [["s3", "M4.5 20.5c4 0 6.5-2 6.5-5s-4-3.5-4-6.5 2.5-5 6.5-5"], ["f", "M13.5 4c2.6-1.3 6.2-.6 6.8 1.6.5 2-2 3.8-5 3.2z"], ["d", "M17.2 5.3a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z"]],
};

/** Статусные знаки и места в сезоне. */
const STATUS = {
  // VIP — корона: три зубца и обод.
  emb_vip: [["f", "M3.5 18l-1-10.5 5 4L12 4l4.5 7.5 5-4-1 10.5z"], ["s", "M4 21h16"]],
  // Тестер — колба, как метка «Тестер» сейчас.
  emb_tester: [["s", "M8.5 3h7"], ["f", "M10 3.5v5.7L4.5 18.8a1.6 1.6 0 0 0 1.4 2.4h12.2a1.6 1.6 0 0 0 1.4-2.4L14 9.2V3.5z"], ["d", "M7.2 15.5h9.6l1.4 2.8a.7.7 0 0 1-.6 1H6.4a.7.7 0 0 1-.6-1z"]],
  // Меценат — сердце, как знак у имени в рейтинге.
  emb_supporter: [["f", "M12 20.5S3.5 15.5 3.5 9.2A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8.5 2.2c0 6.3-8.5 11.3-8.5 11.3z"]],
  // Команда — щит с руной Ж из знака «Рубеж».
  emb_team: [["f", "M12 2.5l8 3v6.3c0 4.9-3.4 8.2-8 9.7-4.6-1.5-8-4.8-8-9.7V5.5z"], ["s", "M12 7.5v9M8.5 8.5l3.5 3.5 3.5-3.5M8.5 15.5l3.5-3.5 3.5 3.5"]],
  // Чемпион — кубок со звездой; топ-10 — кубок; топ-100 — венок.
  emb_season_champion: [["f", "M7 3.5h10v5a5 5 0 0 1-10 0z"], ["s", "M7 5.5H4.5a3 3.5 0 0 0 3 3.5M17 5.5h2.5a3 3.5 0 0 1-3 3.5M12 13.5V17M8 20.5h8"], ["d", "M12 5l.8 1.6 1.7.3-1.2 1.2.3 1.7-1.6-.8-1.6.8.3-1.7-1.2-1.2 1.7-.3z"]],
  emb_season_top10: [["f", "M7 3.5h10v5a5 5 0 0 1-10 0z"], ["s", "M7 5.5H4.5a3 3.5 0 0 0 3 3.5M17 5.5h2.5a3 3.5 0 0 1-3 3.5M12 13.5V17M8 20.5h8"]],
  emb_season_top100: [["s", "M8.5 20C4.5 17.5 3 12 5.5 6.5M15.5 20c4-2.5 5.5-8 3-13.5"], ["d", "M4.4 11.5c1.6-.2 2.7.6 3 2-1.6.2-2.7-.6-3-2zM5.4 7.5c1.5.3 2.3 1.4 2.2 2.8-1.5-.3-2.3-1.4-2.2-2.8zM6.5 16.3c1.5-.6 2.8-.1 3.4 1.2-1.5.6-2.8.1-3.4-1.2zM19.6 11.5c-1.6-.2-2.7.6-3 2 1.6.2 2.7-.6 3-2zM18.6 7.5c-1.5.3-2.3 1.4-2.2 2.8 1.5-.3 2.3-1.4 2.2-2.8zM17.5 16.3c-1.5-.6-2.8-.1-3.4 1.2 1.5.6 2.8.1 3.4-1.2z"], ["d", "M12 9.5l1 2 2.2.3-1.6 1.5.4 2.2-2-1-2 1 .4-2.2-1.6-1.5 2.2-.3z"]],
};

/** Верхние ступени лестниц и скрытые — у каждого свой предмет. */
const LADDERS = {
  // Сто тысяч убитых — скрещённые мечи.
  ach_kills_100k: [["s3", "M5 19L17.5 6.5M19 19L6.5 6.5"], ["d", "M17 3.5h3.5V7zM7 3.5H3.5V7z"], ["s", "M3.5 17.5l3 3M20.5 17.5l-3 3"]],
  // Сто часов в игре — свеча.
  ach_time_100h: [["f", "M9 9.5h6v11H9z"], ["d", "M12 2.5c1.6 1.8 2.6 3 2.6 4.3a2.6 2.6 0 0 1-5.2 0c0-1.3 1-2.5 2.6-4.3z"], ["s", "M6.5 21h11"]],
  // Пятидесятый уровень аккаунта — три шеврона ранга.
  ach_account_50: [["s3", "M6 9.5l6-4.5 6 4.5M6 14.5L12 10l6 4.5M6 19.5L12 15l6 4.5"]],
  // Полмиллиона опыта — крупный кристалл опыта.
  ach_xp_500k: [["f", "M12 2.5l7 7-7 12-7-12z"], ["s", "M5 9.5h14M12 2.5L9.5 9.5l2.5 12 2.5-12z"]],
  // Двадцать минут на рубеже — частокол.
  ach_survive_20: [["f", "M3.5 21V7.5L6 4.5l2.5 3V21zM9.5 21V5.5l2.5-3 2.5 3V21zM15.5 21V7.5l2.5-3 2.5 3V21z"], ["s", "M2.5 12.5h19"]],
  // Сороковой уровень в забеге — стрела вверх.
  ach_level_40: [["f", "M12 2.5l7.5 8H15v10.5H9V10.5H4.5z"]],
  // Двести забегов — следы шагов.
  ach_runs_200: [["f", "M8 3.5c1.9 0 3 1.9 3 4.5S9.9 12 8 12 5 10.6 5 8s1.1-4.5 3-4.5zM16 10c1.9 0 3 1.9 3 4.5S17.9 18.5 16 18.5 13 17.1 13 14.5 14.1 10 16 10z"], ["s", "M6.5 15h3M14.5 21.5h3"]],
  // Пять побед на «Сложной» — череп.
  ach_hard_5: [["f", "M12 3a7.5 7.5 0 0 0-7.5 7.5c0 2.6 1.2 4.4 3 5.5v3.5h9V16c1.8-1.1 3-2.9 3-5.5A7.5 7.5 0 0 0 12 3z"], ["d", "M9 9.5a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4zM15 9.5a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4z"], ["s", "M10.5 19.5V17M13.5 19.5V17"]],
  // Двадцать пять друзей — двое рядом.
  ach_friends_25: [["f", "M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20.5c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6z"], ["s", "M15.5 11a3 3 0 1 0 0-6M17.5 14.7c2 .8 3.5 3 3.5 5.8"]],
  // Пятьдесят бустов — зелье.
  ach_boost_50: [["s", "M9 3h6"], ["f", "M10.2 3.5v4.6a6.5 6.5 0 1 0 3.6 0V3.5z"], ["d", "M12 11.5l1.5 2-1.5 2-1.5-2z"]],
  // Двести элит — рогатый шлем.
  ach_elite_200: [["f", "M5.5 14a6.5 6.5 0 0 1 13 0v6.5h-13z"], ["s", "M5.5 12.5C3.2 11 2.6 7.5 4 5M18.5 12.5c2.3-1.5 2.9-5 1.5-7.5"], ["d", "M8.5 15.5h7v2h-7z"]],
  // Двадцать пять боссов — череп в короне.
  ach_boss_25: [["d", "M6.5 8l1-5.5 4.5 3.5 4.5-3.5 1 5.5z"], ["f", "M12 9a5.8 5.8 0 0 0-5.8 5.8c0 2 1 3.5 2.3 4.3v2.4h7v-2.4c1.3-.8 2.3-2.3 2.3-4.3A5.8 5.8 0 0 0 12 9z"], ["d", "M9.8 13.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zM14.2 13.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"]],
  // Двести сундуков — сундук.
  ach_chest_200: [["f", "M3.5 11h17v9.5h-17zM3.5 11a8.5 5.5 0 0 1 17 0z"], ["d", "M10.8 12.5h2.4v3.5h-2.4z"]],
  // Сто тысяч кристаллов — россыпь из трёх.
  ach_crystal_100k: [["f", "M12 2.5l3.5 5L12 17.5 8.5 7.5zM6 10l2.7 3.5L6 21l-2.7-7.5zM18 10l2.7 3.5L18 21l-2.7-7.5z"]],
  // Двадцать пять эволюций — путь вверх к звезде.
  ach_evolution_25: [["s", "M4.5 20.5c4.5 0 5-3 6-6.5s2.5-6 6-6"], ["d", "M5 17.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"], ["f", "M18 2.5l1.3 3.7 3.7 1.3-3.7 1.3L18 12.5l-1.3-3.7L13 7.5l3.7-1.3z"]],
  // Скрытые: семь «Сложных» — семиконечная звезда; марафон — бесконечный путь; шестидесятый уровень — солнце.
  ach_hidden_hard_7: [["f", "M12 2.5l2.4 4.5 5-.8-1.6 4.8 3.6 3.6-5 .9-.9 5-4.5-2.4-4.5 2.4-.9-5-5-.9 3.6-3.6-1.6-4.8 5 .8z"], ["d", "M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"]],
  ach_hidden_marathon: [["s3", "M12 12c-2-2.8-4-4.5-6-4.5a4.5 4.5 0 0 0 0 9c2 0 4-1.7 6-4.5s4-4.5 6-4.5a4.5 4.5 0 0 1 0 9c-2 0-4-1.7-6-4.5z"]],
  ach_hidden_level_60: [["d", "M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"], ["s", "M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"]],
  // Новые (Р161): без единой царапины — щит с отметкой; коллекционер — оружие на стойке.
  ach_no_hit_10: [["f", "M12 2.5l8 3v6.3c0 4.9-3.4 8.2-8 9.7-4.6-1.5-8-4.8-8-9.7V5.5z"], ["s", "M8.5 12l2.5 2.5 4.5-5"]],
  ach_collector: [["s", "M3 21h18M6 21V9M12 21V6M18 21V9"], ["d", "M6 4l2 3-2 3-2-3zM12 1.5l2 3-2 3-2-3zM18 4.5a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6z"]],
};

/**
 * Знаки, чей значок уже есть: мастера оружия — значок оружия, верхние
 * ступени стихийников — значок стихии. Ссылка, а не копия: поправят значок
 * оружия — поправится и знак.
 */
const BORROWED = {
  ach_weapon_spark: ["weapon", "spark"],
  ach_weapon_knife: ["weapon", "knife"],
  ach_weapon_wardstone: ["weapon", "wardstone"],
  ach_weapon_hearth: ["weapon", "hearth"],
  ach_weapon_storm: ["weapon", "storm"],
  ach_weapon_sting: ["weapon", "sting"],
  ach_weapon_meteor: ["weapon", "meteor"],
  ach_fire_10k: ["element", "fire"],
  ach_cold_10k: ["element", "cold"],
  ach_lightning_10k: ["element", "lightning"],
  ach_poison_10k: ["element", "poison"],
};

export const EMBLEM_GLYPHS = { ...STATUS, ...LADDERS };

function tsx() {
  const own = Object.entries(EMBLEM_GLYPHS).map(([id, glyph]) => `  ${id}: ${JSON.stringify(glyph)},`);
  const borrowed = Object.entries(BORROWED).map(([id, [kind, key]]) => `  ${id}: ${kind === "weapon" ? `WEAPON_GLYPHS.${key}` : `ELEMENT_GLYPHS.${key}`},`);
  return `// Сгенерировано design/art/src/emblem-glyphs.mjs — правится там, а не здесь.
import { ELEMENT_GLYPHS, WEAPON_GLYPHS, type Glyph } from "../game-glyphs";

/**
 * Значки знаков у имени (Р149) по id знака: статусные — \`emb_*\`, заслуги —
 * id достижения. Язык — как у значков оружия: сетка 24, контур 2. Мастера
 * оружия и стихийники берут значок оружия и стихии. Нет в карте — значок
 * категории достижения (T-0236).
 */
export const EMBLEM_GLYPHS: Readonly<Record<string, Glyph | undefined>> = {
${own.join("\n")}
${borrowed.join("\n")}
};
`;
}

/** Лист: каждый знак на 16, 24 и 48 px — в тоне редкости, как в строке рейтинга и в профиле. */
function sheet() {
  const layer = ([kind, d]) =>
    kind === "f"
      ? `<path d="${d}" fill="currentColor" fill-opacity="0.28"/>`
      : kind === "d"
        ? `<path d="${d}" fill="currentColor" stroke-width="1"/>`
        : `<path d="${d}" stroke-width="${kind === "s3" ? 3 : 2}"/>`;
  const svg = (glyph, size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph.map(layer).join("")}</svg>`;
  const card = (id, glyph, tone) => `<div class="card" style="--tone:${tone}"><div class="row">${svg(glyph, 16)}${svg(glyph, 24)}${svg(glyph, 48)}</div><code>${id}</code></div>`;
  const tones = { status: "#ffd15c", ladder: "#c47dff", evolution: "#ffe066" };
  const cards = [
    `<h2>Статус и сезон</h2><div class="grid">${Object.entries(STATUS).map(([id, g]) => card(id, g, tones.status)).join("")}</div>`,
    `<h2>Заслуги</h2><div class="grid">${Object.entries(LADDERS).map(([id, g]) => card(id, g, tones.ladder)).join("")}</div>`,
    `<h2>Знаки мира: эволюции и «Метеор» (WEAPON_GLYPHS)</h2><div class="grid">${Object.entries(EVOLUTION_GLYPHS).map(([id, g]) => card(id, g, tones.evolution)).join("")}</div>`,
  ];
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Знаки у имени — значки</title>
<style>
  /* Сгенерировано design/art/src/emblem-glyphs.mjs. Цвета — токены «Сумеречного рубежа». */
  body { margin: 0; padding: 20px; background: #12111f; color: #f3eee6; font: 14px/1.4 system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 6px; } h2 { font-size: 16px; margin: 22px 0 10px; }
  p { color: #aeaac4; max-width: 90ch; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
  .card { background: #28273f; border: 1px solid #43425f; border-radius: 10px; padding: 10px; color: var(--tone); }
  .row { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
  code { color: #aeaac4; font-size: 11.5px; }
</style></head><body>
<h1>Знаки у имени и знаки мира — значки</h1>
<p>Сетка 24, контур 2, как значки оружия. Размеры — 16 (строка рейтинга), 24 (лист знака), 48 (витрина). Мастера оружия и стихийники берут значки оружия и стихий — их здесь нет. Тон карточки — для чтения листа; в игре тон — у чипа по редкости (T-0236).</p>
${cards.join("\n")}
</body></html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(join(ROOT, "packages/app-shell/src/screens/meta/emblem-glyphs.tsx"), tsx());
  writeFileSync(join(HERE, "../mockups/emblems-v2.html"), sheet());
  console.log(`знаков своих: ${Object.keys(EMBLEM_GLYPHS).length}, заимствованных: ${Object.keys(BORROWED).length}, знаков мира: ${Object.keys(EVOLUTION_GLYPHS).length}`);
}
