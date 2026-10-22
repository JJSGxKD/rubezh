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
 * Снаряды — по одному кадру, смотрят вправо: рендер поворачивает их по
 * скорости (`projectile-look.ts` уже это делает). Цвет — роль «своё оружие —
 * тёплое и бирюза», вражеский сгусток — красный с горячим ядром, как сейчас.
 */
function projectiles() {
  return {
    spark: [svg(`<path d="M-44 0 Q-10 -9 18 -6 L18 6 Q-10 9 -44 0 Z" fill="#ffb67f" opacity="0.75"/><circle cx="18" r="14" fill="#ffd15c"/><circle cx="20" cy="-2" r="7" fill="#fff6dc"/>`)],
    knife: [svg(`<path d="M-36 -5 L-12 -5 L-12 -9 L-6 -9 L-6 -5 L30 -5 L44 0 L30 5 L-6 5 L-6 9 L-12 9 L-12 5 L-36 5 Z" fill="#e9ecf5"/><path d="M-6 -5 L30 -5 L44 0 L-6 0 Z" fill="#ffffff"/><rect x="-36" y="-5" width="24" height="10" rx="3" fill="#8a5a3c"/>`)],
    sting: [svg(`<path d="M-44 0 L30 -4 L46 0 L30 4 Z" fill="#8ee05a"/><path d="M-44 0 L30 -1.5 L46 0 Z" fill="#d9f7c4"/><circle cx="-30" cy="0" r="6" fill="#6fcf3a" opacity="0.6"/>`)],
    ward: [svg(`<circle r="40" fill="#46d9c6" opacity="0.25"/><path d="M0 -34 L30 0 L0 34 L-30 0 Z" fill="#46d9c6"/><path d="M0 -34 L30 0 L0 0 Z" fill="#b9fff4"/><path d="M-12 0 h24 M0 -12 v24" stroke="#1d5a55" stroke-width="5" stroke-linecap="round"/>`)],
    bolt: [svg(`<circle r="38" fill="#ff6b6b" opacity="0.35"/><circle r="26" fill="#ff6b6b"/><circle r="12" fill="#fff1e6"/>`)],
  };
}
const PROJ = projectiles();

/**
 * Знаки состояний (design/art/direction-v2.md §4.5): над головой врага-спрайта
 * вместо заливки цветом стихии — заливка стирала рисунок и мигала толпой.
 * Знак — силуэт стихии в тёмном канте, чтобы читался на любой земле: язычок
 * пламени, снежинка, кристаллы льда, молния, капля яда. Цвета — те же, что у
 * тона состояния (`status-tones.ts`): игрок узнаёт стихию по цвету и форме.
 * Два кадра — дрожание пламени, разряд, пузырёк; холод и лёд стоят.
 */
