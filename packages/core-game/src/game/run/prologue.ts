import type { ChestSize, EndlessCurveDef, PrologueDef, RubezhDef, RunPrologue, UpgradeOption } from "@bh/shared-types";
import { drawWeighted, type Candidate } from "../progression/levels";
import { pushSimEvent, SIM_EVENT } from "../sim/events";
import { TICK_HZ, type World } from "../sim/world";

/**
 * Пролог первого забега — применение `PrologueDef` к миру (T-0278, Р151,
 * design/art/meta-v2.md §4.2). Данные — `content/prologue.ts`; здесь только
 * то, что делает мир, когда пролог в нём включён: оберег, первый сундук,
 * «Советуем», здоровье Стража и победа.
 *
 * Случайности пролог почти не тратит: оберег, сундук и победа её не трогают
 * вовсе, а «Советуем» бросает `world.rng` только в прологе и только на первом
 * выборе, когда в обычном предложении нет нового оружия, — в обычном режиме
 * этого файла в игре нет, и golden-прогоны бесконечного режима не сдвигаются.
 */

/** Оберег пишет событие не чаще, чем раз в столько секунд: удары в упор не должны превратить кольцо в мигалку. */
export const WARD_COOLDOWN_SEC = 2;

/** Тик «оберег ещё не срабатывал»: достаточно давний, чтобы первое срабатывание прошло. */
const NO_WARD_TICK = -1_000_000;

/**
 * Секунда, до которой автоматический приход Стража по отметке рубежа не доходит.
 * В прологе Страж приходит событием таймлайна, а рубеж лишь следит за его
 * жизнью; кривая бесконечного режима отодвинута туда же, чтобы поток держался
 * как есть.
 */
export const PROLOGUE_NEVER_SEC = 1_000_000_000;

export interface PrologueState {
  /** данные пролога; в снимок не входят: берутся из контента */
  rules: PrologueDef;
  /** тик последнего события оберега; `NO_WARD_TICK` — не срабатывал */
  lastWardTick: number;
  /** первый выбор улучшения уже предложен: «Советуем» бывает один раз */
  firstOfferMade: boolean;
}

export function createPrologueState(rules: PrologueDef): PrologueState {
  return { rules, lastWardTick: NO_WARD_TICK, firstOfferMade: false };
}

/** Рубеж пролога: отметка недостижима — Страж приходит событием таймлайна, а не по часам. */
export function prologueRubezh(rubezh: RubezhDef): RubezhDef {
  return { ...rubezh, atSec: PROLOGUE_NEVER_SEC };
}

/** Кривая бесконечного режима, отодвинутая за пределы пролога: после последнего отрезка поток держится как есть. */
export function prologueCurve(curve: EndlessCurveDef): EndlessCurveDef {
  return { ...curve, fromSec: PROLOGUE_NEVER_SEC };
}

/**
 * Здоровье игрока после урона с учётом оберега. Вне пролога — как есть. В
 * прологе ниже порога здоровье не падает: оно становится ровно порогом, а при
 * срабатывании (не чаще раза в `WARD_COOLDOWN_SEC`) мир пишет событие `ward`.
 *
 * Здоровье, которое уже ниже порога (максимум успел вырасти раньше, чем
 * подтянулось текущее), урон не поднимает — оберег его просто не опускает.
 */
export function wardHealth(world: World, before: number, after: number): number {
  const state = world.prologue;
  if (state === null) return after;

  const lowest = Math.min(before, world.playerStats.maxHp * state.rules.hpFloorRatio);
  if (after >= lowest) return after;

  const tick = world.stats.tick;
  if (tick - state.lastWardTick >= WARD_COOLDOWN_SEC * TICK_HZ) {
    state.lastWardTick = tick;
    pushSimEvent(world.events, {
      kind: SIM_EVENT.ward,
      x: world.player.x,
      y: world.player.y,
      radius: lowest - after,
      tick,
    });
  }
  return lowest;
}

/** Размер сундука, заданный прологом для очередного выпадения; `undefined` — как в бесконечном режиме. */
export function prologueChestSize(world: World): ChestSize | undefined {
  const state = world.prologue;
  return state !== null && world.chests.dropped === 0 ? state.rules.firstChestSize : undefined;
}

/**
 * Только что поставленный враг: Страж в прологе слабее обычного («по силе
 * набранного») и сразу переводит рубеж в фазу «страж пришёл» — иначе его смерть
 * не стала бы победой. Остальных врагов не трогает.
 */
export function onPrologueSpawn(world: World, typeIndex: number, slot: number): void {
  const state = world.prologue;
  const rubezh = world.rubezh;
  if (state === null || typeIndex !== rubezh.guardType) return;

  const pool = world.enemies;
  pool.hp[slot] *= state.rules.guardHpMul;
  pool.maxHp[slot] = pool.hp[slot];
  if (rubezh.phase === "pending") rubezh.phase = "guard";
}

/**
 * «Советуем» на первом выборе улучшения. Если среди кандидатов есть новое
 * оружие, оно обязательно в предложении (заменяет последнюю карточку, если
 * обычный бросок его не дал) и помечено `recommended`. Нового оружия нет —
 * предложение остаётся как есть, без метки. Дальше пролог выборов не трогает.
 */
export function recommendFirstOffers(world: World, candidates: readonly Candidate[], offers: UpgradeOption[]): UpgradeOption[] {
  const state = world.prologue;
  if (state === null || state.firstOfferMade || offers.length === 0) return offers;
  state.firstOfferMade = true;

  const fresh = candidates.filter((candidate) => candidate.option.kind === "weapon_new");
  if (fresh.length === 0) return offers;

  const weightOf = (option: UpgradeOption): number => candidates.find((candidate) => candidate.option.id === option.id)?.weight ?? 0;
  let recommended: UpgradeOption | undefined;
  for (const option of offers) {
    if (option.kind === "weapon_new" && (recommended === undefined || weightOf(option) > weightOf(recommended))) recommended = option;
  }

  let result = offers;
  if (recommended === undefined) {
    recommended = fresh[drawWeighted(world.rng, fresh)].option;
    result = [...offers.slice(0, -1), recommended];
  }
  const chosen = recommended;
  return result.map((option) => (option === chosen ? { ...option, recommended: true } : option));
}

/** Страж пал: пролог выигран, забегу пора кончаться. */
export function isPrologueWon(world: World): boolean {
  return world.prologue !== null && world.rubezh.phase === "cleared";
}

/** Пролог для итога забега: победа и секунда — победы или выхода. */
export function describePrologue(world: World): RunPrologue {
  const won = isPrologueWon(world);
  return { won, sec: won ? (world.rubezh.clearedSec ?? world.stats.elapsedSec) : world.stats.elapsedSec };
}
