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
 * Снаряды эволюций (T-0102, design/art/direction-v2.md §4.5): эволюция —
 * превращение, а не прибавка чисел, поэтому у неё свой облик того же
 * силуэта, что у базового: игрок узнаёт оружие и видит, что оно выросло.
 * Заготовки — в движке их нет, пока эволюций нет в контенте.
 */
function evolvedProjectiles() {
  const star = (r, cx = 0, cy = 0) => {
    const pts = Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 === 0 ? r : r * 0.45;
      return `${f(cx + Math.cos(a) * rr)} ${f(cy + Math.sin(a) * rr)}`;
    });
    return `M${pts.join(" L")} Z`;
  };
  return {
    // «Звездопад» из «Искры»: звезда с длинным хвостом звёздной пыли.
    starfall: [svg(`<path d="M-46 0 Q-10 -12 14 -8 L14 8 Q-10 12 -46 0 Z" fill="#ffe9a0" opacity="0.65"/><circle cx="-30" cy="-4" r="2.5" fill="#fff6dc"/><circle cx="-18" cy="5" r="2" fill="#fff6dc"/><path d="${star(22, 18)}" fill="#ffd15c" stroke="#fff6dc" stroke-width="3" stroke-linejoin="round"/><circle cx="18" r="7" fill="#fffbe8"/>`)],
    // «Вихрь клинков» из «Ножа»: клинок с золотой гардой и дугой взмаха.
    blade_whirl: [svg(`<path d="M-40 -16 A40 40 0 0 1 -6 -26" fill="none" stroke="#ffd15c" stroke-width="4" stroke-linecap="round" opacity="0.6"/><path d="M-30 -6 L-8 -6 L-8 -12 L-2 -12 L-2 -6 L32 -6 L46 0 L32 6 L-2 6 L-2 12 L-8 12 L-8 6 L-30 6 Z" fill="#f6f2ff"/><path d="M-2 -6 L32 -6 L46 0 L-2 0 Z" fill="#ffffff"/><rect x="-8" y="-12" width="6" height="24" rx="2" fill="#ffd15c"/><rect x="-30" y="-6" width="22" height="12" rx="3" fill="#6a3d8a"/>`)],
    // «Гадюка» из «Жала»: игла длиннее и темнее, с каплями яда в следе.
    viper: [svg(`<path d="M-46 0 L30 -6 L48 0 L30 6 Z" fill="#3f8a2a"/><path d="M-46 0 L30 -2 L48 0 Z" fill="#b8f08f"/><path d="M14 -6 L22 -14 L24 -5 Z" fill="#3f8a2a"/><circle cx="-34" cy="7" r="5" fill="#6fcf3a" opacity="0.8"/><circle cx="-22" cy="-7" r="3.5" fill="#6fcf3a" opacity="0.6"/>`)],
    // «Ледяной венец» из «Оберегов»: ромб оберега — льдом и с зубцами венца.
    frost_crown: [svg(`<circle r="42" fill="#9fd2ff" opacity="0.25"/><path d="M0 -38 L30 0 L0 38 L-30 0 Z" fill="#9fd2ff" stroke="#e6f7ff" stroke-width="3"/><path d="M0 -38 L30 0 L0 0 Z" fill="#e6f7ff"/><path d="M-14 -24 L-8 -40 L-2 -26 M2 -26 L8 -40 L14 -24" fill="none" stroke="#e6f7ff" stroke-width="4" stroke-linejoin="round"/><path d="M-12 0 h24 M0 -12 v24" stroke="#2f5f8f" stroke-width="5" stroke-linecap="round"/>`)],
  };
}
const EVOLVED = evolvedProjectiles();

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
 * «Метеор» (T-0118, design/art/direction-v2.md §5.1) — заготовка для режима
 * арта: камень с огненным хвостом падает сверху-справа под тем же углом, что
 * `meteorTrail` в задаче, и оставляет кратер. Хвост — к правому верхнему
 * углу ячейки: рендер ведёт кадр по прямой к точке удара, не поворачивая.
 * Два кадра — пламя хвоста дрожит.
 */
