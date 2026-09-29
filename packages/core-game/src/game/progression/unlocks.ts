import { PASSIVE_CATEGORIES, type AccountUnlockDef, type LoadoutLimits } from "@bh/shared-types";

/**
 * Открытое уровнем аккаунта (docs/35-stage4-plan.md Р41, §3.13): движок сам
 * выводит из таблицы, что игроку доступно, по уровню из подписанного снимка.
 * Уровень не меняет баланс забега — только то, из чего игрок выбирает, и
 * сколько держит одновременно.
 */

export interface AccountUnlocks {
  weapons: ReadonlySet<string>;
  passives: ReadonlySet<string>;
  limits: LoadoutLimits;
}

/** Строки таблицы по возрастанию уровня: порядок в контенте — не контракт. */
function sortedRows(table: readonly AccountUnlockDef[]): AccountUnlockDef[] {
  return [...table].sort((a, b) => a.level - b.level);
}

/**
 * Открытое к уровню: всё со строк не выше него. Слоты — с последней строки,
 * которая их задаёт; категория, которую не задала ни одна, — ноль.
 */
export function unlocksAt(table: readonly AccountUnlockDef[], level: number): AccountUnlocks {
  const weapons = new Set<string>();
  const passives = new Set<string>();
  const limits: LoadoutLimits = { weapons: 0, passives: { attack: 0, defense: 0, mobility: 0 } };
  for (const row of sortedRows(table)) {
    if (row.level > level) break;
    for (const id of row.weapons ?? []) weapons.add(id);
    for (const id of row.passives ?? []) passives.add(id);
    if (row.slots?.weapons !== undefined) limits.weapons = row.slots.weapons;
    for (const category of PASSIVE_CATEGORIES) {
      const slots = row.slots?.passives?.[category];
      if (slots !== undefined) limits.passives[category] = slots;
    }
  }
  return { weapons, passives, limits };
}

/** На каком уровне открывается оружие или навык; `null` — таблица его не знает. */
export function unlockLevelOf(table: readonly AccountUnlockDef[], kind: "weapon" | "passive", id: string): number | null {
  for (const row of sortedRows(table)) {
    if ((kind === "weapon" ? row.weapons : row.passives)?.includes(id) === true) return row.level;
  }
  return null;
}

/** Что даёт сам уровень — для экрана уровня и плашки после забега; `null` — ничего. */
export function unlocksOfLevel(table: readonly AccountUnlockDef[], level: number): AccountUnlockDef | null {
  return table.find((row) => row.level === level) ?? null;
}

/**
 * Ошибки таблицы — сообщением, которое называет строку и поле. Проверяет тест
 * контента: таблица, по которой новичку нечего выбрать, не должна доехать до
 * игрока.
 */
export function findUnlockProblems(
  table: readonly AccountUnlockDef[],
  content: { weapons: readonly string[]; passives: ReadonlyMap<string, keyof LoadoutLimits["passives"]> },
  ceiling: LoadoutLimits,
): string[] {
  const problems: string[] = [];
  const rows = sortedRows(table);
  const first = rows[0];
  if (first?.level !== 1) problems.push("первая строка таблицы — первый уровень: новичку нужен стартовый набор");
  if ((first?.weapons ?? []).length === 0) problems.push("на первом уровне нет ни одного оружия: забег начать не с чем");

  const levels = new Set<number>();
  for (const row of rows) {
    if (!Number.isInteger(row.level) || row.level < 1) problems.push(`уровень ${String(row.level)}: ожидается целое от 1`);
    if (levels.has(row.level)) problems.push(`уровень ${String(row.level)} встречается дважды`);
    levels.add(row.level);
  }

  for (const [kind, ids] of [
    ["оружие", content.weapons],
    ["навык", [...content.passives.keys()]],
  ] as const) {
    for (const id of ids) {
      const found = rows.filter((row) => (kind === "оружие" ? row.weapons : row.passives)?.includes(id) === true);
      if (found.length === 0) problems.push(`${kind} ${id} не открывается ни на одном уровне`);
      if (found.length > 1) problems.push(`${kind} ${id} открывается на уровнях ${found.map((row) => String(row.level)).join(", ")}: ожидается один`);
    }
  }
  for (const row of rows) {
    for (const id of row.weapons ?? []) if (!content.weapons.includes(id)) problems.push(`уровень ${String(row.level)}: оружия ${id} нет в контенте`);
    for (const id of row.passives ?? []) if (!content.passives.has(id)) problems.push(`уровень ${String(row.level)}: навыка ${id} нет в контенте`);
  }

  let previous: LoadoutLimits | null = null;
  for (const row of rows) {
    const open = unlocksAt(rows, row.level);
    const limits = open.limits;
    if (limits.weapons < 1) problems.push(`уровень ${String(row.level)}: нет ни одного слота оружия`);
    if (limits.weapons > ceiling.weapons) problems.push(`уровень ${String(row.level)}: слотов оружия ${String(limits.weapons)} больше потолка ${String(ceiling.weapons)}`);
    for (const category of PASSIVE_CATEGORIES) {
      const slots = limits.passives[category];
      if (slots > ceiling.passives[category]) problems.push(`уровень ${String(row.level)}: слотов «${category}» ${String(slots)} больше потолка ${String(ceiling.passives[category])}`);
      const available = [...open.passives].filter((id) => content.passives.get(id) === category).length;
      if (slots > 0 && available <= slots) problems.push(`уровень ${String(row.level)}: навыков «${category}» открыто ${String(available)}, слотов ${String(slots)} — выбирать нечего`);
    }
    if (previous !== null) {
      if (limits.weapons < previous.weapons) problems.push(`уровень ${String(row.level)}: слотов оружия меньше, чем уровнем ниже`);
      for (const category of PASSIVE_CATEGORIES) {
        if (limits.passives[category] < previous.passives[category]) problems.push(`уровень ${String(row.level)}: слотов «${category}» меньше, чем уровнем ниже`);
      }
    }
    previous = limits;
  }

  // Всё открытое — ровно тот набор, на котором идут golden-тесты и коридоры
  // калибровки: иначе баланс «всё открыто» разошёлся бы с игрой прокачанного.
  if (previous !== null) {
    if (previous.weapons !== ceiling.weapons) problems.push(`на последнем уровне слотов оружия ${String(previous.weapons)}, а потолок ${String(ceiling.weapons)}`);
    for (const category of PASSIVE_CATEGORIES) {
      if (previous.passives[category] !== ceiling.passives[category]) {
        problems.push(`на последнем уровне слотов «${category}» ${String(previous.passives[category])}, а потолок ${String(ceiling.passives[category])}`);
      }
    }
  }
  return problems;
}
