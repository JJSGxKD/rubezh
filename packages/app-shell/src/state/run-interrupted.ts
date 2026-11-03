import { create } from "zustand";
import type { RunFinishSubmission, RunResult } from "@bh/shared-types";
import { readSnapshotCounters } from "@bh/core-game";
import { useDevMode } from "./dev-mode";
import { useMeta } from "./meta";
import { currentScreen, useNavigation } from "./navigation";
import { takeIncompatibleRun, type SavedRun } from "./run-save";
import { useRuns } from "./runs";
import { track } from "./shell";

/**
 * Забег, прерванный обновлением игры, засчитывается, а не пропадает
 * (tasks/T-0163). Игрок свернул игру посреди забега, мы выкатили версию, он
 * открыл приложение: сохранение другой сборки продолжить нельзя — формат мира
 * и контент уже другие, — но забег был, и в рекорде, рейтинге и награде он
 * должен остаться. Поэтому сохранение уходит на сервер брошенным забегом с
 * временем и уровнем, что в нём записаны, а игрок один раз видит карточку.
 *
 * Отправка идёт обычной очередью итогов (`runs.ts`): запись переживает
 * перезапуск, уходит при появлении сети, отказ сервера по самим данным
 * выбрасывает её. Сервер идемпотентен по `runId`, поэтому сохранение стирается
 * сразу после постановки в очередь, а не после ответа.
 */

/**
 * Сохранение старше этого срока стирается без отправки и без карточки: итог,
 * пролежавший месяцы, уже не отражает нынешнюю игру. `savedAt` из будущего
 * (часы переведены) считается свежим.
 */
export const SETTLE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

// Потолки схемы итога на сервере (`runFinishSchema`): сохранение с битыми
// числами не должно превращаться в итог, который сервер отвергнет целиком.
const MAX_SURVIVAL_SEC = 86_400;
const MAX_LEVEL = 999;
const MAX_KILLS = 1_000_000;
const MAX_XP = 1_000_000_000;

export interface InterruptedNotice {
  survivalSec: number;
  level: number;
}

interface InterruptedNoticeStore {
  /** что показать в карточке; хранится только в памяти — см. `settleInterruptedRun` */
  notice: InterruptedNotice | null;
  dismiss(): void;
}

export const useInterruptedNotice = create<InterruptedNoticeStore>((set) => ({
  notice: null,
  dismiss(): void {
    set({ notice: null });
  },
}));

/** Остановить ожидание лобби предыдущего засчёта: подписки не копятся. */
let stopWaiting: (() => void) | null = null;

/**
 * Засчитать сохранение забега другой сборки. Зовётся на запуске, после
 * рекорда, очереди итогов и настроек разработчика: им нужны уже поднятые
 * `useMeta`, `useRuns`, `useDevMode` и `track`.
 */
export function settleInterruptedRun(): void {
  const saved = takeIncompatibleRun();
  if (saved === null) return;

  // Сроков хранения у самого сохранения нет, поэтому срок — здесь.
  if (Date.now() - saved.savedAt > SETTLE_MAX_AGE_MS) return;

  const { survivalSec, level, enemiesKilled, xpCollected } = figuresOf(saved);
  const cheats = saved.cheats === true;
  // Просьба учесть забег с читами — только у забега разработчика, как при
  // обычном завершении (`countsInRating` в `state/run.ts`).
  const countInRating = saved.dev === true && useDevMode.getState().settings.countInRating;

  useRuns.getState().submitSettled({
    ...(cheats ? { cheats: true, countInRating } : {}),
    runId: saved.runId,
    difficultyId: saved.difficultyId,
    outcome: "abandoned",
    survivalSec,
    level,
    enemiesKilled,
    startingWeaponId: saved.startingWeaponId,
    // Урона оружия в сохранении нет: лист забега в профиле покажет «без урона».
    weapons: saved.summary.weapons.map(({ id, level: weaponLevel }) => ({ id, level: weaponLevel })),
    contentHash: saved.contentHash,
    deathCause: null,
    // Продолжения и бусты не заявляются: оплаченное возвращает существующий
    // возврат забегам, которые не начались.
    continues: [],
    passives: saved.summary.passives.map(({ id, level: passiveLevel }) => ({ id, level: passiveLevel })),
    ...(xpCollected > 0 ? { stats: { damageTaken: 0, xpCollected: Math.round(xpCollected), waveReached: 0, topKills: [] } } : {}),
  } satisfies RunFinishSubmission);

  // Рекорд на устройстве; на сервер этот итог не идёт — там уже своя запись.
  const result = resultOf(saved, { survivalSec, level, enemiesKilled, xpCollected });
  const isNewRecord = useMeta.getState().submitRun(result, countInRating);
  track("run_abandoned", abandonedFields(result, isNewRecord));

  useInterruptedNotice.setState({ notice: { survivalSec, level } });
  waitForLobby();
}

