import type { EnemyDef, StalkerBodyDef, StalkerDef } from "@bh/shared-types";
import type { EnemyType } from "../patterns/enemy-types";
import { NEVER_HIT } from "./pools";
import { vectorLength } from "./vector";
import { clampToBounds, damagePlayer, despawnEnemy, spawnEnemy, TICK_HZ, type World } from "./world";

/**
 * Тело неубиваемого преследователя (Р205, tasks/T-0421): удар его не убивает, а отталкивает, касание
 * снимает долю здоровья игрока и отбрасывает его. Числа — `content/stalker.ts` (`STALKER`), а не `params`
 * врага: правила преследователя целиком лежат в одном месте у геймдизайнера.
 *
 * Здесь ни одной проверки id врага: движок узнаёт преследователя по признаку паттерна `unkillable`.
 * Преследователь в мире один, и его слот хранится в состоянии тела. Случайности тело не использует —
 * `world.rng` и отдельные потоки не тронуты ни одним ударом.
 */

/**
 * Окно толчков — одна секунда симуляции, то есть `TICK_HZ` тиков: бюджет `push.maxPerSec` считается по
 * последним шестидесяти. Числом, а не `TICK_HZ`: модуль и `world.ts` импортируют друг друга, и константа
 * мира на момент вычисления этой могла бы ещё не существовать (тест сверяет равенство).
 */
export const STALKER_WINDOW_TICKS = 60;

export interface StalkerBodyState {
  /** слот живого преследователя; −1 — его нет */
  slot: number;
  /** толчки последних `TICK_HZ` тиков: кольцевой буфер, сумма — израсходованный бюджет секунды */
  pushWindow: Float64Array;
  pushCursor: number;
  pushWindowSum: number;
  /** множитель следующего толчка серии: 1, decay, decay², … — умножением, без `Math.pow` */
  seriesFactor: number;
  /** тик последнего удара; серия сначала через `seriesResetSec` */
  lastPushTick: number;
  touchCooldownTicks: number;
  recoverTicks: number;
  /**
   * Правила тела из контента; `null` — правил в мире нет, и преследователя не выпустить. Неизменны,
   * в снимок забега не входят: мир создаётся из того же контента.
   */
  rules: StalkerBodyDef | null;
  /** индекс типа преследователя в `enemyTypes`; −1 — правил нет */
  typeIndex: number;
}

export function createStalkerBodyState(def: StalkerDef | undefined, enemies: readonly EnemyType[]): StalkerBodyState {
  return {
    slot: -1,
    pushWindow: new Float64Array(STALKER_WINDOW_TICKS),
    pushCursor: 0,
    pushWindowSum: 0,
    seriesFactor: 1,
    lastPushTick: NEVER_HIT,
    touchCooldownTicks: 0,
    recoverTicks: 0,
    rules: def === undefined ? null : def.body,
    typeIndex: def === undefined ? -1 : enemies.findIndex((type) => type.id === def.enemy),
  };
}

/** Динамическая часть состояния — в чистое положение; правила и тип остаются. */
export function resetStalkerBody(state: StalkerBodyState): void {
  state.slot = -1;
  state.pushWindow.fill(0);
  state.pushCursor = 0;
  state.pushWindowSum = 0;
  state.seriesFactor = 1;
  state.lastPushTick = NEVER_HIT;
  state.touchCooldownTicks = 0;
  state.recoverTicks = 0;
}

/**
 * Есть ли в мире живой преследователь: 1 или 0. Слот в состоянии мог устареть — второй шанс убирает
 * всех врагов, не сообщая телу, — поэтому слот сверяется с пулом, а не берётся на веру.
 */
export function stalkerAlive(world: World): 0 | 1 {
  const state = world.stalkerBody;
  if (state.slot < 0) return 0;
  const enemies = world.enemies;
  return enemies.alive[state.slot] === 1 && enemies.type[state.slot] === state.typeIndex ? 1 : 0;
}

/**
 * Поставить преследователя в точку. Ступень всегда нулевая, множители здоровья и урона не применяются, а
 * случайность спавна не тратится. Второго не ставит — и не ставит вовсе, если в мире нет правил тела:
 * возвращает −1. Зовёт директор преследователя (T-0423).
 */
export function spawnStalker(world: World, typeIndex: number, x: number, y: number): number {
  const state = world.stalkerBody;
  if (state.rules === null || typeIndex !== state.typeIndex || stalkerAlive(world) === 1) return -1;

  const slot = spawnEnemy(world, typeIndex, x, y, world.rng, true);
  if (slot < 0) return -1;
  resetStalkerBody(state);
  state.slot = slot;
  return slot;
}

