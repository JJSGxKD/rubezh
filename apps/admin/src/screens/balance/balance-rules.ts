import type { ApiResult } from "../../api/client";
import type { DraftChange, PatchResult } from "../../api/content";
import { formatDuration } from "../../format";

/**
 * Правила экрана «Баланс» (tasks/T-0304): путь правки, подписи словами, что
 * делает ответ сервера с состоянием. Без React и сети: проверяется тестом.
 *
 * Путь — тот же, что у сервера (`backend/api/src/modules/content/content-path.ts`):
 * `enemies[id=swarm_rat].hp`, `timeline[3].spawns[0].perSec`. Панель его только
 * собирает и читает; решает, годится ли значение, сервер.
 */

/** Словарь имён из версии: ключ → текст игры. */
export type Names = Readonly<Record<string, string>>;

// --- Путь ---

export type PathSegment = { kind: "key"; name: string } | { kind: "index"; index: number } | { kind: "find"; field: string; value: string };

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Путь на элемент списка врагов по id: ключи с точкой и скобкой не бывают — это слаги. */
export function enemyCellPath(enemyId: string, field: string): string {
  return `enemies[id=${enemyId}].${field}`;
}

/** Разбор пути; `null` — путь не разобрался (панель такие не строит, но подпись правки не должна падать). */
export function parsePath(path: string): PathSegment[] | null {
  if (path === "") return null;
  const segments: PathSegment[] = [];
  let position = 0;
  while (position < path.length) {
    let end = position;
    while (end < path.length && /[A-Za-z0-9_]/.test(path.charAt(end))) end += 1;
    const name = path.slice(position, end);
    if (!KEY.test(name) || FORBIDDEN_KEYS.has(name)) return null;
    segments.push({ kind: "key", name });
    position = end;
    while (path.charAt(position) === "[") {
      const close = path.indexOf("]", position);
      if (close < 0) return null;
      const inner = path.slice(position + 1, close);
      const eq = inner.indexOf("=");
      if (/^\d{1,6}$/.test(inner)) segments.push({ kind: "index", index: Number(inner) });
      else if (eq > 0 && KEY.test(inner.slice(0, eq)) && inner.slice(eq + 1) !== "") segments.push({ kind: "find", field: inner.slice(0, eq), value: inner.slice(eq + 1) });
      else return null;
      position = close + 1;
    }
    if (position === path.length) break;
    if (path.charAt(position) !== ".") return null;
    position += 1;
    if (position === path.length) return null;
  }
  return segments;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Шаг вглубь: следующий узел и его ключ в родителе; `null` — такого места нет. */
function step(node: unknown, segment: PathSegment): { next: unknown; key: string | number } | null {
  if (segment.kind === "key") {
    return isObject(node) && Object.hasOwn(node, segment.name) ? { next: node[segment.name], key: segment.name } : null;
  }
  if (!Array.isArray(node)) return null;
  if (segment.kind === "index") return segment.index < node.length ? { next: node[segment.index], key: segment.index } : null;
  const found: number[] = [];
  node.forEach((item, index) => {
    if (isObject(item) && Object.hasOwn(item, segment.field) && String(item[segment.field]) === segment.value) found.push(index);
  });
  const only = found.length === 1 ? (found[0] as number) : -1;
  return only < 0 ? null : { next: node[only], key: only };
}

/** Значение по пути; `undefined` — места нет. */
export function readAtPath(root: unknown, path: string): unknown {
  const segments = parsePath(path);
  if (segments === null) return undefined;
  let node: unknown = root;
  for (const segment of segments) {
    const moved = step(node, segment);
    if (moved === null) return undefined;
    node = moved.next;
  }
  return node;
}

/**
 * Копия снимка с новым значением по пути. Нет такого места — тот же объект:
 * сервер уже принял правку, и теряться из-за незнакомого пути экрану нельзя,
 * но и придумывать места он не должен.
 */
export function setAtPath(root: unknown, path: string, value: unknown): unknown {
  const segments = parsePath(path);
  if (segments === null || segments.length === 0 || readAtPath(root, path) === undefined) return root;
  const copy: unknown = structuredClone(root);
  let node: unknown = copy;
  for (const segment of segments.slice(0, -1)) {
    const moved = step(node, segment);
    if (moved === null) return root;
    node = moved.next;
  }
  const last = segments[segments.length - 1] as PathSegment;
  const target = step(node, last);
  if (target === null) return root;
  if (Array.isArray(node)) node[target.key as number] = value;
  else if (isObject(node)) node[target.key as string] = value;
  return copy;
}

// --- Значения ---

const NUMBER = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 });

