// Концепты неубиваемого преследователя: шесть кандидатов из славянской
// мифологии в языке «Формы-предка» — крупный план, предвестие, движение и
// масштаб забега среди обычных врагов, элиты и босса.
//
//   PLAYWRIGHT_MODULE=…/playwright-core/index.mjs PW_CHANNEL=chrome node design/art/src/stalker-concepts.mjs
//
// Результат — design/art/concepts/stalker/: SVG каждого кандидата и его
// предвестия, лист PNG каждого и сводный лист всех шести.
//
// Общий знак неубиваемого (чем он отличается от элиты и босса с первого
// взгляда): тело — чернь Нави, темнее земли и любого врага; кайма не золотая,
// а бледная лунная — «иней»; под ногами не свечение Нави, а провал с бледным
// кольцом; низ тела — рваный подол тремя плоскими ступенями прозрачности:
// ног нет, он не стоит на земле. Полосы здоровья нет — бить его бесполезно.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENEMY_ART, twoTone } from "./creatures.mjs";
import { HERO_DEFS, HERO_STATES } from "./hero.mjs";
import { creaturePalette, enemyBody, enemyEye } from "./palette.mjs";
import { CELL_K, svgFrame } from "./build.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "concepts", "stalker");
const GROUND = "#33506a";
/** Пикселей листа на игровую единицу в сцене: половина телефона 390 px при DPR 3 (как `gameSize / 2` в previews.mjs). */
const UNIT_PX = 1.4;
const TAU = Math.PI * 2;
const f = (n) => (Math.round(n * 10) / 10).toString();

/** Общая палитра преследователей: чернь Нави и лунный иней. Акцент — у каждого свой. */
const BASE = {
  body: "#241c38",
  shade: "#150f24",
  deep: "#0b0816",
  light: "#4d4170",
  rim: "#e6e0ff",
  eye: "#f6f3ff",
  pupil: "#0b0816",
};

// Рендер листов — со своим генератором с зерном: раскладка толпы повторяется.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function glow(x, y, r, color, halo = 2) {
  return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * halo)}" fill="${color}" opacity="0.3"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${color}"/>`;
}

/**
 * Рваный подол: три полосы лохмотьев плоскими тонами с прозрачностью 1 → 0,6
 * → 0,3. Не градиент (на 20 px он шум), а ступени — низ тела тает в воздухе.
 */
function hem(x0, x1, y, t, P, depth = 10) {
  const n = 6;
  const step = (x1 - x0) / n;
  const band = (dy, len, op, color) => {
    let d = `M${f(x0)} ${f(y + dy)}`;
    for (let k = 0; k < n; k++) {
      const sway = Math.sin(t * TAU + k * 1.7) * 2.5;
      const tip = len * (k % 2 === 0 ? 1 : 0.65);
      d += ` L${f(x0 + step * (k + 0.5) + sway)} ${f(y + dy + tip)} L${f(x0 + step * (k + 1))} ${f(y + dy)}`;
    }
    d += ` L${f(x1)} ${f(y + dy - 4)} L${f(x0)} ${f(y + dy - 4)} Z`;
    return `<path d="${d}" fill="${color}" opacity="${op}"/>`;
  };
  return band(0, depth, 1, P.shade) + band(depth * 0.55, depth * 0.8, 0.6, P.shade) + band(depth * 1.1, depth * 0.6, 0.3, P.shade);
}

// ───────────────────────── кандидаты ─────────────────────────

/** Ырка: сгорбленный ночной дух полей, крадётся низко, глаза — первое, что видно. */
function yrka(t, P) {
  const w = Math.sin(t * TAU);
  const bob = w * 2;
  const body = `<path d="M-34 ${f(20 + bob)} Q-40 ${f(-6 + bob)} -18 ${f(-18 + bob)} Q4 ${f(-28 + bob)} 20 ${f(-20 + bob)} Q30 ${f(-10 + bob)} 22 ${f(14 + bob)} L-34 ${f(20 + bob)} Z"/>`;
  const head = `<path d="M10 ${f(-22 + bob)} Q20 ${f(-40 + bob)} 36 ${f(-30 + bob)} Q46 ${f(-22 + bob)} 40 ${f(-10 + bob)} Q28 ${f(-4 + bob)} 14 ${f(-10 + bob)} Z"/>`;
  return `
