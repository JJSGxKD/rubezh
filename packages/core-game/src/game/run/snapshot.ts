import type { Spawner } from "../sim/spawner";
import type { World } from "../sim/world";

/**
 * Снимок забега: всё, что меняется по ходу игры, в виде, пригодном для
 * хранения на устройстве. По нему прерванный забег продолжается с того же
 * тика — после сворачивания, вылета или перезапуска приложения.
 *
 * Снимок, а не повтор по логу ввода: лог даёт тот же забег, но десять минут
 * симуляции на бюджетном Android пересчитываются секундами, а снимок
 * восстанавливается мгновенно. Лог остаётся за диагностикой
 * (docs/28-diagnostics.md §3.4).
 *
 * Типизированные массивы пулов идут в base64 только в занятой части
 * (`count`): за её границей слоты ни разу не использовались и совпадают с
 * только что созданным пулом. Числа при этом переносятся побитово, и
 * продолженный забег идёт ровно так же, как шёл бы без перерыва — это
 * проверяет тест.
 */

/** Меняется при любой правке формата: старый снимок тогда не читается, а не читается криво. */
export const WORLD_SNAPSHOT_VERSION = 6;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(`Снимок забега не читается: ${message}`);
    this.name = "SnapshotError";
  }
}

type TypedArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Int16Array
  | Uint32Array
  | Uint8Array;

type TypedKind = "f64" | "f32" | "i32" | "i16" | "u32" | "u8";

interface EncodedArray {
  kind: TypedKind;
  length: number;
  data: string;
}

interface EncodedPool {
  scalars: Record<string, number>;
  arrays: Record<string, EncodedArray>;
}

export interface WorldSnapshot {
  version: number;
  rng: number;
  player: World["player"];
  playerStats: World["playerStats"];
  playerStatsBase: World["playerStatsBase"];
  loadout: World["loadout"];
  progression: World["progression"];
  difficulty: World["difficulty"];
  gemMergeCursor: number;
  stats: EncodedPool;
  enemies: EncodedPool;
  projectiles: EncodedPool;
  gems: EncodedPool;
  pickups: EncodedPool;
  spawner: unknown;
}

/** Снять состояние мира и директора спавна. Мир при этом не меняется. */
export function captureWorld(world: World, spawner: Spawner): WorldSnapshot {
  return {
    version: WORLD_SNAPSHOT_VERSION,
    rng: world.rng.getState(),
    player: { ...world.player },
    playerStats: { ...world.playerStats },
    playerStatsBase: { ...world.playerStatsBase },
    // Набор и прогрессия — обычные объекты с вложенными массивами: копия через
    // JSON отрезает ссылки на живой мир, и дальнейший забег снимок не меняет.
    loadout: cloneJson(world.loadout),
    progression: cloneJson(world.progression),
    difficulty: { ...world.difficulty },
    gemMergeCursor: world.gemMergeCursor,
    stats: encodeRecord(world.stats, Number.POSITIVE_INFINITY),
    enemies: encodeRecord(world.enemies, world.enemies.count),
    projectiles: encodeRecord(world.projectiles, world.projectiles.count),
    gems: encodeRecord(world.gems, world.gems.count),
    pickups: encodeRecord(world.pickups, world.pickups.count),
    spawner: spawner.saveState?.() ?? null,
  };
}

/**
 * Перенести снимок в мир, только что созданный из того же контента и с теми
 * же параметрами. Снимок пришёл из хранилища устройства, поэтому форма
 * проверяется: битый снимок бросает `SnapshotError`, а не рождает мир с
 * `NaN` в координатах.
 */
export function restoreWorld(world: World, spawner: Spawner, input: unknown): void {
  const snapshot = asRecord(input, "снимок");
  if (snapshot.version !== WORLD_SNAPSHOT_VERSION) {
    throw new SnapshotError(`версия ${String(snapshot.version)}, ожидалась ${WORLD_SNAPSHOT_VERSION}`);
  }

  world.rng.setState(asNumber(snapshot.rng, "rng"));
  assignNumbers(world.player, snapshot.player, "player");
  world.player.alive = asBoolean(asRecord(snapshot.player, "player").alive, "player.alive");
  assignNumbers(world.playerStats, snapshot.playerStats, "playerStats");
  assignNumbers(world.playerStatsBase, snapshot.playerStatsBase, "playerStatsBase");
  world.loadout = restoreLoadout(world, snapshot.loadout);
  world.progression = restoreProgression(snapshot.progression);
  assignNumbers(world.difficulty, snapshot.difficulty, "difficulty");
  world.gemMergeCursor = asNumber(snapshot.gemMergeCursor, "gemMergeCursor");

  decodeRecord(world.stats, snapshot.stats, "stats");
  decodeRecord(world.enemies, snapshot.enemies, "enemies");
  decodeRecord(world.projectiles, snapshot.projectiles, "projectiles");
  decodeRecord(world.gems, snapshot.gems, "gems");
  decodeRecord(world.pickups, snapshot.pickups, "pickups");

  if (snapshot.spawner !== null) spawner.loadState?.(snapshot.spawner);
  // События — только для рендера: новый рендер начинает с чистого буфера.
  world.events.written = 0;
}

// --- Набор и прогрессия -------------------------------------------------------