export const PATTERN_TITLES: Readonly<Record<string, string>> = {
  swarm: "рой",
  chase: "погоня",
  dash: "рывок",
  orbit: "кружит",
  exploder: "взрыв",
  splitter: "делится",
  rush: "наскок",
  cordon: "страж",
};

export const CATEGORY_TITLES: Readonly<Record<string, string>> = { attack: "атака", defense: "защита", mobility: "подвижность" };
export const ELEMENT_TITLES: Readonly<Record<string, string>> = { fire: "огонь", cold: "холод", lightning: "молния", poison: "яд" };
export const EVENT_TITLES: Readonly<Record<string, string>> = { ring: "кольцо", flank: "фланг", cordon: "строй" };

/** Значение выбора словами: `dash` → «рывок»; незнакомое — как есть. */
const SELECT_TITLES: Readonly<Record<string, Readonly<Record<string, string>>>> = { pattern: PATTERN_TITLES, category: CATEGORY_TITLES, kind: EVENT_TITLES };

export function formatValue(value: unknown, key?: string): string {
  if (value === null || value === undefined) return "не было";
  if (typeof value === "number") return NUMBER.format(value);
  if (typeof value === "string") return (key === undefined ? undefined : SELECT_TITLES[key]?.[value]) ?? value;
  return JSON.stringify(value);
}

/**
 * Число из поля ввода: десятичная запятая и точка. Пустое, мусор и
 * бесконечность — `null`: такое на сервер не уходит, ячейка вернёт прежнее.
 */
