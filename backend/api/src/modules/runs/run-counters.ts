/**
 * Счётчики итога забега для заданий и достижений (tasks/T-0125): убитые
 * боссы и элиты, открытые сундуки, подобранные кристаллы. Чистые функции без
 * Nest и базы.
 *
 * Правдоподобие проверяется по структуре, без настраиваемых порогов (Р7:
 * число в тексте подсказывает читеру предел). Нарушение не выбивает забег из
 * рейтинга — рейтинг строится не на этих числах, — но не пускает счётчики в
 * задания и достижения.
 */

/**
 * Стихии убийств: без физической — её убийств в итоге нет. Повторяет
 * `ELEMENTS` из `shared-types` без `physical`: сервер пакет не импортирует,
 * равенство держит тест.
 */
export const ELEMENT_KEYS = ["fire", "cold", "lightning", "poison"] as const;
export type ElementKey = (typeof ELEMENT_KEYS)[number];

export interface RunCounters {
  bossKills: number;
  eliteKills: number;
  chestsOpened: number;
  crystals: number;
  /** самая долгая серия без попаданий, секунды (tasks/T-0321) */
  noHitSec: number;
  /** самая долгая серия без убийств, закрытая убийством, секунды */
  noKillSec: number;
  /** убийства по стихии добивающего удара; нет ключа — ноль */
  killsByElement: Partial<Record<ElementKey, number>>;
}

/** Что пришло в `stats` итога: все поля необязательные, старые сборки их не знают. */
export interface CounterFields {
  bossKills?: number | undefined;
  eliteKills?: number | undefined;
  chestsOpened?: number | undefined;
  crystals?: number | undefined;
  noHitSec?: number | undefined;
  noKillSec?: number | undefined;
  killsByElement?: Partial<Record<ElementKey, number>> | undefined;
}

/**
 * Потолок горсти кристаллов с одного убитого врага. Повторяет
 * `MAX_GEMS_PER_KILL` движка (`game/sim/gems.ts`): сервер `core-game` не
 * импортирует, равенство держит тест.
 */
export const GEMS_PER_KILL_CEILING = 16;

/**
 * Счётчики из статистики итога. `null` — статистики нет или ни одного из
 * семи полей: сборка до счётчиков, считать нечего. Отсутствующее поле при
 * присланных остальных — 0, словарь стихий — пустой.
 */
export function countersOf(stats: CounterFields | undefined): RunCounters | null {
  if (stats === undefined) return null;
  const { bossKills, eliteKills, chestsOpened, crystals, noHitSec, noKillSec, killsByElement } = stats;
  if ([bossKills, eliteKills, chestsOpened, crystals, noHitSec, noKillSec, killsByElement].every((field) => field === undefined)) return null;
  return {
    bossKills: bossKills ?? 0,
    eliteKills: eliteKills ?? 0,
    chestsOpened: chestsOpened ?? 0,
    crystals: crystals ?? 0,
    noHitSec: noHitSec ?? 0,
    noKillSec: noKillSec ?? 0,
    killsByElement: killsByElement ?? {},
  };
}

interface RankEvent {
  /** секунда забега, на которой событие срабатывает */
  atSec: number;
  rank: "elite" | "boss";
  count: number;
}

/**
 * События элит и боссов расписанных руками отрезков таймлайна
 * (`content/waves.ts`, `TIMELINE`): элита и босс приходят только событием в
 * назначенную секунду. Тест сверяет таблицу с контентом: поменялся таймлайн —
 * он падает, пока таблицу не обновили.
 */
const MANUAL_RANK_EVENTS: readonly RankEvent[] = [
  { atSec: 90, rank: "elite", count: 1 },
  { atSec: 240, rank: "elite", count: 1 },
  { atSec: 300, rank: "elite", count: 1 },
];

/**
 * Бесконечная кривая (`ENDLESS_CURVE`): отрезок номер `s` (с нуля) начинается
 * на `fromSec + s · segmentSec`, а событие срабатывает на отрезках, где
 * `(s + 1)` кратно `everySegments`.
 */
const CURVE = {
  fromSec: 330,
  segmentSec: 60,
  events: [
    { everySegments: 4, rank: "elite", count: 2 },
    { everySegments: 6, rank: "elite", count: 1 },
    { everySegments: 5, rank: "boss", count: 1 },
    { everySegments: 7, rank: "elite", count: 3 },
    { everySegments: 8, rank: "boss", count: 1 },
    { everySegments: 9, rank: "elite", count: 2 },
  ],
} as const;

/**
 * Сколько элит и боссов пришло по таймлайну к секунде `survivalSec` включая
 * её: событие срабатывает, когда время забега дошло до начала отрезка. Запаса
 * нет — честный забег не убьёт того, кто ещё не пришёл.
 */
export function rankBudget(survivalSec: number): { elite: number; boss: number } {
  const budget = { elite: 0, boss: 0 };
  if (!Number.isFinite(survivalSec) || survivalSec < 0) return budget;

  for (const event of MANUAL_RANK_EVENTS) {
    if (event.atSec <= survivalSec) budget[event.rank] += event.count;
  }
  if (survivalSec >= CURVE.fromSec) {
    // Отрезки кривой, уже начавшиеся к этой секунде.
    const started = Math.floor((survivalSec - CURVE.fromSec) / CURVE.segmentSec) + 1;
    for (const event of CURVE.events) budget[event.rank] += Math.floor(started / event.everySegments) * event.count;
  }
  return budget;
}

export interface CounterContext {
  survivalSec: number;
  enemiesKilled: number;
}

/**
 * Сходятся ли счётчики с ходом боя:
 * 1. боссов и элит убито не больше, чем убито вообще;
 * 2. каждых — не больше, чем пришло по таймлайну к концу забега;
 * 3. сундуков открыто не больше, чем убито элит и боссов: сундук падает
 *    только с них;
 * 4. кристаллов подобрано не больше, чем потолок горсти с каждого убитого;
 * 5. серии без попаданий и без убийств не длиннее забега, а убийств по стихиям
 *    не больше, чем убито вообще (tasks/T-0321).
 */
export function countersPlausible(counters: RunCounters, context: CounterContext): boolean {
  if (counters.bossKills + counters.eliteKills > context.enemiesKilled) return false;

  const budget = rankBudget(context.survivalSec);
  if (counters.eliteKills > budget.elite || counters.bossKills > budget.boss) return false;

  if (counters.chestsOpened > counters.bossKills + counters.eliteKills) return false;
  if (counters.crystals > context.enemiesKilled * GEMS_PER_KILL_CEILING) return false;

  if (counters.noHitSec > context.survivalSec || counters.noKillSec > context.survivalSec) return false;
  const byElement = Object.values(counters.killsByElement).reduce((sum, count) => sum + (count ?? 0), 0);
  return byElement <= context.enemiesKilled;
}