function meteorFrames() {
  // Хвост — языком пламени: широкий у камня, сходит на нет к правому верхнему углу.
  const tail = (k) => {
    const len = k === 0 ? 1 : 1.1;
    const tip = (r) => `${f(-14 + 50 * r * len)} ${f(4 - 50 * r * len)}`;
    const outer = `M-3.4 14.6 Q${f(22 + k * 3)} ${f(-2 - k * 3)} ${tip(1)} Q${f(-2 + k * 3)} ${f(-22 + k * 3)} -24.6 -6.6 Z`;
    const inner = `M-8.3 9.7 Q${f(12 + k * 2)} ${f(-6 - k * 2)} ${tip(0.72)} Q${f(-4 + k * 2)} ${f(-16 + k * 2)} -19.7 -1.7 Z`;
    const embers = [0.55, 0.8, 0.95].map((r, i) => `<circle cx="${f(-14 + 50 * r * len + (i - 1) * 5)}" cy="${f(4 - 50 * r * len + (1 - i) * 4)}" r="${f(2.6 - i * 0.6)}" fill="#ffd15c" opacity="${f(0.9 - i * 0.2)}"/>`).join("");
    return `<path d="${outer}" fill="#ff7a2e" opacity="0.7"/><path d="${inner}" fill="#ffd15c" opacity="0.9"/>${embers}`;
  };
  const rock = `<circle cx="-14" cy="4" r="17" fill="#ff7a2e" opacity="0.45"/>
<path d="M-28 2 L-22 -10 L-8 -14 L2 -6 L0 10 L-10 18 L-24 14 Z" fill="#5a3d2a" stroke="#1d1c31" stroke-width="3" stroke-linejoin="round"/>
<path d="M-20 -6 L-10 -10 L-4 -4 L-14 0 Z" fill="#8a5a3c"/><path d="M-6 4 L-2 -2 L0 8 L-8 14 Z" fill="#ffd15c"/>`;
  return [0, 1].map((k) => svg(`${tail(k)}${rock}`));
}

/**
 * Кратер метеора: выжженное пятно с трещинами, которые остывают — от жара к
 * тёмному за четыре кадра. Лежит на земле под врагами; рендер растягивает
 * его до радиуса удара.
 */
function scorchFrames() {
  return [0, 1, 2, 3].map((k) => {
    const heat = 1 - k / 3;
    const cracks = [0.4, 1.5, 2.6, 3.7, 4.8, 5.8]
      .map((a, i) => {
        const r1 = 14 + (i % 2) * 6;
        const r2 = 30 + (i % 3) * 5;
        return `M${f(Math.cos(a) * r1)} ${f(Math.sin(a) * r1 * 0.55)} L${f(Math.cos(a + 0.15) * r2)} ${f(Math.sin(a + 0.15) * r2 * 0.55)}`;
      })
      .join(" ");
    return svg(`<ellipse rx="44" ry="25" fill="#1d1418" opacity="${f(0.55 * (0.4 + 0.6 * (1 - k / 4)))}"/>
<ellipse rx="26" ry="14" fill="#2b1a17" opacity="0.8"/>
<path d="${cracks}" stroke="#ff7a2e" stroke-width="${f(2 + 2 * heat)}" stroke-linecap="round" opacity="${f(heat)}"/>
<ellipse rx="14" ry="7" fill="#ffd15c" opacity="${f(0.7 * heat)}"/>`);
  });
}

/**
 * Новый контент Р157 (T-0281…T-0290): снаряды и следы оружия, лужи и метки
 * врагов. Пак `atlas-r157`, как и сами враги: в движке их нет, пока нет
 * контента. Метки и лужи лежат на земле, рендер растягивает их до радиуса из
 * данных — форма мягкая и терпит растяжение вдвое.
 */