${hem(-36, 20, 16 + bob, t, P, 12)}
<path d="M18 ${f(-6 + bob)} Q${f(34 + w * 5)} 10 ${f(38 + w * 6)} 34 M${f(38 + w * 6)} 34 l5 4 M${f(38 + w * 6)} 34 l-1 7 M${f(38 + w * 6)} 34 l-6 4" fill="none" stroke="${P.shade}" stroke-width="5" stroke-linecap="round"/>
<path d="M-4 ${f(-4 + bob)} Q${f(8 - w * 5)} 14 ${f(6 - w * 6)} 32 M${f(6 - w * 6)} 32 l5 4 M${f(6 - w * 6)} 32 l-3 6" fill="none" stroke="${P.deep}" stroke-width="5" stroke-linecap="round"/>
${twoTone(body, P.body, P.shade, -3, -3)}
<path d="M-26 ${f(-10 + bob)} Q-6 ${f(-26 + bob)} 12 ${f(-20 + bob)}" fill="none" stroke="${P.light}" stroke-width="3" stroke-linecap="round" opacity="0.8"/>
<path d="M-14 ${f(-20 + bob)} l-4 -9 M-4 ${f(-24 + bob)} l-1 -10 M6 ${f(-24 + bob)} l3 -9" stroke="${P.shade}" stroke-width="3" stroke-linecap="round"/>
${twoTone(head, P.body, P.shade, -2, -2)}
${glow(24, -24 + bob, 4.6, P.accent, 2.2)}${glow(36, -21 + bob, 3.6, P.accent, 2.2)}
<circle cx="25" cy="${f(-24 + bob)}" r="1.6" fill="${P.pupil}"/><circle cx="37" cy="${f(-21 + bob)}" r="1.3" fill="${P.pupil}"/>
<path d="M22 ${f(-10 + bob)} Q32 ${f(-6 + bob)} 40 ${f(-12 + bob)}" fill="none" stroke="${P.pupil}" stroke-width="2.6" stroke-linecap="round"/>
<path d="M25 ${f(-9 + bob)} l1 3 l2 -3 M31 ${f(-8 + bob)} l1 3 l2 -3 M36 ${f(-10 + bob)} l1 3 l2 -3" fill="none" stroke="${P.bone}" stroke-width="1.4"/>`;
}

/** Карачун: высокий старик-зима в капюшоне, посох-клюка, борода сосулек. */
function karachun(t, P) {
  const w = Math.sin(t * TAU);
  const bob = -Math.abs(w) * 1.5;
  const robe = `<path d="M-26 ${f(28 + bob)} L-18 ${f(-18 + bob)} Q-14 ${f(-34 + bob)} -2 ${f(-46 + bob)} L4 ${f(-56 + bob)} L10 ${f(-44 + bob)} Q20 ${f(-30 + bob)} 20 ${f(-14 + bob)} L26 ${f(28 + bob)} Z"/>`;
  const icicles = [-6, -1, 4, 9, 14].map((x, k) => `<path d="M${x} ${f(-22 + bob)} L${x + 2.5} ${f(-22 + bob + 9 + (k % 2) * 6)} L${x + 5} ${f(-22 + bob)} Z"/>`).join("");
  const crown = [-6, 0, 6, 12].map((x, k) => `<path d="M${x} ${f(-44 + bob + (k === 1 ? -4 : 0))} l2 ${-6 - (k % 2) * 4} l2 ${6 + (k % 2) * 4} Z"/>`).join("");
  const staffX = 32 + w * 2;
  return `
${hem(-28, 28, 24 + bob, t, P, 12)}
<path d="M${f(staffX)} 40 L${f(staffX - 2)} ${f(-40 + bob)} Q${f(staffX - 2)} ${f(-52 + bob)} ${f(staffX - 12)} ${f(-50 + bob)}" fill="none" stroke="${P.light}" stroke-width="3.6" stroke-linecap="round"/>
<path d="M${f(staffX - 6)} ${f(-56 + bob)} l4 -8 l4 8 l-4 5 Z" fill="${P.accent}"/>
${twoTone(robe, P.body, P.shade, -3, -3)}
<path d="M-12 ${f(-12 + bob)} Q-16 ${f(6 + bob)} -20 ${f(26 + bob)} M6 ${f(0 + bob)} Q8 ${f(14 + bob)} 6 ${f(28 + bob)}" fill="none" stroke="${P.light}" stroke-width="2.4" opacity="0.6"/>
<path d="M-4 ${f(-40 + bob)} Q4 ${f(-46 + bob)} 14 ${f(-36 + bob)} Q16 ${f(-28 + bob)} 12 ${f(-22 + bob)} L-4 ${f(-22 + bob)} Q-8 ${f(-30 + bob)} -4 ${f(-40 + bob)} Z" fill="${P.deep}"/>
${glow(3, -32 + bob, 1.9, P.eye, 2.4)}${glow(10, -31 + bob, 1.6, P.eye, 2.4)}
<g fill="${P.accent}">${icicles}${crown}</g>
<path d="M18 ${f(-12 + bob)} Q26 ${f(-14 + bob)} ${f(staffX - 1)} ${f(-18 + bob)}" fill="none" stroke="${P.shade}" stroke-width="6" stroke-linecap="round"/>
<circle cx="${f(staffX - 1)}" cy="${f(-18 + bob)}" r="3.4" fill="${P.light}"/>
<path d="M-20 ${f(10 + bob)} l-5 3 M-22 ${f(18 + bob)} l-6 2 M-16 ${f(2 + bob)} l-5 1" stroke="${P.accent}" stroke-width="1.6" stroke-linecap="round" opacity="0.8"/>`;
}

/** Полуденница: тонкая тёмная дева со светлыми волосами по ветру и серпом над головой. */
function poludnitsa(t, P) {
  const w = Math.sin(t * TAU);
  const bob = w * 2;
  const dress = `<path d="M-20 ${f(30 + bob)} Q-12 ${f(0 + bob)} -6 ${f(-22 + bob)} L8 ${f(-22 + bob)} Q14 ${f(0 + bob)} 22 ${f(30 + bob)} Z"/>`;
  const hair = `<path d="M-2 ${f(-40 + bob)} Q-14 ${f(-42 + bob)} ${f(-30 - w * 4)} ${f(-28 + bob)} Q${f(-44 - w * 6)} ${f(-18 + bob)} ${f(-48 - w * 6)} ${f(-6 + bob)} Q${f(-34 - w * 3)} ${f(-14 + bob)} -20 ${f(-18 + bob)} Q-8 ${f(-22 + bob)} -2 ${f(-26 + bob)} Z"/>`;
  const sickle = `<path d="M18 ${f(-30 + bob)} Q30 ${f(-62 + bob)} 6 ${f(-70 + bob)} Q34 ${f(-70 + bob)} 30 ${f(-38 + bob)} Q26 ${f(-30 + bob)} 18 ${f(-30 + bob)} Z"/>`;
  return `