/** Время, уровень и счётчики сохранения — в пределах схемы сервера. */
function figuresOf(saved: SavedRun): { survivalSec: number; level: number; enemiesKilled: number; xpCollected: number } {
  // У сохранения этой сборки счётчики лежат в сводке, у прошлой — только в
  // теле мира, которое без восстановления читает движок.
  const fromBody = readSnapshotCounters(saved.world);
  const killed = validCount(saved.summary.enemiesKilled) ?? fromBody.enemiesKilled;
  const xp = validCount(saved.summary.xpCollected) ?? fromBody.xpCollected;
  return {
    survivalSec: clamp(saved.summary.survivalSec, 0, MAX_SURVIVAL_SEC),
    level: Math.floor(clamp(saved.summary.level, 1, MAX_LEVEL)),
    enemiesKilled: Math.floor(clamp(killed, 0, MAX_KILLS)),
    xpCollected: clamp(xp, 0, MAX_XP),
  };
}

function validCount(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

/** Минимальный итог для рекорда и события: данных, которых нет, — нули. */
function resultOf(
  saved: SavedRun,
  figures: { survivalSec: number; level: number; enemiesKilled: number; xpCollected: number },
): RunResult {
  return {
    runId: saved.runId,
    seed: saved.seed,
    outcome: "abandoned",
    startingWeaponId: saved.startingWeaponId,
    mapId: saved.mapId,
    difficultyId: saved.difficultyId,
    contentHash: saved.contentHash,
    waveReached: 0,
    survivalSec: figures.survivalSec,
    level: figures.level,
    xpCollected: figures.xpCollected,
    enemiesKilled: figures.enemiesKilled,
    // Счётчиков итога в сохранении нет: они остаются нулями и в событие не идут.
    bossKills: 0,
    eliteKills: 0,
    chestsOpened: 0,
    crystalsCollected: 0,
    killsByEnemy: {},
    damageDealt: 0,
    damageTaken: 0,
    damageByElement: {},
    noHitSec: 0,
    noKillSec: 0,
    killsByElement: {},
    weapons: saved.summary.weapons.map(({ id, level }) => ({ id, level, damage: 0 })),
    passives: saved.summary.passives.map(({ id, level }) => ({ id, level })),
    deathCause: null,
    distance: 0,
    peakEnemies: 0,
    cheats: saved.cheats === true,
    continues: [],
  };
}

/**
 * Поля `run_abandoned` (docs/22-analytics-and-metrics.md §3.3). Набор тот же,
 * что у обычного исхода (`outcomeFields` в `state/run.ts`), без полей, которых у
 * сохранения нет: продолжений и урона по стихиям. `wave` — 0: отрезок
 * таймлайна в сохранении не записан.
 */
function abandonedFields(result: RunResult, isNewRecord: boolean): Record<string, string | number | boolean> {
  return {
    seed: result.seed,
    survivalSec: Math.round(result.survivalSec),
    level: result.level,
    wave: result.waveReached,
    enemiesKilled: result.enemiesKilled,
    weapon: result.startingWeaponId,
    map: result.mapId,
    difficulty: result.difficultyId,
    contentHash: result.contentHash,
    isNewRecord,
    cheats: result.cheats,
    interrupted: "update",
  };
}

/**
 * Карточка — только в лобби: поверх забега или меню она сорвала бы игру.
 * Тот же приём, что у окна компенсации тестеру (`state/compensation.ts`).
 */
function waitForLobby(): void {
  stopWaiting?.();
  const check = (): void => {
    if (useInterruptedNotice.getState().notice === null) {
      stop();
      return;
    }
    if (currentScreen(useNavigation.getState().stack) !== "lobby") return;
    stop();
    useNavigation.getState().push("runInterrupted");
  };
  const unsubscribers = [useNavigation.subscribe(check), useInterruptedNotice.subscribe(check)];
  const stop = (): void => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    stopWaiting = null;
  };
  stopWaiting = stop;
  check();
}