const DANGER = "#ff5d5d";
function r157Frames() {
  // Серп: полумесяц лезвия с рукоятью; два кадра — поворот на четверть,
  // вместе с вращением рендера он не мелькает одним и тем же кадром.
  const sickle = (k, blade, edge, extra = "") =>
    svg(`<g transform="rotate(${k * 45})"><path d="M-30 -10 A34 34 0 0 1 32 -14 A26 26 0 0 0 -22 -2 Z" fill="${blade}"/><path d="M-30 -10 A34 34 0 0 1 32 -14 L26 -10 A30 30 0 0 0 -26 -6 Z" fill="${edge}"/><path d="M-26 -4 L-36 24" stroke="#8a5a3c" stroke-width="8" stroke-linecap="round"/>${extra}</g>`);
  const wave = (k, color, spread) => {
    const r = 14 + k * 12;
    const a = (spread / 2) * (Math.PI / 180);
    const arc = (rr) => `M${f(Math.cos(-a) * rr)} ${f(Math.sin(-a) * rr)} A${rr} ${rr} 0 0 1 ${f(Math.cos(a) * rr)} ${f(Math.sin(a) * rr)}`;
    return svg(`<path d="${arc(r)}" fill="none" stroke="${color}" stroke-width="${f(7 - k * 1.5)}" stroke-linecap="round" opacity="${f(1 - k * 0.25)}"/><path d="${arc(r + 9)}" fill="none" stroke="${color}" stroke-width="${f(3.5 - k * 0.8)}" stroke-linecap="round" opacity="${f(0.7 - k * 0.2)}"/><circle cx="${f(r + 4)}" cy="${f(-8 + k * 4)}" r="3.5" fill="#fff6dc" opacity="${f(0.9 - k * 0.3)}"/>`);
  };
  const ring = (k, color) => {
    const r = 14 + k * 11;
    const notes = [0, 1, 2, 3, 4, 5].map((i) => {
      const ang = (i / 6) * TAU + k * 0.3;
      return `<path d="M${f(Math.cos(ang) * (r + 8))} ${f(Math.sin(ang) * (r + 8))} v-7 l5 2" fill="none" stroke="#fff6dc" stroke-width="2.4" stroke-linecap="round" opacity="${f(0.9 - k * 0.3)}"/>`;
    }).join("");
    return svg(`<circle r="${r}" fill="none" stroke="${color}" stroke-width="${f(7 - k * 1.5)}" opacity="${f(1 - k * 0.25)}"/>${notes}`);
  };
  const ball = (body, spike, glow) =>
    svg(`<circle r="40" fill="${glow}" opacity="0.25"/><path d="M-46 4 L-26 2" stroke="#8a8f9e" stroke-width="5" stroke-dasharray="6 4" stroke-linecap="round"/>${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => { const a = (i / 8) * TAU; return `<path d="M${f(Math.cos(a) * 18)} ${f(Math.sin(a) * 18)} L${f(Math.cos(a) * 30)} ${f(Math.sin(a) * 30)}" stroke="${spike}" stroke-width="6" stroke-linecap="round"/>`; }).join("")}<circle r="20" fill="${body}"/><circle cx="-6" cy="-6" r="7" fill="#ffffff" opacity="0.45"/>`);
  const berry = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#e8452f"/><circle cx="${cx - r * 0.3}" cy="${cy - r * 0.3}" r="${r * 0.35}" fill="#ffb3a1"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#7a1a12" stroke-width="2"/>`;
  const puddle = (k) =>
    svg(`<ellipse rx="44" ry="26" fill="#3f7a2a" opacity="${f(0.55 - k * 0.15)}"/><ellipse rx="30" ry="16" fill="#6fcf3a" opacity="${f(0.5 - k * 0.14)}"/><ellipse cx="-12" cy="-4" rx="8" ry="3.5" fill="#d9f7c4" opacity="${f(0.7 - k * 0.22)}"/><circle cx="14" cy="4" r="${f(4 - k)}" fill="#b8f08f" opacity="${f(0.8 - k * 0.25)}"/><circle cx="-20" cy="8" r="${f(3 - k * 0.7)}" fill="#b8f08f" opacity="${f(0.7 - k * 0.2)}"/>`);
  const mark = (k) => {
    const r = 40 - k * 12;
    return svg(`<circle r="${r}" fill="${DANGER}" opacity="${f(0.12 + k * 0.06)}"/><circle r="${r}" fill="none" stroke="${DANGER}" stroke-width="4" stroke-dasharray="10 6" opacity="0.9"/><path d="M-6 -6 L6 6 M6 -6 L-6 6" stroke="#6a9a86" stroke-width="4" stroke-linecap="round" opacity="${f(0.4 + k * 0.25)}"/>`);
  };
  const rootsMark = (k) =>
    svg(`<circle r="42" fill="#3b2a1a" opacity="0.3"/><circle r="42" fill="none" stroke="${DANGER}" stroke-width="3" opacity="0.85"/><path d="M0 0 m-42 0 a42 42 0 0 1 84 0" fill="none" stroke="${DANGER}" stroke-width="7" stroke-dasharray="${f(132 * (k + 1) / 3)} 400" stroke-linecap="round"/><path d="M-20 8 q8 -10 16 -2 q6 6 14 -4" fill="none" stroke="#6b5a3a" stroke-width="4" stroke-linecap="round" opacity="${f(0.4 + k * 0.2)}"/>`);
  const rootsStrike = (k) => {
    const h = [0.6, 1, 0.75][k];
    const spikes = [-30, -16, -4, 8, 20, 32].map((x, i) => {
      const tall = (22 + (i % 3) * 8) * h;
      return `<path d="M${x - 6} 18 Q${x - 2} ${f(18 - tall * 0.5)} ${x + (i % 2 ? 3 : -3)} ${f(18 - tall)} Q${x + 4} ${f(18 - tall * 0.5)} ${x + 6} 18 Z" fill="#6b5a3a" stroke="#2a1d10" stroke-width="2.4" stroke-linejoin="round"/><path d="M${x + (i % 2 ? 3 : -3)} ${f(18 - tall)} l2 6" stroke="#c9b48a" stroke-width="2"/>`;
    }).join("");
    return svg(`<ellipse cy="18" rx="44" ry="12" fill="#2a1d10" opacity="0.5"/>${spikes}<ellipse cy="18" rx="${f(40 * h)}" ry="${f(8 * h)}" fill="none" stroke="${DANGER}" stroke-width="3" opacity="${f(0.9 - k * 0.3)}"/>`);
  };
  return {
    sickle: [0, 1].map((k) => sickle(k, "#c9d1e3", "#ffffff")),
    harvest: [0, 1].map((k) => sickle(k, "#ffd15c", "#fff6dc", `<path d="M10 4 L18 20 M18 20 l-5 -2 M18 20 l1 -6 M14 12 l-5 -1 M14 12 l2 -5" stroke="#e8c25a" stroke-width="3" stroke-linecap="round"/>`)),
    gusli: [0, 1, 2].map((k) => wave(k, "#ffe066", 64)),
    bayan: [0, 1, 2].map((k) => ring(k, "#ffd15c")),
    flail: [ball("#8a8f9e", "#c9d1e3", "#c9d1e3")],
    whirl: [ball("#ffd15c", "#fff6dc", "#ffd15c")],
    rowan: [svg(`<path d="M-44 0 Q-14 -6 6 -4 L6 4 Q-14 6 -44 0 Z" fill="#ff8a6a" opacity="0.6"/>${berry(14, -6, 11)}${berry(18, 10, 9)}${berry(2, 6, 8)}<path d="M8 -16 q8 -10 18 -6 q-6 8 -18 6 Z" fill="#6fae4a"/>`)],
    necklace: [svg(`<circle r="40" fill="#e8452f" opacity="0.2"/><circle r="24" fill="none" stroke="#8a5a3c" stroke-width="2.4"/>${[0, 1, 2, 3, 4, 5, 6].map((i) => { const a = (i / 7) * TAU - Math.PI / 2; return berry(f(Math.cos(a) * 24), f(Math.sin(a) * 24), 8); }).join("")}<path d="M0 28 l8 8 -8 8 -8 -8 Z" fill="#ffd15c" stroke="#7a4a33" stroke-width="2"/>`)],
    chain: [0, 1].map((k) => svg(`<path d="M-46 0 L-30 ${k ? 8 : -8} L-14 ${k ? -6 : 6} L2 ${k ? 8 : -8} L18 ${k ? -6 : 6} L34 ${k ? 6 : -6} L46 0" fill="none" stroke="#e8452f" stroke-width="5" stroke-linejoin="round" opacity="0.85"/><path d="M-46 0 L-30 ${k ? 8 : -8} L-14 ${k ? -6 : 6} L2 ${k ? 8 : -8} L18 ${k ? -6 : 6} L34 ${k ? 6 : -6} L46 0" fill="none" stroke="#ffd0c4" stroke-width="2" stroke-linejoin="round"/>`)),
    puddle: [0, 1, 2].map(puddle),
    kikimora: [0, 1, 2].map(mark),
    rootsMark: [0, 1, 2].map(rootsMark),
    rootsStrike: [0, 1, 2].map(rootsStrike),
  };
}
const R157 = r157Frames();

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
  // Заготовки под T-0102: эволюций ещё нет в контенте.
  { id: "proj_starfall", units: 14, frames: EVOLVED.starfall },
  { id: "proj_blade_whirl", units: 16, frames: EVOLVED.blade_whirl },
  { id: "proj_viper", units: 16, frames: EVOLVED.viper },
  { id: "orbiter_frost_crown", units: 18, frames: EVOLVED.frost_crown },
  // Заготовки под T-0118: оружия ещё нет в движке, кадры ждут в атласе.
  { id: "meteor", units: 20, frames: meteorFrames() },
  { id: "scorch", units: 48, frames: scorchFrames() },
  { id: "status_burn", units: 14, frames: STATUS.burn },
  { id: "status_chill", units: 14, frames: STATUS.chill },
  { id: "status_frozen", units: 14, frames: STATUS.frozen },
  { id: "status_shock", units: 14, frames: STATUS.shock },
  { id: "status_poison", units: 14, frames: STATUS.poison },
  // Новый контент Р157 — пак `atlas-r157`. Ячейка — в единицах при масштабе 1;
  // волны, лужи и метки рендер растягивает до радиуса из данных.
  { id: "proj_sickle", units: 18, frames: R157.sickle, pack: "r157" },
  { id: "proj_harvest", units: 20, frames: R157.harvest, pack: "r157" },
  { id: "wave_gusli", units: 64, frames: R157.gusli, pack: "r157" },
  { id: "wave_bayan_song", units: 72, frames: R157.bayan, pack: "r157" },
  { id: "orbiter_flail", units: 20, frames: R157.flail, pack: "r157" },
  { id: "orbiter_whirl", units: 22, frames: R157.whirl, pack: "r157" },
  { id: "proj_rowan_beads", units: 14, frames: R157.rowan, pack: "r157" },
  { id: "proj_necklace", units: 18, frames: R157.necklace, pack: "r157" },
  { id: "chain_rowan", units: 40, frames: R157.chain, pack: "r157" },
  { id: "puddle_bog", units: 52, frames: R157.puddle, pack: "r157" },
  { id: "mark_kikimora", units: 40, frames: R157.kikimora, pack: "r157" },
  { id: "mark_roots", units: 64, frames: R157.rootsMark, pack: "r157" },
  { id: "strike_roots", units: 64, frames: R157.rootsStrike, pack: "r157" },
];