${hem(-22, 24, 26 + bob, t, P, 12)}
<g fill="${P.accent}">${hair}</g>
<path d="M14 ${f(-14 + bob)} L22 ${f(-28 + bob)}" stroke="${P.shade}" stroke-width="5" stroke-linecap="round"/>
<path d="M22 ${f(-28 + bob)} L18 ${f(-30 + bob)}" stroke="${P.light}" stroke-width="4" stroke-linecap="round"/>
${twoTone(sickle, P.bone, P.light, -2, -1)}
${twoTone(dress, P.body, P.shade, -3, -3)}
<path d="M-4 ${f(-18 + bob)} Q0 ${f(4 + bob)} -8 ${f(28 + bob)}" fill="none" stroke="${P.light}" stroke-width="2.4" opacity="0.6"/>
${twoTone(`<ellipse cx="2" cy="${f(-32 + bob)}" rx="9" ry="10"/>`, P.body, P.shade, -2, -2)}
<path d="M-6 ${f(-38 + bob)} Q2 ${f(-46 + bob)} 11 ${f(-38 + bob)} L11 ${f(-32 + bob)} Q2 ${f(-38 + bob)} -6 ${f(-32 + bob)} Z" fill="${P.accent}"/>
${glow(6, -30 + bob, 1.7, P.eye, 2.4)}
<path d="M-12 ${f(-12 + bob)} Q${f(-22 - w * 3)} ${f(2 + bob)} ${f(-18 - w * 3)} ${f(14 + bob)}" fill="none" stroke="${P.shade}" stroke-width="4" stroke-linecap="round"/>`;
}

/** Лихо Одноглазое: тощий сгорбленный великан с одним огромным глазом. */
function likho(t, P) {
  const w = Math.sin(t * TAU);
  const bob = -Math.abs(w) * 3;
  const torso = `<path d="M-18 ${f(20 + bob)} Q-30 ${f(-6 + bob)} -14 ${f(-26 + bob)} Q4 ${f(-40 + bob)} 22 ${f(-30 + bob)} Q32 ${f(-18 + bob)} 20 ${f(-2 + bob)} Q10 ${f(16 + bob)} -18 ${f(20 + bob)} Z"/>`;
  const head = `<ellipse cx="22" cy="${f(-34 + bob)}" rx="15" ry="13"/>`;
  return `
${hem(-22, 18, 14 + bob, t, P, 10)}
<path d="M-8 ${f(16 + bob)} L${f(-14 - w * 8)} 30 L${f(-10 - w * 8)} 42 M8 ${f(14 + bob)} L${f(14 + w * 8)} 30 L${f(20 + w * 8)} 42" fill="none" stroke="${P.shade}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.45"/>
<path d="M-12 ${f(-14 + bob)} Q${f(-30 + w * 6)} 10 ${f(-28 + w * 8)} 34 M${f(-28 + w * 8)} 34 l-4 6 M${f(-28 + w * 8)} 34 l2 7" fill="none" stroke="${P.shade}" stroke-width="4" stroke-linecap="round"/>
<path d="M18 ${f(-14 + bob)} Q${f(36 - w * 6)} 6 ${f(34 - w * 8)} 32 M${f(34 - w * 8)} 32 l4 6 M${f(34 - w * 8)} 32 l-2 7" fill="none" stroke="${P.shade}" stroke-width="4.5" stroke-linecap="round"/>
${twoTone(torso, P.body, P.shade, -3, -3)}
<path d="M-8 ${f(-26 + bob)} q-6 -10 0 -16 M0 ${f(-30 + bob)} q-2 -10 6 -14" fill="none" stroke="${P.shade}" stroke-width="3" stroke-linecap="round"/>
${twoTone(head, P.body, P.shade, -2, -2)}
<circle cx="24" cy="${f(-34 + bob)}" r="${f(9.5 * 1.7)}" fill="${P.accent}" opacity="0.22"/>
<circle cx="24" cy="${f(-34 + bob)}" r="9.5" fill="${P.accent}"/>
<ellipse cx="${f(27 + w)}" cy="${f(-34 + bob)}" rx="3" ry="6" fill="${P.pupil}"/>
<path d="M13 ${f(-42 + bob)} Q24 ${f(-50 + bob)} 35 ${f(-42 + bob)}" fill="none" stroke="${P.deep}" stroke-width="3" stroke-linecap="round"/>
<path d="M18 ${f(-20 + bob)} Q26 ${f(-16 + bob)} 34 ${f(-22 + bob)}" fill="none" stroke="${P.pupil}" stroke-width="2.4" stroke-linecap="round"/>`;
}

/** Жердяй: долговязый, как жердь; переступает толпу, голова над всеми. */
function zherdyai(t, P) {
  const w = Math.sin(t * TAU);
  const sway = w * 4;
  const body = `<path d="M${f(-6 + sway * 0.6)} -6 L${f(-9 + sway)} -52 Q${f(-4 + sway)} -62 ${f(6 + sway)} -58 L${f(8 + sway * 0.6)} -6 Z"/>`;
  const head = `<path d="M${f(2 + sway)} -60 Q${f(4 + sway)} -76 ${f(18 + sway)} -74 Q${f(26 + sway)} -68 ${f(20 + sway)} -60 Z"/>`;
  return `