const EDGE = "#1d1c31";
function statusFrames() {
  const outline = (d) => `<path d="${d}" fill="none" stroke="${EDGE}" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/>`;
  const flame = (sway, tall) => {
    const d = `M0 ${f(-34 * tall)} C${f(10 + sway)} ${f(-18 * tall)} 24 -4 22 12 C20 28 8 36 0 36 C-8 36 -20 28 -22 12 C-24 -2 ${f(-6 + sway)} -10 0 ${f(-34 * tall)} Z`;
    const inner = `M${f(sway * 0.5)} ${f(-14 * tall)} C${f(6 + sway * 0.5)} -4 12 6 11 16 C10 26 4 30 0 30 C-4 30 -10 26 -11 16 C-12 8 ${f(-4 + sway * 0.5)} 0 ${f(sway * 0.5)} ${f(-14 * tall)} Z`;
    return svg(`${outline(d)}<path d="${d}" fill="#ff7a2e"/><path d="${inner}" fill="#ffd15c"/><ellipse cx="0" cy="22" rx="5" ry="7" fill="#fff6dc"/>`);
  };
  const flake = () => {
    const arms = [0, 1, 2, 3, 4, 5].map((i) => {
      const a = (i / 6) * TAU - Math.PI / 2;
      const x = Math.cos(a), y = Math.sin(a);
      const bx = Math.cos(a + 0.6), by = Math.sin(a + 0.6), cx = Math.cos(a - 0.6), cy = Math.sin(a - 0.6);
      return `M0 0 L${f(x * 34)} ${f(y * 34)} M${f(x * 20)} ${f(y * 20)} L${f(x * 20 + bx * 11)} ${f(y * 20 + by * 11)} M${f(x * 20)} ${f(y * 20)} L${f(x * 20 + cx * 11)} ${f(y * 20 + cy * 11)}`;
    }).join(" ");
    return svg(`<path d="${arms}" stroke="${EDGE}" stroke-width="14" stroke-linecap="round" fill="none"/><path d="${arms}" stroke="#9fd2ff" stroke-width="6" stroke-linecap="round" fill="none"/><circle r="8" fill="#e6f5ff" stroke="${EDGE}" stroke-width="3"/>`);
  };
  const shard = (x, y, h, w) => `M${f(x)} ${f(y - h)} L${f(x + w)} ${f(y)} L${f(x)} ${f(y + h * 0.35)} L${f(x - w)} ${f(y)} Z`;
  const ice = () => {
    const shards = [shard(-14, 10, 30, 10), shard(14, 12, 26, 9), shard(0, 2, 40, 12)];
    return svg(`${shards.map(outline).join("")}${shards.map((d) => `<path d="${d}" fill="#b8ecff"/>`).join("")}<path d="${shard(0, 2, 40, 12).replace(/L[^L]*L[^L]*Z$/, "")} L0 2 Z" fill="#ffffff" opacity="0.85"/>`);
  };
  const bolt = (flash) => {
    const d = "M6 -38 L-16 4 L-2 4 L-10 38 L18 -8 L3 -8 L12 -38 Z";
    const sparks = flash ? `<circle cx="-22" cy="-18" r="4" fill="#fff6c8"/><circle cx="24" cy="18" r="3.5" fill="#fff6c8"/>` : "";
    return svg(`${outline(d)}<path d="${d}" fill="${flash ? "#fff6c8" : "#fff06a"}"/><path d="M6 -38 L-8 -4 L-2 -4 Z" fill="#ffffff" opacity="0.8"/>${sparks}`);
  };
  const drop = (bubble) => {
    const d = "M0 -36 C8 -20 24 -4 24 12 C24 26 13 36 0 36 C-13 36 -24 26 -24 12 C-24 -4 -8 -20 0 -36 Z";
    const b = bubble ? `<circle cx="20" cy="-22" r="7" fill="#8ee05a" stroke="${EDGE}" stroke-width="3.5"/>` : `<circle cx="22" cy="-10" r="5" fill="#8ee05a" stroke="${EDGE}" stroke-width="3"/>`;
    return svg(`${outline(d)}<path d="${d}" fill="#6fcf3a"/><path d="M-12 8 C-12 -2 -6 -10 -2 -16" stroke="#d9f7c4" stroke-width="5" stroke-linecap="round" fill="none"/>${b}`);
  };
  return {
    burn: [flame(0, 1), flame(4, 1.08)],
    chill: [flake()],
    frozen: [ice()],
    shock: [bolt(false), bolt(true)],
    poison: [drop(false), drop(true)],
  };
}
const STATUS = statusFrames();

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
  { id: "proj_spark", units: 12, frames: PROJ.spark },
  { id: "proj_knife", units: 14, frames: PROJ.knife },
  { id: "proj_sting", units: 14, frames: PROJ.sting },
  { id: "orbiter_ward", units: 16, frames: PROJ.ward },
  { id: "proj_enemy", units: 12, frames: PROJ.bolt },
  { id: "status_burn", units: 14, frames: STATUS.burn },
  { id: "status_chill", units: 14, frames: STATUS.chill },
  { id: "status_frozen", units: 14, frames: STATUS.frozen },
  { id: "status_shock", units: 14, frames: STATUS.shock },
  { id: "status_poison", units: 14, frames: STATUS.poison },
];