/** Убрать преследователя без убийства: он не умирает, а растворяется. */
export function despawnStalker(world: World): void {
  const state = world.stalkerBody;
  if (stalkerAlive(world) === 1) despawnEnemy(world, state.slot);
  state.slot = -1;
}

/**
 * Один шаг таймеров тела — в начале `stepWorld`, до оружия: удары этого тика уже ложатся в новый слот
 * окна. Окно сдвигается только пока в нём что-то есть: пустое окно от сдвига не меняется.
 */
export function tickStalkerBody(world: World): void {
  const state = world.stalkerBody;
  if (state.touchCooldownTicks > 0) state.touchCooldownTicks--;
  if (state.recoverTicks > 0) state.recoverTicks--;
  if (state.pushWindowSum === 0) return;

  state.pushCursor = (state.pushCursor + 1) % STALKER_WINDOW_TICKS;
  state.pushWindow[state.pushCursor] = 0;
  // Сумма пересчитывается, а не вычитается: накопленная погрешность сдвигала бы предел.
  let sum = 0;
  for (let i = 0; i < STALKER_WINDOW_TICKS; i++) sum += state.pushWindow[i];
  state.pushWindowSum = sum;
}

/**
 * Удар по преследователю: вместо урона — толчок от игрока. Размер — `first × seriesFactor`, урезанный до
 * остатка бюджета секунды; серия сначала, если с прошлого удара прошло больше `seriesResetSec`. Толчок идёт
 * от игрока, а не по ходу снаряда: так он всегда отодвигает угрозу, а не швыряет врага вбок.
 */
export function pushStalker(world: World, index: number): void {
  const state = world.stalkerBody;
  const enemies = world.enemies;
  const tick = world.stats.tick;
  // Вспышка попадания нужна рендеру и без толчка: удар по нему виден.
  enemies.hitTick[index] = tick;
  const rules = state.rules;
  if (rules === null) return;

  const push = rules.push;
  if (tick - state.lastPushTick > Math.round(push.seriesResetSec * TICK_HZ)) state.seriesFactor = 1;
  state.lastPushTick = tick;

  const scale = world.config.unitScale;
  const size = Math.min(push.first * state.seriesFactor * scale, push.maxPerSec * scale - state.pushWindowSum);
  state.seriesFactor *= push.decay;
  if (!(size > 0)) return;

  const player = world.player;
  let nx = enemies.x[index] - player.x;
  let ny = enemies.y[index] - player.y;
  const distance = vectorLength(nx, ny);
  if (distance < 1e-6) {
    nx = 1;
    ny = 0;
  } else {
    nx /= distance;
    ny /= distance;
  }

  const radius = world.enemyTypes[enemies.type[index]].radius;
  const bounds = world.config.bounds;
  enemies.x[index] = clampToBounds(enemies.x[index] + nx * size, bounds.halfWidth - radius);
  enemies.y[index] = clampToBounds(enemies.y[index] + ny * size, bounds.halfHeight - radius);
  state.pushWindow[state.pushCursor] += size;
  state.pushWindowSum += size;
}

/**
 * Касание: урон — доля максимума здоровья мимо брони и сопротивлений (щит, неуязвимость и бессмертие
 * работают как у любого попадания), отброс игрока от преследователя, затем перезарядка и передышка. Кто
 * и когда может коснуться — решает шаг симуляции (расстояние и `touchCooldownTicks`).
 */
export function stalkerTouch(world: World, index: number): void {
  const state = world.stalkerBody;
  const rules = state.rules;
  if (rules === null) return;

  const enemies = world.enemies;
  const player = world.player;
  damagePlayer(world, world.playerStats.maxHp * rules.touchMaxHpShare, enemies.type[index], true);
  state.touchCooldownTicks = Math.round(rules.touchCooldownSec * TICK_HZ);
  state.recoverTicks = Math.round(rules.recoverSec * TICK_HZ);
  if (!player.alive) return;

  let nx = player.x - enemies.x[index];
  let ny = player.y - enemies.y[index];
  const distance = vectorLength(nx, ny);
  if (distance < 1e-6) {
    nx = 1;
    ny = 0;
  } else {
    nx /= distance;
    ny /= distance;
  }
  const ticks = Math.max(1, Math.round(rules.knockback.sec * TICK_HZ));
  const speed = (rules.knockback.distance * world.config.unitScale) / (ticks / TICK_HZ);
  player.knockbackTicks = ticks;
  player.knockbackVx = nx * speed;
  player.knockbackVy = ny * speed;
}

/** Коридоры правил тела: в них числа остаются «не переборщить» при любой правке из панели. */
const TOUCH_SHARE = { min: 0.1, max: 0.6 } as const;
const KNOCKBACK_DISTANCE_MAX = 200;
const KNOCKBACK_SEC = { min: 0.05, max: 0.5 } as const;
const TOUCH_COOLDOWN_SEC = { min: 0.5, max: 10 } as const;
const PUSH_FIRST_MAX = 80;
const PUSH_RESET_SEC = { min: 0.1, max: 3 } as const;
/**
 * Предел толчков в секунду — не больше этой доли скорости врага: даже под огнём всего арсенала он
 * подходит со скоростью не меньше 0,4 своей.
 */