${hem(-10 + sway * 0.6, 12 + sway * 0.6, -10, t, P, 8)}
<path d="M${f(-4 + sway * 0.6)} -8 L${f(-12 - w * 10)} 18 L${f(-8 - w * 12)} 42 M${f(6 + sway * 0.6)} -8 L${f(14 + w * 10)} 18 L${f(12 + w * 12)} 42" fill="none" stroke="${P.shade}" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.45"/>
<path d="M${f(-6 + sway)} -50 Q${f(-22 + sway)} -30 ${f(-18 + sway * 0.5)} -6 M${f(-18 + sway * 0.5)} -6 l-3 6 M${f(-18 + sway * 0.5)} -6 l2 6" fill="none" stroke="${P.deep}" stroke-width="3.4" stroke-linecap="round"/>
${twoTone(body, P.body, P.shade, -2, -3)}
<path d="M${f(6 + sway)} -52 Q${f(26 + sway)} -36 ${f(24 + sway * 0.5)} -10 M${f(24 + sway * 0.5)} -10 l3 6 M${f(24 + sway * 0.5)} -10 l-2 6" fill="none" stroke="${P.shade}" stroke-width="3.6" stroke-linecap="round"/>
${twoTone(head, P.body, P.shade, -2, -2)}
<path d="M${f(-2 + sway)} -70 L${f(28 + sway)} -70 L${f(18 + sway)} -78 L${f(6 + sway)} -78 Z" fill="${P.deep}"/>
${glow(16 + sway, -66, 1.8, P.accent, 2.4)}${glow(21 + sway, -65, 1.4, P.accent, 2.4)}
<path d="M${f(-4 + sway)} -40 L${f(4 + sway)} -38 M${f(-4 + sway)} -30 L${f(5 + sway)} -28" stroke="${P.light}" stroke-width="2" opacity="0.6"/>`;
}

/** Кромешник: безликий из-за кромки — в капюшоне провал, по плащу шов-разрыв. */
function kromeshnik(t, P) {
  const w = Math.sin(t * TAU);
  const bob = w * 2.5;
  const cloak = `<path d="M-24 ${f(26 + bob)} Q-30 ${f(-8 + bob)} -14 ${f(-30 + bob)} Q0 ${f(-48 + bob)} 14 ${f(-34 + bob)} Q28 ${f(-12 + bob)} 24 ${f(26 + bob)} Z"/>`;
  const holeD = `M-2 ${f(-36 + bob)} Q8 ${f(-40 + bob)} 14 ${f(-30 + bob)} Q14 ${f(-18 + bob)} 4 ${f(-14 + bob)} Q-6 ${f(-18 + bob)} -6 ${f(-28 + bob)} Z`;
  return `
${hem(-26, 26, 22 + bob, t, P, 13)}
${twoTone(cloak, P.body, P.shade, -3, -3)}
<path d="M-14 ${f(-24 + bob)} Q-18 ${f(0 + bob)} -16 ${f(22 + bob)}" fill="none" stroke="${P.light}" stroke-width="2.6" opacity="0.6"/>
<path d="${holeD}" fill="${P.deep}" stroke="${P.accent}" stroke-width="2"/>
<path d="M4 ${f(-12 + bob)} L1 ${f(0 + bob)} L6 ${f(8 + bob)} L2 ${f(18 + bob)} L5 ${f(28 + bob)}" fill="none" stroke="${P.accent}" stroke-width="2.4" stroke-linejoin="round"/>
<path d="M4 ${f(-12 + bob)} L1 ${f(0 + bob)} L6 ${f(8 + bob)} L2 ${f(18 + bob)} L5 ${f(28 + bob)}" fill="none" stroke="${P.accent}" stroke-width="7" stroke-linejoin="round" opacity="0.2"/>
${glow(8, -27 + bob, 1.3, P.eye, 2.6)}
<path d="M18 ${f(-10 + bob)} Q${f(32 + w * 4)} ${f(0 + bob)} ${f(34 + w * 4)} ${f(14 + bob)}" fill="none" stroke="${P.shade}" stroke-width="5" stroke-linecap="round"/>
<path d="M${f(34 + w * 4)} ${f(14 + bob)} l4 5 M${f(34 + w * 4)} ${f(14 + bob)} l0 7 M${f(34 + w * 4)} ${f(14 + bob)} l-4 5" stroke="${P.bone}" stroke-width="2" stroke-linecap="round"/>`;
}

// ───────────────────────── предвестия ─────────────────────────
// `p` — доля полутора секунд предвестия 0…1. Рисунок — в поле -50…50, вид
// сверху на землю (эллипс сплющен, как знак под ногами F-05).

function mist(p, rim, r = 40) {
  // Холодный туман: три плоских кольца с прозрачностью ступенями, растут к концу.
  const k = 0.4 + p * 0.6;
  return `<ellipse cx="0" cy="0" rx="${f(r * k)}" ry="${f(r * k * 0.42)}" fill="#0b0816" opacity="${f(0.25 + p * 0.3)}"/>
