import { CATEGORY_TITLES, ELEMENT_TITLES, EVENT_TITLES, PARAM_TITLES, PATTERN_TITLES, capitalize, enemyName, formatValue, type Names } from "./balance-rules";
import type { BalanceSnapshot } from "./balance-snapshot";

/**
 * Таблицы разделов баланса (tasks/T-0304): из снимка — модель, из модели
 * рисует компонент. Ячейка с `path` правится (число или выбор из списка), без
 * `path` — только читается. Новых записей и удаления в шаге 1 нет: новое
 * понятие — код (docs/19-content-admin.md §2), поэтому у отсутствующего
 * необязательного поля ячейки нет — «—».
 */

export const TABS = [
  { id: "enemies", title: "Враги" },
  { id: "stages", title: "Ступени" },
  { id: "timeline", title: "Таймлайн" },
  { id: "weapons", title: "Оружие" },
  { id: "passives", title: "Навыки" },
  { id: "unlocks", title: "Открытия" },
  { id: "drops", title: "Подборы и сундуки" },
  { id: "xp", title: "Опыт и сложность" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

export function isTabId(value: string | undefined): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

export interface SelectOption {
  value: string | number;
  label: string;
}

export interface GroupItem {
  label: string;
  /** пометка рядом: «стоек», «уязвим» */
  note?: string;
  cell: CellModel;
}

export type CellModel =
  | { kind: "number"; path: string; value: number }
  | { kind: "select"; path: string; value: string | number; options: readonly SelectOption[]; titleKey?: string }
  | { kind: "text"; text: string; muted?: boolean }
  | { kind: "group"; items: readonly GroupItem[] };

export interface ColumnModel {
  key: string;
  title: string;
  numeric?: boolean;
  /** ключ пояснения, тексты — `HELP.balance` */
  help?: string;
}

export interface RowModel {
  key: string;
  title: string;
  badges?: readonly string[];
  /** строка-заголовок на всю ширину: оружие над своими уровнями */
  heading?: boolean;
  /** ячейки по колонкам, кроме первой: она — название строки */
  cells: readonly CellModel[];
}

export interface TableModel {
  key: string;
  title?: string;
  /** ключ пояснения таблицы, тексты — `HELP.balance` */
  help?: string;
  columns: readonly ColumnModel[];
  rows: readonly RowModel[];
}

/** Пути всех правимых ячеек строки — по ним экран находит ошибку «под записью». */
export function cellPaths(row: RowModel): string[] {
  const paths: string[] = [];
  const visit = (cell: CellModel): void => {
    if (cell.kind === "group") for (const item of cell.items) visit(item.cell);
    else if (cell.kind !== "text") paths.push(cell.path);
  };
  for (const cell of row.cells) visit(cell);
  return paths;
}

const text = (value: string, muted = false): CellModel => ({ kind: "text", text: value, muted });
const dash = (): CellModel => text("—", true);
const number = (path: string, value: number | undefined): CellModel => (value === undefined ? dash() : { kind: "number", path, value });

function select(path: string, value: string, titles: Readonly<Record<string, string>>, titleKey: string): CellModel {
  const options: SelectOption[] = Object.entries(titles).map(([key, label]) => ({ value: key, label }));
  // Значение новее панели в списке не числится — оно остаётся выбранным, а не подменяется первым.
  if (!(value in titles)) options.push({ value, label: value });
  return { kind: "select", path, value, options, titleKey };
}

const col = (key: string, title: string, help?: string, numeric = true): ColumnModel => ({ key, title, numeric, ...(help === undefined ? {} : { help }) });

// --- Враги ---

const ELEMENT_ORDER = ["fire", "cold", "lightning", "poison"] as const;

function enemiesTable(snapshot: BalanceSnapshot, names: Names): TableModel {
  const rows = snapshot.enemies.map((enemy): RowModel => {
    const base = `enemies[id=${enemy.id}]`;
    const resist = ELEMENT_ORDER.flatMap((element): GroupItem[] => {
      const value = enemy.resist?.[element];
      if (value === undefined) return [];
      return [{ label: ELEMENT_TITLES[element] ?? element, note: value > 0 ? "стоек" : value < 0 ? "уязвим" : "", cell: { kind: "number", path: `${base}.resist.${element}`, value } }];
    });
    return {
      key: enemy.id,
      title: enemyName(names, enemy.id),
      badges: enemy.rank === "elite" ? ["элита"] : enemy.rank === "boss" ? ["босс"] : [],
      cells: [
        number(`${base}.hp`, enemy.hp),
        number(`${base}.speed`, enemy.speed),
        number(`${base}.damage`, enemy.damage),
        number(`${base}.xp`, enemy.xp),
        number(`${base}.threat`, enemy.threat),
        select(`${base}.pattern`, enemy.pattern, PATTERN_TITLES, "pattern"),
        resist.length === 0 ? dash() : { kind: "group", items: resist },
      ],
    };
  });
  return {
    key: "enemies",
    columns: [col("name", "Враг", undefined, false), col("hp", "Здоровье", "hp"), col("speed", "Скорость", "speed"), col("damage", "Урон", "damage"), col("xp", "Опыт", "xp"), col("threat", "Угроза", "threat"), col("pattern", "Поведение", "pattern", false), col("resist", "Стойкость", "resist", false)],
    rows,
  };
}

// --- Ступени ---

function stagesTable(snapshot: BalanceSnapshot, names: Names): TableModel {
  return {
    key: "stages",
    columns: [col("name", "Ступень", undefined, false), col("fromSec", "С секунды", "stageFrom"), col("weight", "Вес", "stageWeight"), col("hp", "Здоровье ×", "stageMul"), col("damage", "Урон ×", "stageMul"), col("speed", "Скорость ×", "stageMul"), col("xp", "Опыт ×", "stageMul")],
    rows: snapshot.stages.map((stage, index) => ({
      key: String(index),
      title: (stage.nameKey === undefined ? undefined : names[stage.nameKey]) ?? `Ступень ${String(index + 1)}`,
      cells: (["fromSec", "weight", "hpMul", "damageMul", "speedMul", "xpMul"] as const).map((field) => number(`stages[${String(index)}].${field}`, stage[field])),
    })),
  };
}

// --- Таймлайн ---

function paramRows(read: (path: string) => unknown, keys: readonly string[]): RowModel[] {
  return keys.flatMap((path): RowModel[] => {
    const value = read(path);
    return typeof value === "number" ? [{ key: path, title: capitalize(PARAM_TITLES[path] ?? path), cells: [{ kind: "number", path, value }] }] : [];
  });
}

const reader = (snapshot: BalanceSnapshot) => (path: string): unknown => {
  let node: unknown = snapshot;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
};

const PARAM_COLUMNS: readonly ColumnModel[] = [col("name", "Параметр", undefined, false), col("value", "Значение")];

function timelineTables(snapshot: BalanceSnapshot, names: Names): TableModel[] {
  const segments: TableModel = {
    key: "segments",
    title: "Отрезки таймлайна",
    help: "timeline",
    columns: [col("name", "Отрезок", undefined, false), col("fromSec", "Секунда", "segmentFrom"), col("maxAlive", "Потолок живых", "maxAlive"), col("spawns", "Поток, врагов в секунду", "spawnRate", false), col("burst", "Выброс в начале", "burst", false), col("events", "События", "events", false)],
    rows: snapshot.timeline.map((segment, index): RowModel => {
      const at = `timeline[${String(index)}]`;
      const spawnItems = (field: "perSec" | "burst"): CellModel => {
        const items = segment.spawns.flatMap((spawn, spawnIndex): GroupItem[] => {
          const value = spawn[field];
          return value === undefined ? [] : [{ label: enemyName(names, spawn.enemy), cell: { kind: "number", path: `${at}.spawns[${String(spawnIndex)}].${field}`, value } }];
        });
        return items.length === 0 ? dash() : { kind: "group", items };
      };
      const events = (segment.events ?? []).map((event, eventIndex): GroupItem => ({
        label: `${EVENT_TITLES[event.kind] ?? event.kind} · ${enemyName(names, event.enemy)} ×`,
        cell: { kind: "number", path: `${at}.events[${String(eventIndex)}].count`, value: event.count },
      }));
      return {
        key: String(index),
        title: `Отрезок ${String(index + 1)}`,
        cells: [number(`${at}.fromSec`, segment.fromSec), number(`${at}.maxAlive`, segment.maxAlive), spawnItems("perSec"), spawnItems("burst"), events.length === 0 ? dash() : { kind: "group", items: events }],
      };
    }),
  };

  const curve = snapshot.endlessCurve;
  const pool = Array.isArray(curve.pool) ? curve.pool.filter((id): id is string => typeof id === "string").map((id) => enemyName(names, id)) : [];
  const curveEvents = Array.isArray(curve.events) ? curve.events : [];
  const eventLines = curveEvents.flatMap((event): string[] => {
    if (typeof event !== "object" || event === null) return [];
    const { kind, enemy, count, everySegments } = event as Record<string, unknown>;
    if (typeof kind !== "string" || typeof enemy !== "string") return [];
    return [`${EVENT_TITLES[kind] ?? kind} · ${enemyName(names, enemy)} ×${formatValue(count)} раз в ${formatValue(everySegments)} отр.`];
  });
  const endless: TableModel = {
    key: "endless",
    title: "Бесконечный режим",
    help: "endless",
    columns: PARAM_COLUMNS,
    rows: [
      ...paramRows(reader(snapshot), Object.keys(PARAM_TITLES).filter((path) => path.startsWith("endlessCurve."))),
      ...(pool.length === 0 ? [] : [{ key: "pool", title: "Порядок ввода типов", cells: [text(pool.join(" → "), true)] }]),
      ...eventLines.map((line, index): RowModel => ({ key: `event${String(index)}`, title: index === 0 ? "События кривой" : "", cells: [text(line, true)] })),
    ],
  };
  return [segments, endless];
}

// --- Оружие ---

const BEHAVIOR_TITLES: Readonly<Record<string, string>> = {
  projectile_nearest: "снаряд в ближнего",
  projectile_facing: "снаряды вперёд",
  orbit: "обереги по кругу",
  aura: "зона вокруг",
  area_strike: "удар по площади",
};

const LEVEL_FIELDS = ["damage", "cooldownSec", "projectiles", "pierce", "areaRadius", "projectileSpeed", "ttlSec", "statusChance"] as const;

function weaponsTable(snapshot: BalanceSnapshot, names: Names): TableModel {
  const passiveName = (id: string): string => {
    const passive = snapshot.passives.find((candidate) => candidate.id === id);
    return passive === undefined ? id : (names[passive.nameKey] ?? id);
  };
  const rows = snapshot.weapons.flatMap((weapon): RowModel[] => {
    const badges = [BEHAVIOR_TITLES[weapon.behavior] ?? weapon.behavior];
    if (weapon.element !== undefined) badges.push(ELEMENT_TITLES[weapon.element] ?? weapon.element);
    if (weapon.evolvedFrom !== undefined) badges.push(`эволюция${weapon.recipe === undefined ? "" : ` · рецепт: ${passiveName(weapon.recipe.passive)}`}`);
    const heading: RowModel = { key: weapon.id, title: names[weapon.nameKey] ?? weapon.id, badges, heading: true, cells: [] };
    const levels = weapon.levels.map((level, index): RowModel => ({
      key: `${weapon.id}.${String(index)}`,
      title: `Уровень ${String(index + 1)}`,
      cells: LEVEL_FIELDS.map((field) => number(`weapons[id=${weapon.id}].levels[${String(index)}].${field}`, level[field])),
    }));
    return [heading, ...levels];
  });
  return {
    key: "weapons",
    columns: [
      col("name", "Оружие", undefined, false),
      col("damage", "Урон", "weaponDamage"),
      col("cooldown", "Перезарядка, с", "cooldown"),
      col("projectiles", "Снарядов", "projectiles"),
      col("pierce", "Пробивает", "pierce"),
      col("area", "Радиус", "areaRadius"),
      col("speed", "Скорость снаряда", "projectileSpeed"),
      col("ttl", "Жизнь, с", "ttl"),
      col("status", "Шанс состояния", "statusChance"),
    ],
    rows,
  };
}

// --- Навыки ---

const STAT_TITLES: Readonly<Record<string, string>> = {
  damage: "урон",
  cooldown: "перезарядка",
  area: "область",
  projectileSpeed: "скорость снаряда",
  duration: "длительность",
  projectiles: "снаряды",
  moveSpeed: "скорость бега",
  maxHp: "здоровье",
  regenPerSec: "лечение в секунду",
  pickupRadius: "радиус подбора",
  armor: "броня",
  resist: "сопротивление всем",
  resistFire: "сопротивление огню",
  resistCold: "сопротивление холоду",
  resistLightning: "сопротивление молнии",
  resistPoison: "сопротивление яду",
};

function passivesTable(snapshot: BalanceSnapshot, names: Names): TableModel {
  const depth = Math.max(0, ...snapshot.passives.map((passive) => passive.levels.length));
  const levelColumns = Array.from({ length: depth }, (_, index) => col(`level${String(index)}`, `Ур. ${String(index + 1)}`, "passiveLevels"));
  return {
    key: "passives",
    columns: [col("name", "Навык", undefined, false), col("category", "Категория", "passiveCategory", false), col("stat", "Что меняет", undefined, false), ...levelColumns],
    rows: snapshot.passives.map((passive): RowModel => ({
      key: passive.id,
      title: names[passive.nameKey] ?? passive.id,
      cells: [
        select(`passives[id=${passive.id}].category`, passive.category, CATEGORY_TITLES, "category"),
        text(`${STAT_TITLES[passive.stat] ?? passive.stat} ${passive.op === "mul" ? "×" : "+"}`, true),
        ...Array.from({ length: depth }, (_, index): CellModel => number(`passives[id=${passive.id}].levels[${String(index)}]`, passive.levels[index])),
      ],
    })),
  };
}

// --- Открытия ---

function unlocksTable(snapshot: BalanceSnapshot, names: Names): TableModel {
  const nameBy = (list: readonly { id: string; nameKey: string }[], id: string): string => {
    const found = list.find((candidate) => candidate.id === id);
    return found === undefined ? id : (names[found.nameKey] ?? id);
  };
  const listText = (ids: readonly string[] | undefined, list: readonly { id: string; nameKey: string }[]): CellModel => (ids === undefined || ids.length === 0 ? dash() : text(ids.map((id) => nameBy(list, id)).join(", ")));
  return {
    key: "unlocks",
    help: "unlocks",
    columns: [col("level", "Уровень аккаунта", undefined, false), col("weapons", "Открывает оружие", undefined, false), col("passives", "Открывает навыки", undefined, false), col("slotsWeapons", "Слоты оружия", "unlockSlots"), col("attack", "Слоты: атака", "unlockSlots"), col("defense", "Слоты: защита", "unlockSlots"), col("mobility", "Слоты: подвижность", "unlockSlots")],
    rows: snapshot.accountUnlocks.map((unlock, index): RowModel => {
      const at = `accountUnlocks[${String(index)}].slots`;
      return {
        key: String(index),
        title: `Уровень ${formatValue(unlock.level)}`,
        cells: [
          listText(unlock.weapons, snapshot.weapons),
          listText(unlock.passives, snapshot.passives),
          number(`${at}.weapons`, unlock.slots?.weapons),
          number(`${at}.passives.attack`, unlock.slots?.passives?.attack),
          number(`${at}.passives.defense`, unlock.slots?.passives?.defense),
          number(`${at}.passives.mobility`, unlock.slots?.passives?.mobility),
        ],
      };
    }),
  };
}

// --- Подборы и сундуки ---

const CHEST_SIZES: readonly SelectOption[] = [1, 3, 5].map((size) => ({ value: size, label: String(size) }));

function dropsTables(snapshot: BalanceSnapshot): TableModel[] {
  const read = reader(snapshot);
  const drops: TableModel = {
    key: "drops",
    title: "Подборы",
    help: "drops",
    columns: PARAM_COLUMNS,
    rows: paramRows(read, Object.keys(PARAM_TITLES).filter((path) => path.startsWith("drops."))),
  };

  const sizeRows = (list: readonly { size: number; weight: number }[], base: string, prefix: string): RowModel[] =>
    list.map((entry, index) => ({ key: `${base}${String(index)}`, title: `${prefix}размер ${String(entry.size)} · вес`, cells: [{ kind: "number", path: `${base}[${String(index)}].weight`, value: entry.weight }] }));
  const chests = snapshot.chests;
  const opening: RowModel = {
    key: "opening",
    title: "Первые сундуки по порядку (размеры)",
    cells: [{ kind: "group", items: chests.opening.map((size, index): GroupItem => ({ label: String(index + 1), cell: { kind: "select", path: `chests.opening[${String(index)}]`, value: size, options: CHEST_SIZES } })) }],
  };
  const bossMin = (path: string): RowModel[] => {
    const value = read(path);
    return typeof value === "number" ? [{ key: path, title: capitalize(PARAM_TITLES[path] ?? path), cells: [{ kind: "select", path, value, options: CHEST_SIZES }] }] : [];
  };
  const scalar = ["chests.ownedWeightMul", "chests.lowHpRatio", "chests.xpRatio", "chests.maxOnField"];
  const chestsTable: TableModel = {
    key: "chests",
    title: "Сундуки",
    help: "chests",
    columns: PARAM_COLUMNS,
    rows: [
      opening,
      ...sizeRows(chests.sizes, "chests.sizes", ""),
      ...bossMin("chests.bossMinSize"),
      ...paramRows(read, scalar),
      ...(chests.late === undefined ? [] : [...paramRows(read, ["chests.late.afterSec"]), ...sizeRows(chests.late.sizes, "chests.late.sizes", "поздние · "), ...bossMin("chests.late.bossMinSize")]),
    ],
  };
  return [drops, chestsTable];
}

// --- Опыт и сложность ---

function xpTables(snapshot: BalanceSnapshot, names: Names): TableModel[] {
  const curve: TableModel = {
    key: "curve",
    title: "Кривая опыта",
    help: "levelCurve",
    columns: PARAM_COLUMNS,
    rows: paramRows(reader(snapshot), Object.keys(PARAM_TITLES).filter((path) => path.startsWith("levelCurve."))),
  };
  const difficulties: TableModel = {
    key: "difficulties",
    title: "Сложность",
    help: "difficulty",
    columns: [col("name", "Сложность", undefined, false), col("hp", "Здоровье врагов ×", "difficultyMul"), col("damage", "Урон врагов ×", "difficultyMul"), col("spawn", "Темп спавна ×", "difficultyMul"), col("alive", "Потолок живых ×", "difficultyMul")],
    rows: snapshot.difficulties.map((difficulty, index): RowModel => ({
      key: difficulty.id,
      title: names[difficulty.nameKey] ?? difficulty.id,
      cells: (["enemyHpMul", "enemyDamageMul", "spawnRateMul", "maxAliveMul"] as const).map((field) => number(`difficulties[${String(index)}].${field}`, difficulty[field])),
    })),
  };
  return [curve, difficulties];
}

/** Таблицы раздела по снимку; имена — из словаря версии. */
export function tablesFor(tab: TabId, snapshot: BalanceSnapshot, names: Names): TableModel[] {
  switch (tab) {
    case "enemies":
      return [enemiesTable(snapshot, names)];
    case "stages":
      return [stagesTable(snapshot, names)];
    case "timeline":
      return timelineTables(snapshot, names);
    case "weapons":
      return [weaponsTable(snapshot, names)];
    case "passives":
      return [passivesTable(snapshot, names)];
    case "unlocks":
      return [unlocksTable(snapshot, names)];
    case "drops":
      return dropsTables(snapshot);
    case "xp":
      return xpTables(snapshot, names);
  }
}

const TAB_OF_ROOT: Readonly<Record<string, TabId>> = {
  enemies: "enemies",
  stages: "stages",
  timeline: "timeline",
  endlessCurve: "timeline",
  weapons: "weapons",
  passives: "passives",
  accountUnlocks: "unlocks",
  drops: "drops",
  chests: "drops",
  levelCurve: "xp",
  difficulties: "xp",
};

/** В каком разделе лежит ячейка с этим путём; незнакомый корень — `null`. */
export function tabOfPath(path: string): TabId | null {
  const root = /^[A-Za-z_][A-Za-z0-9_]*/.exec(path)?.[0];
  return root === undefined ? null : (TAB_OF_ROOT[root] ?? null);
}