const PUSH_MAX_SPEED_RATIO = 0.6;

function between(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && value >= min && value <= max;
}

/**
 * Проблемы правил тела человеческим языком: сообщение называет поле. Данные пришли из контента или из
 * панели JSON-ом, поэтому проверка не доверяет типам и не падает на отсутствующем поле.
 */
export function findStalkerProblems(def: StalkerDef, enemies: readonly EnemyDef[]): string[] {
  const problems: string[] = [];
  const enemy = enemies.find((entry) => entry.id === def.enemy);
  if (enemy === undefined) {
    problems.push(`stalker.enemy: врага ${String(def.enemy)} нет в контенте`);
  } else {
    if (enemy.pattern !== "stalker") problems.push(`stalker.enemy: у врага ${enemy.id} паттерн ${enemy.pattern}, а нужен stalker`);
    // С неубиваемого нечему падать и некому раздавать опыт; ранг, стойкость, стихия и размер ему не нужны.
    if (enemy.xp !== 0) problems.push(`stalker.enemy: у врага ${enemy.id} поле xp должно быть 0 — добычи с него нет`);
    if (enemy.damage !== 0) problems.push(`stalker.enemy: у врага ${enemy.id} поле damage должно быть 0 — касание бьёт долей здоровья игрока`);
    if (enemy.rank !== undefined) problems.push(`stalker.enemy: у врага ${enemy.id} поле rank не задаётся`);
    if (enemy.resist !== undefined) problems.push(`stalker.enemy: у врага ${enemy.id} поле resist не задаётся`);
    if (enemy.element !== undefined) problems.push(`stalker.enemy: у врага ${enemy.id} поле element не задаётся`);
    if (enemy.size !== undefined) problems.push(`stalker.enemy: у врага ${enemy.id} поле size не задаётся`);
  }

  const body = def.body;
  if (!between(body.touchMaxHpShare, TOUCH_SHARE.min, TOUCH_SHARE.max)) {
    problems.push(`stalker.touchMaxHpShare: от ${TOUCH_SHARE.min} до ${TOUCH_SHARE.max}`);
  }
  if (!between(body.knockback.distance, 0, KNOCKBACK_DISTANCE_MAX)) {
    problems.push(`stalker.knockback.distance: от 0 до ${KNOCKBACK_DISTANCE_MAX}`);
  }
  if (!between(body.knockback.sec, KNOCKBACK_SEC.min, KNOCKBACK_SEC.max)) {
    problems.push(`stalker.knockback.sec: от ${KNOCKBACK_SEC.min} до ${KNOCKBACK_SEC.max}`);
  }
  if (!between(body.touchCooldownSec, TOUCH_COOLDOWN_SEC.min, TOUCH_COOLDOWN_SEC.max)) {
    problems.push(`stalker.touchCooldownSec: от ${TOUCH_COOLDOWN_SEC.min} до ${TOUCH_COOLDOWN_SEC.max}`);
  }
  if (!between(body.recoverSec, 0, typeof body.touchCooldownSec === "number" ? body.touchCooldownSec : 0)) {
    problems.push("stalker.recoverSec: от 0 до touchCooldownSec");
  }

  const push = body.push;
  if (!(typeof push.first === "number" && push.first > 0 && push.first <= PUSH_FIRST_MAX)) {
    problems.push(`stalker.push.first: больше 0 и не больше ${PUSH_FIRST_MAX}`);
  }
  if (!(typeof push.decay === "number" && push.decay > 0 && push.decay < 1)) {
    problems.push("stalker.push.decay: больше 0 и меньше 1");
  }
  if (!between(push.seriesResetSec, PUSH_RESET_SEC.min, PUSH_RESET_SEC.max)) {
    problems.push(`stalker.push.seriesResetSec: от ${PUSH_RESET_SEC.min} до ${PUSH_RESET_SEC.max}`);
  }
  if (!(typeof push.maxPerSec === "number" && push.maxPerSec > 0)) {
    problems.push("stalker.push.maxPerSec: больше 0");
  } else if (enemy !== undefined && push.maxPerSec > enemy.speed * PUSH_MAX_SPEED_RATIO + 1e-9) {
    problems.push(
      `stalker.push.maxPerSec: не больше ${PUSH_MAX_SPEED_RATIO} скорости врага (${enemy.speed * PUSH_MAX_SPEED_RATIO}): иначе под огнём он не подойдёт`,
    );
  }
  return problems;
}