<ellipse cx="0" cy="0" rx="${f(r * k * 1.12)}" ry="${f(r * k * 0.47)}" fill="none" stroke="${rim}" stroke-width="1.6" opacity="${f(0.3 + p * 0.5)}" stroke-dasharray="${f(6 + p * 10)} 5"/>
<ellipse cx="0" cy="0" rx="${f(r * k * 1.32)}" ry="${f(r * k * 0.56)}" fill="${rim}" opacity="${f(0.06 + p * 0.06)}"/>`;
}

const OMENS = {
  yrka: (p, P) => {
    const open = Math.min(1, p * 1.6);
    const eye = (x, y, r) => `<ellipse cx="${x}" cy="${y}" rx="${f(r * 2.2)}" ry="${f(r * 2.2 * open)}" fill="${P.accent}" opacity="0.3"/><ellipse cx="${x}" cy="${y}" rx="${r}" ry="${f(r * open)}" fill="${P.accent}"/>`;
    return `${mist(p, P.rim)}${p > 0.15 ? eye(-7, -6, 4) + eye(7, -5, 3.4) : ""}`;
  },
  karachun: (p, P) => {
    const len = 10 + p * 34;
    const rays = Array.from({ length: 6 }, (_, k) => {
      const a = (k / 6) * TAU + 0.3;
      const x = Math.cos(a) * len;
      const y = Math.sin(a) * len * 0.42;
      const bx = Math.cos(a) * len * 0.6;
      const by = Math.sin(a) * len * 0.6 * 0.42;
      const b = (s) => `M${f(bx)} ${f(by)} L${f(bx + Math.cos(a + s * 0.7) * len * 0.25)} ${f(by + Math.sin(a + s * 0.7) * len * 0.25 * 0.42)}`;
      return `M0 0 L${f(x)} ${f(y)} ${p > 0.4 ? b(1) + b(-1) : ""}`;
    }).join(" ");
    return `${mist(p, P.rim)}<path d="${rays}" fill="none" stroke="${P.accent}" stroke-width="1.8" stroke-linecap="round"/>`;
  },
  poludnitsa: (p, P) => {
    // Тень серпа метёт дугу по земле, над ней дрожит марево.
    const a0 = -2.4 + p * 2.6;
    const arc = `M${f(Math.cos(a0) * 36)} ${f(Math.sin(a0) * 15)} A36 15 0 0 1 ${f(Math.cos(a0 + 1.4) * 36)} ${f(Math.sin(a0 + 1.4) * 15)}`;
    const haze = [-16, 0, 16].map((x) => `<path d="M${x - 6} -6 q3 -4 6 0 q3 4 6 0" fill="none" stroke="${P.accent}" stroke-width="1.4" opacity="${f(0.2 + p * 0.5)}"/>`).join("");
    return `${mist(p, P.rim)}<path d="${arc}" fill="none" stroke="#0b0816" stroke-width="7" stroke-linecap="round" opacity="0.7"/><path d="${arc}" fill="none" stroke="${P.accent}" stroke-width="1.4" opacity="0.7"/>${haze}`;
  },
  likho: (p, P) => {
    const open = Math.max(0.08, Math.min(1, p * 1.3));
    return `${mist(p, P.rim)}<ellipse cx="0" cy="0" rx="20" ry="${f(9 * open)}" fill="${P.accent}"/><ellipse cx="0" cy="0" rx="${f(4 + p * 2)}" ry="${f(8 * open)}" fill="${P.pupil}"/><path d="M-22 0 Q0 ${f(-14 * open - 2)} 22 0 M-22 0 Q0 ${f(14 * open + 2)} 22 0" fill="none" stroke="#0b0816" stroke-width="2.4"/>`;
  },
  zherdyai: (p, P) => {
    // Длинная тень приходит от края экрана: сначала жердь, потом голова.
    const reach = 20 + p * 30;
    return `${mist(p * 0.7, P.rim, 30)}<path d="M-50 4 L${f(-50 + reach * 2)} -2" stroke="#0b0816" stroke-width="5" stroke-linecap="round" opacity="0.75"/><circle cx="${f(-50 + reach * 2 + 3)}" cy="-3" r="5.5" fill="#0b0816" opacity="0.75"/>${p > 0.5 ? glow(-50 + reach * 2 + 5, -4, 1.3, P.accent, 2.2) : ""}`;
  },
  kromeshnik: (p, P) => {
    // Шов кромки встаёт на земле и расходится — щель в мир.
    const h = 12 + p * 34;
    const wdt = 1.5 + p * 9;
    return `${mist(p, P.rim)}<path d="M0 ${f(-h)} Q${f(wdt)} 0 0 ${f(h * 0.3)} Q${f(-wdt)} 0 0 ${f(-h)} Z" fill="#0b0816" stroke="${P.accent}" stroke-width="2"/><path d="M0 ${f(-h)} Q${f(wdt)} 0 0 ${f(h * 0.3)} Q${f(-wdt)} 0 0 ${f(-h)} Z" fill="none" stroke="${P.accent}" stroke-width="7" opacity="0.18"/>`;
  },
};

// ───────────────────────── каталог ─────────────────────────

const CANDIDATES = [
  {
    id: "karachun",
    name: "Карачун",
    draw: karachun,
    accent: "#cfe9ff",
    radius: 17,
    pad: 1.3,
    myth: [
      "Дух внезапной смерти и самой длинной ночи года. Само слово «карачун» —",
      "«внезапная смерть»: «пришёл карачун» говорили, когда беда приходила без спроса.",
      "Приходит со стужей, укорачивает дни и жизни.",
    ],
    omen: "иней трещиной-звездой расходится по земле, холодный туман сгущается",
    move: "шагает ровно и не спеша, за ним тает иней; не бежит — бегут от него",
  },
  {
    id: "yrka",
    name: "Ырка",
    draw: yrka,
    accent: "#fff1c2",
    radius: 16,
    pad: 1.15,
    myth: [
      "Ночной дух полей — душа самоубийцы, которую не приняла земля. Ходит за",
      "одинокими путниками, глаза светятся во тьме; оглянешься — пропал,",
      "отвернёшься — ближе. Боится огня и дома.",
    ],
    omen: "в тумане открываются два светящихся глаза — раньше тела",
    move: "крадётся низко, перебежками: пропадает на миг и возникает ближе",
  },
  {
    id: "poludnitsa",
    name: "Полуденница",
    draw: poludnitsa,
    accent: "#f3e6bf",
    radius: 15,
    pad: 1.4,
    myth: [
      "Полевой дух зноя: дева со светлыми волосами и серпом. В полдень ходит",
      "по житу и наказывает тех, кто работает в жару, — может свернуть голову",
      "или загадать загадку.",
    ],
    omen: "тень серпа метёт дугу по земле, над ней дрожит марево",
    move: "скользит, не касаясь земли; волосы и подол текут назад",
  },
  {
    id: "likho",
    name: "Лихо Одноглазое",
    draw: likho,
    accent: "#f6f3ff",
    radius: 18,
    pad: 1.25,
    myth: [
      "Тощее одноглазое чудище — воплощённая беда. «Не буди лихо, пока оно тихо»:",
      "привяжется — ходит за человеком по пятам и несёт несчастье,",
      "избавиться можно только хитростью.",
    ],
    omen: "на земле открывается огромный глаз и смотрит на игрока",
    move: "ходит вразвалку, широким шагом длинных ног, руки до земли",
  },
  {
    id: "zherdyai",
    name: "Жердяй",
    draw: zherdyai,
    accent: "#e9e3ff",
    radius: 13,
    pad: 1.7,
    myth: [
      "Долговязый, как жердь, ночной дух: бродит по деревне и заглядывает в окна,",
      "греет руки у печной трубы. Худой и высокий — «жердяй» до сих пор",
      "говорят о долговязом человеке.",
    ],
    omen: "от края экрана по земле вытягивается длинная тень с головой",
    move: "переступает толпу на ногах-жердях, качаясь; голова над всеми",
  },
  {
    id: "kromeshnik",
    name: "Кромешник",
    draw: kromeshnik,
    accent: "#bf98ff",
    radius: 17,
    pad: 1.15,
    replaces: "Мара",
    myth: [
      "Житель «кромешного» мира — того, что за кромкой, за краем живого.",
      "Кромка — это и есть рубеж: кромешник выходит из щели между мирами",
      "и уходит обратно, а лица у него нет — только провал.",
    ],
    omen: "на земле встаёт шов кромки и расходится щелью",
    move: "выходит из щели, идёт прямо, уходит в новую щель",
  },
];

/** Палитра кандидата: общая чернь Нави и свой акцент. */
const paletteOf = (c) => ({ ...BASE, accent: c.accent, bone: "#e9e1cf" });

const rimFilter = (id, color, radius) => `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" filterUnits="objectBoundingBox">
<feMorphology in="SourceAlpha" operator="dilate" radius="${radius}" result="d"/>
<feFlood flood-color="${color}"/><feComposite in2="d" operator="in" result="o"/>
<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

