// Запечённые эффекты боя. Запекаем только то, что повторяется сотнями за забег
// и не меняет формы от обстоятельств: искру попадания, развеивание гибели,
// огненный взрыв, вход из Нави. Меняющееся (радиус ауры, путь молнии, кольца
// волн) остаётся процедурным — design/art/effects.md, «Что запекать».
//
// Белые и серые эффекты красятся тинтом в рендере (умножение): одна текстура
// на все стихии и всех врагов. Огненный взрыв — свой цвет, он всегда огонь.

const TAU = Math.PI * 2;
const f = (n) => (Math.round(n * 10) / 10).toString();
const svg = (inner, defs = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-50 -50 100 100"><defs>${defs}</defs>${inner}</svg>`;
const ease = (p) => 1 - (1 - p) * (1 - p);

/** Искра попадания: 4 кадра, ~0,13 с. Белая звезда с лучами — тинт стихии в рендере. */
function hitFrames() {
  return [0, 1, 2, 3].map((k) => {
    const p = (k + 0.5) / 4;
    const r = 10 + ease(p) * 30;
    const core = 14 * (1 - p);
    const rays = [0, 1, 2, 3, 4, 5]
      .map((i) => {
        const a = (i / 6) * TAU + 0.3;
        const r0 = r * 0.35;
        return `<line x1="${f(Math.cos(a) * r0)}" y1="${f(Math.sin(a) * r0)}" x2="${f(Math.cos(a) * r)}" y2="${f(Math.sin(a) * r)}" stroke="#fff" stroke-width="${f(6 * (1 - p) + 1)}" stroke-linecap="round"/>`;
      })
      .join("");
    return svg(`<g opacity="${f(1 - p * 0.6)}">${rays}<circle r="${f(core)}" fill="#fff"/></g>`);
  });
}

/**
 * Развеивание: 6 кадров, ~0,3 с. Клочья пепла разлетаются и тают, к концу
 * поднимается светлая искра — тварь ушла обратно в Навь. Серое — тинт цвета врага.
 */
function deathFrames() {
  const puffs = [
    [0.2, 1], [1.3, 0.8], [2.4, 1.1], [3.4, 0.9], [4.4, 1], [5.5, 0.85], [0.8, 0.6], [3.9, 0.65],
  ];
  return [0, 1, 2, 3, 4, 5].map((k) => {
    const p = k / 5;
    const spread = 6 + ease(p) * 30;
    const size = 11 * (1 - p * 0.7);
    const body = puffs
      .map(([a, s]) => `<circle cx="${f(Math.cos(a) * spread * s)}" cy="${f(Math.sin(a) * spread * s * 0.75 - p * 8)}" r="${f(size * s)}" fill="${s > 0.8 ? "#e8e4ee" : "#b9b3c7"}"/>`)
      .join("");
    const soul = p > 0.2 ? `<path d="M0 ${f(-10 - p * 30)} q4 6 0 12 q-4 -6 0 -12 Z" fill="#fff" opacity="${f(1 - p * 0.5)}"/>` : "";
    const flash = k === 0 ? `<circle r="18" fill="#fff"/>` : "";
    return svg(`<g opacity="${f(1 - p * p)}">${flash}${body}${soul}</g>`);
  });
}

/** Взрыв беса: 6 кадров, ~0,3 с. Огненное кольцо и ядро — свой цвет, без тинта. */
function blastFrames() {
  return [0, 1, 2, 3, 4, 5].map((k) => {
    const p = k / 5;
    const ring = 14 + ease(p) * 32;
    const tongues = Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * TAU + p;
      const r1 = ring * 0.6;
      const r2 = ring * (1.05 + (i % 2) * 0.12);
      return `<path d="M${f(Math.cos(a - 0.18) * r1)} ${f(Math.sin(a - 0.18) * r1)} L${f(Math.cos(a) * r2)} ${f(Math.sin(a) * r2)} L${f(Math.cos(a + 0.18) * r1)} ${f(Math.sin(a + 0.18) * r1)} Z"/>`;
    }).join("");
    return svg(`<g opacity="${f(1 - p * p * 0.9)}">
<g fill="#ff5a2e">${tongues}</g>
<circle r="${f(ring * 0.75)}" fill="#ff8f3f"/>
<circle r="${f(ring * 0.5 * (1 - p * 0.6))}" fill="#ffd15c"/>
<circle r="${f(ring * 0.25 * (1 - p))}" fill="#fff6dc"/>
${p > 0.4 ? `<circle r="${f(ring * 0.9)}" fill="none" stroke="#3a1830" stroke-width="${f(8 * p)}" opacity="${f(p * 0.5)}"/>` : ""}
</g>`);
  });
}

/**
 * Вход из Нави: 5 кадров, ~0,4 с. Тёмная воронка раскрывается и схлопывается
 * под врагом — видно, откуда он взялся, а не «возник из воздуха».
 * Своего цвета: сумеречный фиолетовый с красной искрой угрозы.
 */
function spawnFrames() {
  return [0, 1, 2, 3, 4].map((k) => {
    const p = k / 4;
    const open = p < 0.6 ? ease(p / 0.6) : 1 - (p - 0.6) / 0.4;
    const r = 6 + open * 34;
    return svg(`<ellipse rx="${f(r)}" ry="${f(r * 0.45)}" cy="20" fill="#1d0b22" opacity="${f(0.75 * open + 0.1)}"/>
<ellipse rx="${f(r)}" ry="${f(r * 0.45)}" cy="20" fill="none" stroke="#7a3f9a" stroke-width="3" opacity="${f(open)}"/>
<ellipse rx="${f(r * 0.6)}" ry="${f(r * 0.25)}" cy="20" fill="none" stroke="#ff5a5a" stroke-width="2" opacity="${f(open * 0.8)}"/>`);
  });
}

/** Блеск подбора: 4 кадра. Четырёхлучевая искра — тинт ступени кристалла. */
function twinkleFrames() {
  return [0, 1, 2, 3].map((k) => {
    const s = [0.4, 1, 0.7, 0.2][k];
    const r = 40 * s;
    return svg(`<path d="M0 ${f(-r)} L${f(r * 0.18)} ${f(-r * 0.18)} L${f(r)} 0 L${f(r * 0.18)} ${f(r * 0.18)} L0 ${f(r)} L${f(-r * 0.18)} ${f(r * 0.18)} L${f(-r)} 0 L${f(-r * 0.18)} ${f(-r * 0.18)} Z" fill="#fff"/>`);
  });
}

/**
 * Размер ячейки — в игровых единицах при масштабе 1. Взрыв рендер растягивает
 * до радиуса из события: мягкая форма терпит растяжение вдвое.
 */
export const FX = [
  { id: "hit", units: 24, frames: hitFrames() },
  { id: "death", units: 36, frames: deathFrames() },
  { id: "blast", units: 64, frames: blastFrames() },
  { id: "spawn", units: 32, frames: spawnFrames() },
  { id: "twinkle", units: 12, frames: twinkleFrames() },
];