export function commitValue(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// --- Подписи словами ---

const FIELD_TITLES: Readonly<Record<string, string>> = {
  hp: "здоровье",
  speed: "скорость",
  damage: "урон",
  xp: "опыт",
  threat: "угроза",
  pattern: "поведение",
  fromSec: "секунда",
  weight: "вес",
  hpMul: "здоровье ×",
  damageMul: "урон ×",
  speedMul: "скорость ×",
  xpMul: "опыт ×",
  maxAlive: "потолок живых",
  perSec: "темп",
  burst: "выброс",
  count: "число",
  cooldownSec: "перезарядка",
  projectiles: "снаряды",
  pierce: "пробивает",
  areaRadius: "радиус",
  projectileSpeed: "скорость снаряда",
  ttlSec: "время жизни",
  statusChance: "шанс состояния",
  category: "категория",
  level: "уровень",
  enemyHpMul: "здоровье врагов ×",
  enemyDamageMul: "урон врагов ×",
  spawnRateMul: "темп спавна ×",
  maxAliveMul: "потолок живых ×",
};

/**
 * Названия параметров-одиночек по пути без номеров: кривая бесконечного
 * режима, подборы, сундуки, кривая опыта. Строчными — таблица поднимает первую
 * букву, подпись правки оставляет как есть.
 */
export const PARAM_TITLES: Readonly<Record<string, string>> = {
  "endlessCurve.fromSec": "с какой секунды",
  "endlessCurve.segmentSec": "длина отрезка, с",
  "endlessCurve.threatPerSec": "бюджет угрозы в секунду",
  "endlessCurve.threatGrowth": "рост угрозы",
  "endlessCurve.maxAlive": "потолок живых",
  "endlessCurve.hpGrowth": "рост здоровья за отрезок",
  "endlessCurve.damageGrowth": "рост урона за отрезок",
  "endlessCurve.startTypes": "типов на старте",
  "endlessCurve.typesPerSegment": "типов за отрезок",
  "endlessCurve.mixSize": "типов в смеси",
  "drops.gems.maxPerKill": "кристаллы · не больше с убийства",
  "drops.medkits.chance": "аптечка · шанс с рядового",
  "drops.medkits.eliteChance": "аптечка · шанс с элиты",
  "drops.medkits.healRatio": "аптечка · лечит долю здоровья",
  "drops.medkits.maxOnField": "аптечка · на поле",
  "drops.magnets.chance": "магнит · шанс с рядового",
  "drops.magnets.eliteChance": "магнит · шанс с элиты",
  "drops.magnets.maxOnField": "магнит · на поле",
  "drops.dynamite.chance": "динамит · шанс с рядового",
  "drops.dynamite.eliteChance": "динамит · шанс с элиты",
  "drops.dynamite.maxOnField": "динамит · на поле",
  "drops.dynamite.radiusUnits": "динамит · радиус взрыва",
  "drops.dynamite.eliteHpRatio": "динамит · доля здоровья элиты",
  "drops.freeze.chance": "заморозка · шанс с рядового",
  "drops.freeze.eliteChance": "заморозка · шанс с элиты",
  "drops.freeze.maxOnField": "заморозка · на поле",
  "drops.freeze.durationSec": "заморозка · срок, с",
  "drops.freeze.bossDurationRatio": "заморозка · доля срока у босса",
  "chests.bossMinSize": "сундук с босса не меньше",
  "chests.ownedWeightMul": "вес взятого к новому",
  "chests.lowHpRatio": "аптечка ниже доли здоровья",
  "chests.xpRatio": "запасной опыт, доля уровня",
  "chests.maxOnField": "сундуков на поле",
  "chests.late.afterSec": "поздние сундуки · с секунды",
  "chests.late.bossMinSize": "поздние · сундук с босса не меньше",
  "levelCurve.baseXp": "опыт на второй уровень",
  "levelCurve.growth": "рост цены уровня",
  "levelCurve.late.fromLevel": "поздний рост · с уровня",
  "levelCurve.late.growth": "поздний рост цены уровня",
};

export function capitalize(text: string): string {
  return text === "" ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Путь без номеров и значений в скобках: `chests.late.afterSec`. */
function plainPath(segments: readonly PathSegment[]): string {
  return segments.filter((segment) => segment.kind === "key").map((segment) => segment.name).join(".");
}

export function enemyName(names: Names, id: string): string {
  return names[`enemy.${id}.name`] ?? id;
}

const nameOf = (names: Names, key: unknown, fallback: string): string => (typeof key === "string" ? (names[key] ?? fallback) : fallback);

function fieldTitle(key: string): string {
  return FIELD_TITLES[key] ?? key;
}

/** Части подписи; `null` — путь незнакомый или места нет, подпись — сам путь. */
function labelParts(segments: readonly PathSegment[], root: unknown, names: Names): string[] | null {
  const [first, second, ...rest] = segments;
  if (first?.kind !== "key") return null;
  const tail = (list: readonly PathSegment[]): string[] => list.filter((segment) => segment.kind === "key").map((segment) => fieldTitle(segment.name));

  switch (first.name) {
    case "enemies": {
      const enemy = idOf(second);
      if (enemy === null) return null;
      const [field, element] = rest;
      if (field?.kind === "key" && field.name === "resist" && element?.kind === "key") return [enemyName(names, enemy), `стойкость: ${ELEMENT_TITLES[element.name] ?? element.name}`];
      return [enemyName(names, enemy), ...tail(rest)];
    }
    case "stages": {
      if (second?.kind !== "index") return null;
      const stage = readAtPath(root, `stages[${String(second.index)}]`);
      const key = isObject(stage) ? stage.nameKey : undefined;
      return [nameOf(names, key, `Ступень ${String(second.index + 1)}`), ...tail(rest)];
    }
    case "timeline": {
      if (second?.kind !== "index") return null;
      const start = readAtPath(root, `timeline[${String(second.index)}].fromSec`);
      const head = ["Таймлайн", typeof start === "number" ? `с ${formatDuration(start)}` : `отрезок ${String(second.index + 1)}`];
      const [list, item, ...field] = rest;
      if (list?.kind === "key" && item?.kind === "index" && (list.name === "spawns" || list.name === "events")) {
        const entry = readAtPath(root, `timeline[${String(second.index)}].${list.name}[${String(item.index)}]`);
        const enemy = isObject(entry) && typeof entry.enemy === "string" ? enemyName(names, entry.enemy) : `№${String(item.index + 1)}`;
        const kind = list.name === "events" && isObject(entry) && typeof entry.kind === "string" ? `${EVENT_TITLES[entry.kind] ?? entry.kind} ` : "";
        return [...head, `${kind}${enemy}`, ...tail(field)];
      }
      return [...head, ...tail(rest)];
    }
    case "endlessCurve":
      return ["Бесконечный режим", PARAM_TITLES[plainPath(segments)] ?? tail([second as PathSegment, ...rest]).join(" · ")];
    case "weapons": {
      const weapon = idOf(second);
      if (weapon === null) return null;
      const entry = readAtPath(root, `weapons[id=${weapon}]`);
      const name = nameOf(names, isObject(entry) ? entry.nameKey : undefined, weapon);
      const [levels, level, ...field] = rest;
      if (levels?.kind === "key" && levels.name === "levels" && level?.kind === "index") return [name, `уровень ${String(level.index + 1)}`, ...tail(field)];
      return [name, ...tail(rest)];
    }
    case "passives": {
      const passive = idOf(second);
      if (passive === null) return null;
      const entry = readAtPath(root, `passives[id=${passive}]`);
      const name = nameOf(names, isObject(entry) ? entry.nameKey : undefined, passive);
      const [levels, level] = rest;
      if (levels?.kind === "key" && levels.name === "levels" && level?.kind === "index") return [name, `уровень ${String(level.index + 1)}`, "значение"];
      return [name, ...tail(rest)];
    }
    case "accountUnlocks": {
      if (second?.kind !== "index") return null;
      const level = readAtPath(root, `accountUnlocks[${String(second.index)}].level`);
      const slot = rest.filter((segment) => segment.kind === "key").map((segment) => segment.name);
      const title = slot[0] === "slots" ? `слоты: ${slotTitle(slot.slice(1))}` : tail(rest).join(" · ");
      return [`Уровень аккаунта ${typeof level === "number" ? String(level) : String(second.index + 1)}`, title];
    }
    case "drops":
      return ["Подборы", PARAM_TITLES[plainPath(segments)] ?? plainPath(segments)];
    case "chests": {
      const plain = plainPath(segments);
      const [list, item] = [second, rest[0]];
      if (list?.kind === "key" && item?.kind === "index") {
        const entry = readAtPath(root, `chests.${list.name}[${String(item.index)}]`);
        const size = isObject(entry) && typeof entry.size === "number" ? `размер ${String(entry.size)}` : `№${String(item.index + 1)}`;
        return ["Сундуки", list.name === "opening" ? `первый сундук ${String(item.index + 1)}` : `${size} · вес`];
      }
      if (list?.kind === "key" && list.name === "late" && rest[0]?.kind === "key" && rest[0].name === "sizes" && rest[1]?.kind === "index") {
        const entry = readAtPath(root, `chests.late.sizes[${String(rest[1].index)}]`);
        return ["Сундуки", `поздние · размер ${isObject(entry) && typeof entry.size === "number" ? String(entry.size) : String(rest[1].index + 1)} · вес`];
      }
      return ["Сундуки", PARAM_TITLES[plain] ?? plain];
    }
    case "levelCurve":
      return ["Кривая опыта", PARAM_TITLES[plainPath(segments)] ?? plainPath(segments)];
    case "difficulties": {
      if (second?.kind !== "index") return null;
      const entry = readAtPath(root, `difficulties[${String(second.index)}]`);
      const id = isObject(entry) && typeof entry.id === "string" ? entry.id : String(second.index + 1);
      return [nameOf(names, isObject(entry) ? entry.nameKey : undefined, id), ...tail(rest)];
    }
    default:
      return null;
  }
}

function idOf(segment: PathSegment | undefined): string | null {
  return segment?.kind === "find" && segment.field === "id" ? segment.value : null;
}

function slotTitle(keys: readonly string[]): string {
  const [first, second] = keys;
  if (first === "weapons") return "оружие";
  if (first === "passives" && second !== undefined) return CATEGORY_TITLES[second] ?? second;
  return keys.join(".");
}

/** Что правится, словами: «Волк · урон». Незнакомый путь — как есть. */
export function describePath(path: string, root: unknown, names: Names): string {
  const segments = parsePath(path);
  const parts = segments === null ? null : labelParts(segments, root, names);
  return parts === null ? path : parts.join(" · ");
}

/** Правка в списке: «Волк · урон 7 → 9». У нового поля — «→ 2 (раньше не было)». */
export function describeChange(change: DraftChange, root: unknown, names: Names): string {
  const label = describePath(change.path, root, names);
  const segments = parsePath(change.path);
  const last = segments?.filter((segment) => segment.kind === "key").pop();
  const key = last?.kind === "key" ? last.name : undefined;
  if (change.from === null || change.from === undefined) return `${label} → ${formatValue(change.to, key)} (раньше не было)`;
  return `${label} ${formatValue(change.from, key)} → ${formatValue(change.to, key)}`;
}

/** Правки по пути: ячейка узнаёт по ним, что изменена и что было. */
export function indexChanges(changes: readonly DraftChange[]): Map<string, DraftChange> {
  return new Map(changes.map((change) => [change.path, change]));
}

/**
 * Запрос «Вернуть»: прежнее значение по тому же пути. Поля в основе не было —
 * `null`: сервер умеет заменять, но не убирать, и честнее сказать об этом,
 * чем отправить `null` и получить 422.
 */
export function revertOf(change: DraftChange): { path: string; value: unknown } | null {
  return change.from === null || change.from === undefined ? null : { path: change.path, value: change.from };
}

// --- Состояние правок ---

/** Отказ сервера по одной ячейке: введённое остаётся в поле, под записью — строка. */
export interface CellError {
  typed: string;
  message: string;
  was: string;
}

/** Снимок черновика как пришёл (JSON) и отказы по путям ячеек. */
export interface EditorState {
  snapshot: unknown;
  errors: Readonly<Record<string, CellError>>;
}

/** Правка, которую человек сделал: путь, что набрано, что было в ячейке. */
export interface PatchInput {
  path: string;
  typed: string;
  wasText: string;
}

/** Текст сервера начинается с пути до поля — человеку его пишем словами. */
function humanize(message: string, root: unknown, names: Names): string {
  const match = /^(\S+): ([\s\S]+)$/.exec(message);
  if (match === null) return message;
  const label = describePath(match[1] as string, root, names);
  return label === match[1] ? message : `${label}: ${match[2] as string}`;
}

/**
 * Итог запроса правки. Принято — значение в снимке, отказ этой ячейки снят.
 * Отказ формы (422) — снимок не меняется (тот же объект), а отказ запоминается.
 * Сбой связи или права — состояние прежнее: об этом скажет уведомление, а строка
 * «нельзя сохранить» врала бы, что число плохое.
 */
export function afterPatch(state: EditorState, input: PatchInput, result: ApiResult<PatchResult>, names: Names): EditorState {
  if (result.ok) {
    const errors = Object.fromEntries(Object.entries(state.errors).filter(([path]) => path !== input.path));
    return { snapshot: result.data.changed ? setAtPath(state.snapshot, input.path, result.data.to) : state.snapshot, errors };
  }
  if (result.error.kind !== "rejected") return state;
  const error: CellError = { typed: input.typed, message: humanize(result.error.message, state.snapshot, names), was: input.wasText };
  return { snapshot: state.snapshot, errors: { ...state.errors, [input.path]: error } };
}

/** Строка под записью: текст сервера и «Было {n}». */
export function errorLine(error: CellError): string {
  return `${error.message.replace(/\.$/, "")}. Было ${error.was}.`;
}
