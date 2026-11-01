import type {
  AccountUnlockDef,
  BoostDef,
  CardToolRules,
  CardToolUnlockDef,
  ChestsDef,
  ContinueDef,
  DifficultyDef,
  DropsDef,
  EndlessCurveDef,
  EnemyDef,
  EnemyStageDef,
  LevelCurveDef,
  LoadoutLimits,
  MapDef,
  PassiveDef,
  SecretsDef,
  TimelineSegmentDef,
  WeaponDef,
} from "@bh/shared-types";
import { BALANCE_TARGETS, EVOLUTION_POWER_RATIO } from "./balance-targets";
import { BOOSTS, MAX_BOOSTS_PER_RUN } from "./boosts";
import { CHESTS } from "./chests";
import { CONTINUE } from "./continue";
import { DIFFICULTIES } from "./difficulty";
import { DROPS } from "./drops";
import { ENEMIES } from "./enemies";
import { MAPS } from "./maps";
import { SECRETS } from "./secrets";
import { ENEMY_STAGES } from "./stages";
import { ACCOUNT_UNLOCKS, CARD_TOOL_RULES, CARD_TOOL_UNLOCKS } from "./unlocks";
import { LEVEL_CURVE, LOADOUT_LIMITS, PASSIVES } from "./upgrades";
import { ENDLESS_CURVE, TIMELINE } from "./waves";
import { WEAPONS } from "./weapons";

/** Диапазон «от и до» целевого коридора. */
export interface TargetRange {
  min: number;
  max: number;
}

/**
 * Целевые коридоры баланса (`balance-targets.ts`). На забег они не влияют:
 * по ним отчёт симуляции и проверка контента решают, в норме ли числа.
 */
export interface BalanceTargetsDef {
  passiveDeathBeforeSec: number;
  dodgingMedianSec: TargetRange;
  dodgingDeathsBeforeMinuteRatioMax: number;
  firstLevelUpSec: TargetRange;
  firstChestEventSec: TargetRange;
  evolutionPowerRatio: TargetRange;
}

/**
 * Весь контент, который влияет на забег, одним объектом (docs/35-stage4-plan.md,
 * Р16; docs/19-content-admin.md §3).
 *
 * Редактор баланса в панели правит копию снимка, проверяет её
 * `findContentProblems` и гоняет движком и ботом калибровки: контент для них —
 * параметр, а не импорт. `content/*` остаются источником по умолчанию
 * (`CONTENT_SNAPSHOT`) и эталоном golden-тестов.
 *
 * Порядок полей — тот же, что в хэше: снимок и хэш сходятся, а добавление
 * поля в снимок без поля в хэше (или наоборот) видно в одном месте.
 */
export interface ContentSnapshot {
  /** Версия формы снимка: меняется, когда поле меняет смысл или уходит. */
  schemaVersion: 1;
  enemies: readonly EnemyDef[];
  stages: readonly EnemyStageDef[];
  weapons: readonly WeaponDef[];
  passives: readonly PassiveDef[];
  levelCurve: LevelCurveDef;
  loadoutLimits: LoadoutLimits;
  accountUnlocks: readonly AccountUnlockDef[];
  timeline: readonly TimelineSegmentDef[];
  endlessCurve: EndlessCurveDef;
  maps: readonly MapDef[];
  drops: DropsDef;
  chests: ChestsDef;
  secrets: SecretsDef;
  difficulties: readonly DifficultyDef[];
  continueRules: ContinueDef;
  boosts: readonly BoostDef[];
  maxBoostsPerRun: number;
  cardToolUnlocks: readonly CardToolUnlockDef[];
  cardToolRules: CardToolRules;
  /** коридоры для отчёта симуляции; в хэш не входят */
  balanceTargets: BalanceTargetsDef;
}

/**
 * Контент из `content/*` — снимок по умолчанию. Поля ссылаются на те же
 * массивы, что читает остальной код: правка файла контента видна сразу и там,
 * и в снимке.
 */
export const CONTENT_SNAPSHOT: ContentSnapshot = {
  schemaVersion: 1,
  enemies: ENEMIES,
  stages: ENEMY_STAGES,
  weapons: WEAPONS,
  passives: PASSIVES,
  levelCurve: LEVEL_CURVE,
  loadoutLimits: LOADOUT_LIMITS,
  accountUnlocks: ACCOUNT_UNLOCKS,
  timeline: TIMELINE,
  endlessCurve: ENDLESS_CURVE,
  maps: MAPS,
  drops: DROPS,
  chests: CHESTS,
  secrets: SECRETS,
  difficulties: DIFFICULTIES,
  continueRules: CONTINUE,
  boosts: BOOSTS,
  maxBoostsPerRun: MAX_BOOSTS_PER_RUN,
  cardToolUnlocks: CARD_TOOL_UNLOCKS,
  cardToolRules: CARD_TOOL_RULES,
  balanceTargets: { ...BALANCE_TARGETS, evolutionPowerRatio: EVOLUTION_POWER_RATIO },
};

/**
 * Отпечаток снимка — версия баланса одним коротким числом. Он уезжает в итог
 * забега и в аналитику (docs/22-analytics-and-metrics.md §5.3); для
 * `CONTENT_SNAPSHOT` равен `CONTENT_HASH`.
 *
 * Считается по полям, влияющим на забег, в порядке `ContentSnapshot`. Версия
 * схемы и коридоры калибровки в него не входят: правка цели отчёта не должна
 * объявлять новую версию баланса.
 *
 * Порядок ключей внутри объектов — порядок записи в `JSON.stringify`, и хэш
 * умолчания обязан остаться прежним, поэтому он от порядка зависит. Копия
 * через `JSON.stringify` и `JSON.parse` порядок сохраняет, а разбор схемой
 * (`contentSnapshotSchema`) и хранилище, сортирующее ключи (jsonb), — нет:
 * хэш считают по снимку до такого пути и хранят рядом с ним.
 */
export function hashSnapshot(snapshot: ContentSnapshot): string {
  // Порядок сознательно фиксирован: JSON.stringify сохраняет порядок полей
  // объекта, а массивы контента и так упорядочены. Перестановка врагов в файле
  // меняет отпечаток — и это правильно: от порядка зависят индексы типов, а
  // значит и последовательность обращений к генератору.
  const source = JSON.stringify([
    snapshot.enemies,
    snapshot.stages,
    snapshot.weapons,
    snapshot.passives,
    snapshot.levelCurve,
    snapshot.loadoutLimits,
    snapshot.accountUnlocks,
    snapshot.timeline,
    snapshot.endlessCurve,
    snapshot.maps,
    snapshot.drops,
    snapshot.chests,
    snapshot.secrets,
    snapshot.difficulties,
    snapshot.continueRules,
    snapshot.boosts,
    snapshot.maxBoostsPerRun,
    snapshot.cardToolUnlocks,
    snapshot.cardToolRules,
  ]);

  // FNV-1a: короткая, без зависимостей и без криптографических претензий.
  // Задача — различать версии контента, а не защищаться от подделки: итог
  // забега считает клиент, и для сервера это в любом случае заявление игрока,
  // а не факт (docs/15-engineering-standards.md §7.1).
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