/**
 * Кадр преследователя. Вместо свечения Нави — провал с бледным кольцом, вместо
 * золотой каймы — лунная кайма той же толщины, что у элиты (2 единицы).
 * `fade` — прозрачность тела (появление, растворение), `ghost` — смещение
 * второй копии для мерцания.
 */
function stalkerSvg(c, t, { fade = 1, ghost = 0, omen = -1 } = {}) {
  const P = paletteOf(c);
  const unitsPerBox = (c.radius * 2 * CELL_K) / 100;
  const rimW = (2 / unitsPerBox) * 0.5;
  const pad = c.pad;
  const box = `${f(-50 * pad)} ${f(-50 * pad)} ${f(100 * pad)} ${f(100 * pad)}`;
  const under = `<ellipse cx="0" cy="42" rx="30" ry="8" fill="#0b0816" opacity="${f(0.55 * fade)}"/><ellipse cx="0" cy="42" rx="34" ry="9.5" fill="none" stroke="${P.rim}" stroke-width="1.6" opacity="${f(0.55 * fade)}"/>`;
  const omenLayer = omen >= 0 ? `<g transform="translate(0 42) scale(0.9)">${OMENS[c.id](omen, P)}</g>` : "";
  const body = c.draw(t, P);
  const ghostLayer = ghost !== 0 ? `<g filter="url(#srim)" opacity="0.3" transform="translate(${f(ghost)} 0)">${c.draw(t, P)}</g>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"><defs>${rimFilter("srim", P.rim, rimW.toFixed(2))}</defs>${omenLayer}${under}${ghostLayer}<g filter="url(#srim)" opacity="${f(fade)}">${body}</g></svg>`;
}

/** Предвестие отдельно: вид сверху на землю, поле -50…50. */
function omenSvg(c, p) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100">${OMENS[c.id](p, paletteOf(c))}</svg>`;
}

// ───────────────────────── соседи по полю ─────────────────────────

const art = (id) => ENEMY_ART.find((a) => a.id === id);
function enemySvg(a, t, stage = 0) {
  const P = creaturePalette(enemyBody(a.pattern, a.rank, stage, a.id), enemyEye(stage));
  return svgFrame(a.draw(t, P), { rank: a.rank, radius: a.radius, hostile: true, pad: a.pad });
}
function heroSvg(k = 1) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100"><defs>${HERO_DEFS}</defs>${HERO_STATES.walk[k]()}</svg>`;
}
const cellPx = (radius, pad = 1, k = CELL_K) => radius * 2 * k * pad * UNIT_PX;

/**
 * Сцена забега: герой в центре, толпа рядовых, элита, преследователь на
 * подходе и предвестие его следующего появления. Масштаб — как на телефоне.
 */
function sceneItems(c, x0, y0, w, h, seed) {
  const r = rng(seed);
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const crowd = ["swarm_rat", "swarm_rat", "swarm_rat", "mire_shambler", "tank_ghoul", "dasher_wolf", "rushing_bats", "bone_walker", "splitter_slime", "circler_crow"];
  const sprites = [];
  for (let k = 0; k < 46; k++) {
    const a = art(crowd[Math.floor(r() * crowd.length)]);
    const ang = r() * TAU;
    const dist = 70 + r() * 220;
    const x = cx + Math.cos(ang) * dist;
    const y = cy + Math.sin(ang) * dist * 0.75;
    const s = cellPx(a.radius, a.pad ?? 1);
    if (x < x0 + s / 2 || x > x0 + w - s / 2 || y < y0 + s / 2 || y > y0 + h - s / 2) continue;
    if (Math.abs(x - (cx + 150)) < 60 && Math.abs(y - (cy - 60)) < 60) continue;
    sprites.push({ svg: enemySvg(a, r(), Math.floor(r() * 3)), x: x - s / 2, y: y - s / 2, size: s, depth: y + s / 2 });
  }
  const elite = art("elite_ghoul");
  const es = cellPx(elite.radius, elite.pad);
  sprites.push({ svg: enemySvg(elite, 0.4), x: cx - 210 - es / 2, y: cy + 40 - es / 2, size: es, depth: cy + 40 + es / 2 });
  const hs = cellPx(10, 1, 2.6);
  sprites.push({ svg: heroSvg(1), x: cx - hs / 2, y: cy - hs / 2, size: hs, depth: cy + hs / 2 });
  const ss = cellPx(c.radius, c.pad);
  sprites.push({ svg: stalkerSvg(c, 0.3), x: cx + 150 - ss / 2, y: cy - 60 - ss / 2, size: ss, depth: cy - 60 + ss / 2 });
  sprites.sort((a, b) => a.depth - b.depth);
  // Предвестие следующего появления — на земле, под всеми.
  const os = 90;
  const omen = { svg: omenSvg(c, 0.7), x: cx - 120 - os / 2, y: cy - 130 - os / 2, size: os };
  return [{ ground: true, x: x0, y: y0, w, h }, omen, ...sprites];
}