function restoreLoadout(world: World, input: unknown): World["loadout"] {
  const loadout = asRecord(input, "loadout");
  const weapons = asArray(loadout.weapons, "loadout.weapons").map((raw, i) => {
    const slot = asRecord(raw, `loadout.weapons[${i}]`);
    const typeIndex = asIndex(slot.typeIndex, world.weaponTypes.length, `loadout.weapons[${i}].typeIndex`);
    return {
      typeIndex,
      level: asNumber(slot.level, `loadout.weapons[${i}].level`),
      cooldown: asNumber(slot.cooldown, `loadout.weapons[${i}].cooldown`),
      dirX: asNumber(slot.dirX, `loadout.weapons[${i}].dirX`),
      dirY: asNumber(slot.dirY, `loadout.weapons[${i}].dirY`),
    };
  });
  const passives = asArray(loadout.passives, "loadout.passives").map((raw, i) => {
    const slot = asRecord(raw, `loadout.passives[${i}]`);
    return {
      typeIndex: asIndex(slot.typeIndex, world.passiveTypes.length, `loadout.passives[${i}].typeIndex`),
      level: asNumber(slot.level, `loadout.passives[${i}].level`),
    };
  });
  return { weapons, passives };
}

function restoreProgression(input: unknown): World["progression"] {
  const progression = asRecord(input, "progression");
  return {
    level: asNumber(progression.level, "progression.level"),
    xp: asNumber(progression.xp, "progression.xp"),
    xpToNext: asNumber(progression.xpToNext, "progression.xpToNext"),
    totalXp: asNumber(progression.totalXp, "progression.totalXp"),
    pendingLevelUps: asNumber(progression.pendingLevelUps, "progression.pendingLevelUps"),
    // Варианты выбора переносятся как есть. От подделки снимок не защищён —
    // это данные устройства самого игрока; незнакомый предмет в варианте
    // выбор просто пропускает (`chooseUpgrade`), а не роняет забег.
    offers: cloneJson(asArray(progression.offers, "progression.offers")) as World["progression"]["offers"],
  };
}

// --- Типизированные массивы ---------------------------------------------------

function encodeRecord(source: object, count: number): EncodedPool {
  const scalars: Record<string, number> = {};
  const arrays: Record<string, EncodedArray> = {};

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number") {
      scalars[key] = value;
      continue;
    }
    if (isTypedArray(value)) {
      arrays[key] = encodeArray(value, Math.min(count, value.length));
    }
  }
  return { scalars, arrays };
}

function decodeRecord(target: object, input: unknown, path: string): void {
  const encoded = asRecord(input, path);
  const scalars = asRecord(encoded.scalars, `${path}.scalars`);
  const arrays = asRecord(encoded.arrays, `${path}.arrays`);
  const record = target as Record<string, unknown>;

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number") {
      record[key] = asNumber(scalars[key], `${path}.${key}`);
      continue;
    }
    if (isTypedArray(value)) {
      decodeArrayInto(value, arrays[key], `${path}.${key}`);
    }
  }
}

function encodeArray(array: TypedArray, length: number): EncodedArray {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, length * array.BYTES_PER_ELEMENT);
  return { kind: kindOf(array), length, data: bytesToBase64(bytes) };
}

function decodeArrayInto(target: TypedArray, input: unknown, path: string): void {
  const encoded = asRecord(input, path);
  if (encoded.kind !== kindOf(target)) {
    throw new SnapshotError(`${path}: тип ${String(encoded.kind)} вместо ${kindOf(target)}`);
  }
  const length = asNumber(encoded.length, `${path}.length`);
  if (!Number.isInteger(length) || length < 0 || length > target.length) {
    throw new SnapshotError(`${path}: длина ${length} при ёмкости ${target.length}`);
  }
  if (typeof encoded.data !== "string") throw new SnapshotError(`${path}: нет данных`);

  const bytes = base64ToBytes(encoded.data, path);
  if (bytes.length !== length * target.BYTES_PER_ELEMENT) {
    throw new SnapshotError(`${path}: ${bytes.length} байт вместо ${length * target.BYTES_PER_ELEMENT}`);
  }
  new Uint8Array(target.buffer, target.byteOffset, bytes.length).set(bytes);
}

function isTypedArray(value: unknown): value is TypedArray {
  return (
    value instanceof Float64Array ||
    value instanceof Float32Array ||
    value instanceof Int32Array ||
    value instanceof Int16Array ||
    value instanceof Uint32Array ||
    value instanceof Uint8Array
  );
}

function kindOf(array: TypedArray): TypedKind {
  if (array instanceof Float64Array) return "f64";
  if (array instanceof Float32Array) return "f32";
  if (array instanceof Int32Array) return "i32";
  if (array instanceof Int16Array) return "i16";
  if (array instanceof Uint32Array) return "u32";
  return "u8";
}

/**
 * base64 кусками: `String.fromCharCode(...bytes)` на сотнях килобайт упирается
 * в предел числа аргументов функции.
 */
const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(data: string, path: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new SnapshotError(`${path}: испорченный base64`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Проверки формы ------------------------------------------------------------

function assignNumbers(target: object, input: unknown, path: string): void {
  const source = asRecord(input, path);
  const record = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "number") continue;
    record[key] = asNumber(source[key], `${path}.${key}`);
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SnapshotError(`${path}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new SnapshotError(`${path}: ожидался массив`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new SnapshotError(`${path}: ожидалось число`);
  }
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new SnapshotError(`${path}: ожидался признак`);
  return value;
}

function asIndex(value: unknown, length: number, path: string): number {
  const index = asNumber(value, path);
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new SnapshotError(`${path}: индекс ${index} вне [0, ${length})`);
  }
  return index;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