// ───────────────────────── листы ─────────────────────────

const TEXT = "#f3eee6";
const DIM = "#aeaac4";
const ACCENT = "#ff8f3f";

function candidateBoard(c) {
  const items = [];
  const W = 1380;
  items.push({ text: `${c.name}${c.replaces ? ` (вместо кандидата «${c.replaces}»)` : ""} — неубиваемый преследователь`, x: 24, y: 36, size: 26, bold: true });
  c.myth.forEach((line, k) => items.push({ text: line, x: 24, y: 66 + k * 22, size: 16, color: DIM }));
  let y = 140;
  // Крупный план и шаг.
  items.push({ ground: true, x: 16, y, w: W - 32, h: 330 });
  items.push({ text: "крупный план", x: 28, y: y + 22, size: 14, color: DIM });
  items.push({ svg: stalkerSvg(c, 0.25), x: 28, y: y + 30, size: 290 });
  items.push({ text: "шаг: 4 кадра", x: 350, y: y + 22, size: 14, color: DIM });
  for (let k = 0; k < 4; k++) items.push({ svg: stalkerSvg(c, k / 4), x: 340 + k * 150, y: y + 60, size: 150 });
  items.push({ text: "движение:", x: 350, y: y + 250, size: 15, bold: true });
  items.push({ text: c.move, x: 440, y: y + 250, size: 15 });
  items.push({ text: "палитра: чернь Нави, лунная кайма, акцент", x: 950, y: y + 22, size: 14, color: DIM });
  const P = paletteOf(c);
  [P.body, P.shade, P.light, P.rim, P.accent, P.eye].forEach((col, k) => items.push({ fill: col, x: 960 + k * 64, y: y + 36, w: 56, h: 56 }));
  ["тело", "тень", "свет", "кайма", "акцент", "глаза"].forEach((l, k) => items.push({ text: l, x: 962 + k * 64, y: y + 110, size: 12, color: DIM }));
  items.push({ text: "знак неубиваемого:", x: 960, y: y + 150, size: 15, bold: true });
  ["тело темнее любого врага и земли", "кайма лунная, а не золотая", "под ногами провал с бледным кольцом", "вместо ног — подол, тает ступенями", "полосы здоровья нет"].forEach((l, k) =>
    items.push({ text: `· ${l}`, x: 960, y: y + 176 + k * 22, size: 14 }),
  );
  y += 345;
  // Предвестие 1,5 с.
  items.push({ ground: true, x: 16, y, w: W - 32, h: 250 });
  items.push({ text: "предвестие ~1,5 с:", x: 28, y: y + 26, size: 15, bold: true });
  items.push({ text: c.omen, x: 190, y: y + 26, size: 15 });
  [0, 0.5, 1].forEach((p, k) => {
    items.push({ svg: omenSvg(c, p), x: 28 + k * 220, y: y + 40, size: 200 });
    items.push({ text: `${(p * 1.5).toFixed(2).replace(".", ",")} с`, x: 110 + k * 220, y: y + 238, size: 13, color: DIM });
  });
  items.push({ text: "выход → погоня 10–20 с → мерцание → растворение", x: 700, y: y + 52, size: 14, color: DIM });
  const phases = [
    { label: "выход", opt: { fade: 0.4, omen: 1 } },
    { label: "погоня", opt: {} },
    { label: "мерцание", opt: { ghost: -18 } },
    { label: "растворение", opt: { fade: 0.25 } },
  ];
  phases.forEach((ph, k) => {
    items.push({ svg: stalkerSvg(c, k / 4, ph.opt), x: 690 + k * 165, y: y + 64, size: 160 });
    items.push({ text: ph.label, x: 730 + k * 165, y: y + 238, size: 13, color: DIM });
  });
  y += 265;
  // Масштаб забега.
  items.push({ text: "в забеге (телефон 390 px, половина DPR 3): герой, толпа со ступенями, элита в золотой кайме, преследователь и знак его следующего выхода", x: 24, y: y + 20, size: 15, bold: true });
  items.push(...sceneItems(c, 16, y + 32, 760, 430, 7 + c.id.length));
  // Сравнение в ряд.
  const rx = 800;
  items.push({ ground: true, x: rx, y: y + 32, w: W - 16 - rx, h: 430 });
  items.push({ text: "в ряд, игровой масштаб ×1,2", x: rx + 14, y: y + 56, size: 14, color: DIM });
  const row = [
    { label: "упырь", a: art("tank_ghoul") },
    { label: "элита", a: art("elite_ghoul") },
    { label: "босс", a: art("boss_ram") },
  ];
  let x = rx + 14;
  const base = y + 300;
  for (const it of row) {
    const s = cellPx(it.a.radius, it.a.pad ?? 1) * 1.2;
    items.push({ svg: enemySvg(it.a, 0.25), x, y: base - s, size: s });
    items.push({ text: it.label, x: x + s / 2 - 16, y: base + 20, size: 13, color: DIM });
    x += s + 4;
  }
  const s = cellPx(c.radius, c.pad) * 1.2;
  items.push({ svg: stalkerSvg(c, 0.25), x, y: base - s * 0.86, size: s });
  items.push({ text: c.name, x: x + s / 2 - 20, y: base + 20, size: 13, bold: true, color: ACCENT });
  items.push({ text: "элита и босс — золото и полоса здоровья;", x: rx + 14, y: base + 60, size: 13, color: DIM });
  items.push({ text: "преследователь — чернь, лунная кайма, без ног", x: rx + 14, y: base + 80, size: 13, color: DIM });
  return { width: W, height: y + 480, items };
}

function summaryBoard() {
  const items = [];
  const W = 1380;
  const col = (W - 32) / 6;
  items.push({ text: "Неубиваемый преследователь — шесть кандидатов в «Форме-предке»", x: 24, y: 36, size: 26, bold: true });
  items.push({ text: "общий знак: чернь Нави темнее земли, лунная кайма вместо золотой, провал под ногами, подол вместо ног, без полосы здоровья", x: 24, y: 64, size: 15, color: DIM });
  let y = 84;
  items.push({ ground: true, x: 16, y, w: W - 32, h: 560 });
  CANDIDATES.forEach((c, k) => {
    const x = 16 + k * col;
    const rec = c.id === "karachun";
    items.push({ text: c.name + (rec ? " ★" : ""), x: x + 12, y: y + 28, size: 19, bold: true, color: rec ? ACCENT : TEXT });
    if (c.replaces) items.push({ text: `вместо «${c.replaces}»`, x: x + 12, y: y + 48, size: 12, color: DIM });
    items.push({ svg: stalkerSvg(c, 0.25), x: x + 8, y: y + 56, size: col - 16 });
    const gs = cellPx(c.radius, c.pad);
    items.push({ svg: stalkerSvg(c, 0.25), x: x + 20, y: y + 300 - gs / 2, size: gs });
    const rat = art("swarm_rat");
    const rs = cellPx(rat.radius);
    items.push({ svg: enemySvg(rat, 0.3), x: x + 20 + gs, y: y + 300 + gs * 0.3 - rs, size: rs });
    const hs = cellPx(10, 1, 2.6);
    items.push({ svg: heroSvg(1), x: x + 30 + gs + rs, y: y + 300 + gs * 0.3 - hs * 0.8, size: hs });
    items.push({ text: "в игре: рядом крыса и герой", x: x + 12, y: y + 360, size: 11, color: DIM });
    items.push({ svg: omenSvg(c, 0.8), x: x + 20, y: y + 368, size: col - 60 });
    items.push({ text: "предвестие", x: x + 12, y: y + 510, size: 11, color: DIM });
    const words = c.omen.split(" ");
    let line = "";
    let ly = y + 528;
    for (const w of words) {
      if ((line + " " + w).length > 30) {
        items.push({ text: line.trim(), x: x + 12, y: ly, size: 11 });
        ly += 14;
        line = "";
      }
      line += ` ${w}`;
    }
    items.push({ text: line.trim(), x: x + 12, y: ly, size: 11 });
  });
  y += 580;
  items.push({ text: "Все шестеро в одной толпе — игровой масштаб, телефон", x: 24, y, size: 18, bold: true });
  const sx = 16;
  const sy = y + 12;
  const sw = W - 32;
  const sh = 300;
  items.push({ ground: true, x: sx, y: sy, w: sw, h: sh });
  const r = rng(42);
  const crowd = ["swarm_rat", "swarm_rat", "mire_shambler", "tank_ghoul", "dasher_wolf", "rushing_bats", "bone_walker"];
  const sprites = [];
  for (let k = 0; k < 70; k++) {
    const a = art(crowd[Math.floor(r() * crowd.length)]);
    const s = cellPx(a.radius, a.pad ?? 1);
    const x = sx + 10 + r() * (sw - 20 - s);
    const yy = sy + 10 + r() * (sh - 20 - s);
    sprites.push({ svg: enemySvg(a, r(), Math.floor(r() * 3)), x, y: yy, size: s, depth: yy + s });
  }
  CANDIDATES.forEach((c, k) => {
    const s = cellPx(c.radius, c.pad);
    const x = sx + 70 + k * (sw - 140) / 6;
    const yy = sy + sh / 2 - s / 2 + (k % 2 ? 30 : -30);
    sprites.push({ svg: stalkerSvg(c, 0.25), x, y: yy, size: s, depth: yy + s });
    items.push({ text: c.name, x: x + 4, y: sy + sh + 18, size: 13, color: c.id === "karachun" ? ACCENT : TEXT });
  });
  const e = art("elite_grave_knight");
  const es = cellPx(e.radius, e.pad);
  sprites.push({ svg: enemySvg(e, 0.4), x: sx + sw - es - 20, y: sy + 20, size: es, depth: sy + 20 + es });
  sprites.sort((a, b) => a.depth - b.depth);
  items.push(...sprites);
  return { width: W, height: sy + sh + 34, items };
}

async function renderBoard(page, board) {
  return page.evaluate(async ({ board, ground }) => {
    const canvas = document.createElement("canvas");
    canvas.width = board.width;
    canvas.height = board.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1d1c31";
    ctx.fillRect(0, 0, board.width, board.height);
    for (const item of board.items) {
      if (item.text !== undefined) {
        ctx.fillStyle = item.color ?? "#f3eee6";
        ctx.font = `${item.bold ? "700 " : ""}${item.size ?? 18}px system-ui, sans-serif`;
        ctx.fillText(item.text, item.x, item.y);
        continue;
      }
      if (item.ground || item.fill !== undefined) {
        ctx.fillStyle = item.fill ?? ground;
        ctx.fillRect(item.x, item.y, item.w, item.h);
        continue;
      }
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.svg)}`;
      await img.decode();
      ctx.drawImage(img, item.x, item.y, item.size, item.size);
    }
    return canvas.toDataURL("image/png").split(",")[1];
  }, { board, ground: GROUND });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const c of CANDIDATES) {
    writeFileSync(join(OUT, `${c.id}.svg`), stalkerSvg(c, 0.25));
    writeFileSync(join(OUT, `${c.id}-omen.svg`), omenSvg(c, 0.8));
  }
  const path = process.env.PLAYWRIGHT_MODULE ?? "/opt/node-tools/node_modules/playwright/index.mjs";
  const { chromium } = await import(pathToFileURL(path).href);
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const page = await browser.newPage();
  writeFileSync(join(OUT, "sheet-stalkers.png"), Buffer.from(await renderBoard(page, summaryBoard()), "base64"));
  for (const c of CANDIDATES) {
    writeFileSync(join(OUT, `sheet-${c.id}.png`), Buffer.from(await renderBoard(page, candidateBoard(c)), "base64"));
  }
  await browser.close();
  console.log(`концепты преследователя: ${OUT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
