import { z } from "zod";
import { ITEM_RARITIES } from "../items/item-catalog.js";
import { IMAGE_ID } from "../media/image-rules.js";
import { runReward } from "../progress/progress-rules.js";
import { DIFFICULTIES } from "../runs/run-rules.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import type { RecordedRun } from "../runs/runs-hooks.js";
import type { EarnReason } from "../wallet/wallet-types.js";
import { CLIENT_KINDS, isClientKind, type ClientKind } from "./client-signal-rules.js";

/**
 * Задания и достижения (docs/35-stage4-plan.md Р52, WP13): каталог — в базе,
 * правится из панели без релиза; здесь — то, что каталогу не поменять:
 * виды целей и как их засчитывает сервер, сроки и чем за них платят.
 *
 * Прогресс — только от серверных событий (записанный забег), а не от
 * клиентской аналитики: клиент может прислать что угодно.
 */

/**
 * Срок цели: ежедневные — до полуночи по Москве, недельные — до ночи на
 * понедельник, достижения — навсегда.
 */
export const TASK_PERIODS = ["daily", "weekly", "achievement"] as const;
export type TaskPeriod = (typeof TASK_PERIODS)[number];

/**
 * Фильтр цели забега: оружие, стихия или сложность. Какой ключ нужен какому
 * виду — `RUN_FILTER_KEYS`; лежит в своей колонке, а не в `params`, чтобы
 * партнёрскую цель по-прежнему отличал именно `params`.
 */
export const ELEMENTS = ["fire", "cold", "lightning", "poison"] as const;
export type TaskElement = (typeof ELEMENTS)[number];

export const runFilterSchema = z
  .object({
    weapon: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,47}$/)
      .optional(),
    element: z.enum(ELEMENTS).optional(),
    difficulty: z.enum(DIFFICULTIES).optional(),
  })
  .strict();

export type RunFilter = z.infer<typeof runFilterSchema>;

/** Виды с фильтром и ключ, который каждому нужен: ровно один. */
export const RUN_FILTER_KEYS = {
  weapon_runs: "weapon",
  element_runs: "element",
  difficulty_runs: "difficulty",
  difficulty_survive_sec: "difficulty",
  element_kills: "element",
} as const;

/**
 * Категории достижений (docs/39-retention-mechanics.md К1): «Бой», «Коллекция»,
 * «Мастерство», «Друзья». Названия показывает клиент.
 */
export const ACHIEVEMENT_CATEGORIES = ["combat", "collection", "mastery", "friends"] as const;

/**
 * Категории статусных и сезонных знаков (tasks/T-0235): у них нет прогресса,
 * поэтому игрок видит их не среди четырёх категорий выше, а своими группами.
 * Категория идёт парой с одноимённым видом цели.
 */
export const EMBLEM_CATEGORIES = ["status", "season"] as const;

/** Все категории строки каталога, какие может хранить база (`CHECK` в миграции). */
export const CATEGORY_IDS = [...ACHIEVEMENT_CATEGORIES, ...EMBLEM_CATEGORIES] as const;
export type AchievementCategory = (typeof CATEGORY_IDS)[number];

/**
 * Редкость знака у имени (docs/35-stage4-plan.md Р149): шкала предметов,
 * отдельный тон `team` для знака «Команда» и отдельный тон `partner` для знака
 * «Партнёр»: ни то ни другое не заслуга и не покупка. Стоит в каталоге и не
 * плавает вместе с «есть у N%»: цвет знака у имени не должен меняться сам.
 */
export const EMBLEM_TIERS = [...ITEM_RARITIES, "team", "partner"] as const;
export type EmblemTier = (typeof EMBLEM_TIERS)[number];

/**
 * Пустые необязательные поля обычного задания: категории, лестницы, престижа и
 * знака у имени у него нет, и заказчика с моделью оплаты (Р138) — тоже, поэтому
 * их пустые значения лежат здесь же: так литералы определений в тестах не множатся.
 */
export const NO_ACHIEVEMENT_FIELDS = {
  category: null,
  ladder: null,
  rung: null,
  hidden: false,
  hint: null,
  prestige: 0,
  emblemTier: null,
  customer: null,
  payModel: null,
  rate: null,
  holdDays: 0,
} as const;

/** Потолок очков престижа одного достижения — от опечатки в панели. */
export const PRESTIGE_MAX = 10_000;

/** Ступени пула ротации (docs/39-retention-mechanics.md П1). */
export const POOL_TIERS = ["easy", "medium", "hard"] as const;
export type PoolTier = (typeof POOL_TIERS)[number];

/**
 * Стихия оружия на сервере: в итоге забега приходит только id оружия. Таблицу
 * сверяет тест с `core-game/src/content/weapons.ts` — новое оружие со стихией
 * роняет его, пока строку не добавили.
 */
export const WEAPON_ELEMENTS: Readonly<Record<string, TaskElement>> = {
  wardstone: "cold",
  hearth: "fire",
  storm: "lightning",
  sting: "poison",
  // Эволюции (T-0102) наследуют стихию базового: задание «убить огнём» должно
  // засчитывать и «Горн».
  frost_crown: "cold",
  forge: "fire",
  tempest: "lightning",
  viper: "poison",
  // Седьмое оружие (T-0118) и его эволюция — огонь.
  meteor: "fire",
  fire_rain: "fire",
};

/**
 * Эволюции оружия на сервере: id эволюции → id базового (tasks/T-0102,
 * docs/39-retention-mechanics.md К1). Эволюция занимает слот базового, поэтому
 * в итоге забега стоит её id, а не базового: без таблицы забег с «Грозой» в
 * эволюции не считался бы ни оружием «Гроза», ни молнией. Таблицу сверяет тест
 * с `core-game/src/content/weapons.ts` — новая эволюция роняет его, пока строку
 * не добавили.
 */
export const WEAPON_EVOLUTIONS = {
  starfall: "spark",
  tempest: "storm",
  blade_whirl: "knife",
  whirl: "flail",
  frost_crown: "wardstone",
  forge: "hearth",
  viper: "sting",
  fire_rain: "meteor",
} as const;

/** Это оружие — эволюция. Через `hasOwn`: id приходит с клиента, `constructor` эволюцией не бывает. */
export function isEvolution(id: string): boolean {
  return Object.hasOwn(WEAPON_EVOLUTIONS, id);
}

/** Базовое оружие: у эволюции — то, из которого она выросла, у остального — оно само. */
export function baseWeaponOf(id: string): string {
  return isEvolution(id) ? WEAPON_EVOLUTIONS[id as keyof typeof WEAPON_EVOLUTIONS] : id;
}

/**
 * Виды целей, которые двигает забег: `sum` копит за срок, `max` помнит лучший
 * забег. Новый вид — код здесь (и строка текста у клиента), новое задание на
 * готовом виде — строка каталога в панели. `measure` получает фильтр строки
 * каталога: у видов без фильтра он `null` и игнорируется.
 */
export const RUN_KINDS = {
  /** сыграть забегов */
  runs: { op: "sum", measure: () => 1 },
  /** убить врагов */
  kills: { op: "sum", measure: (run: TaskRun) => run.enemiesKilled },
  /** продержаться в сумме, секунд */
  survive_sec: { op: "sum", measure: (run: TaskRun) => Math.floor(run.survivalSec) },
  /** продержаться в одном забеге, секунд */
  best_survival_sec: { op: "max", measure: (run: TaskRun) => Math.floor(run.survivalSec) },
  /** дорасти в одном забеге до уровня */
  run_level: { op: "max", measure: (run: TaskRun) => run.level },
  /** собрать опыт в сумме; забег без статистики — ноль */
  xp_collected: { op: "sum", measure: (run: TaskRun) => run.xpCollected ?? 0 },
  /** сыграть забег с оружием в наборе к концу */
  weapon_runs: {
    op: "sum",
    measure: (run: TaskRun, filter?: RunFilter | null) => (run.weapons.some((weapon) => baseWeaponOf(weapon.id) === filter?.weapon) ? 1 : 0),
  },
  /** сыграть забег с оружием стихии */
  element_runs: {
    op: "sum",
    measure: (run: TaskRun, filter?: RunFilter | null) =>
      filter?.element !== undefined && run.weapons.some((weapon) => WEAPON_ELEMENTS[baseWeaponOf(weapon.id)] === filter.element) ? 1 : 0,
  },
  /** сыграть забег на сложности */
  difficulty_runs: { op: "sum", measure: (run: TaskRun, filter?: RunFilter | null) => (run.difficulty === filter?.difficulty ? 1 : 0) },
  /** продержаться в одном забеге на сложности, секунд */
  difficulty_survive_sec: {
    op: "max",
    measure: (run: TaskRun, filter?: RunFilter | null) => (run.difficulty === filter?.difficulty ? Math.floor(run.survivalSec) : 0),
  },
  /** сыграть забег с оплаченным бустом */
  boost_runs: { op: "sum", measure: (run: TaskRun) => (run.boosts.length > 0 ? 1 : 0) },
  // Счётчики итога (T-0125): забег без них — старый клиент, нет статистики или
  // счётчики неправдоподобны — даёт ноль, а остальные виды двигает как раньше.
  /** убить боссов */
  boss_kills: { op: "sum", measure: (run: TaskRun) => run.counters?.bossKills ?? 0 },
  /** убить элит */
  elite_kills: { op: "sum", measure: (run: TaskRun) => run.counters?.eliteKills ?? 0 },
  /** открыть сундуков */
  chests_opened: { op: "sum", measure: (run: TaskRun) => run.counters?.chestsOpened ?? 0 },
  /** подобрать кристаллов */
  crystals_collected: { op: "sum", measure: (run: TaskRun) => run.counters?.crystals ?? 0 },
  /**
   * сыграть забег, где к концу есть эволюция оружия. Читается из набора, а не из
   * события: `evolution_unlocked` клиентское и до сервера не доходит, а эволюция
   * занимает слот базового оружия.
   */
  evolution_runs: { op: "sum", measure: (run: TaskRun) => (run.weapons.some((weapon) => isEvolution(weapon.id)) ? 1 : 0) },
  // Испытания и стихии (T-0322): серии и убийства по стихии добивающего удара берутся
  // из тех же счётчиков итога, и без них — ноль, как у видов выше.
  /** продержаться в одном забеге без единого попадания, секунд */
  no_hit_sec: { op: "max", measure: (run: TaskRun) => run.counters?.noHitSec ?? 0 },
  /** продержаться в одном забеге, никого не убив, секунд */
  no_kill_sec: { op: "max", measure: (run: TaskRun) => run.counters?.noKillSec ?? 0 },
  /** убить врагов стихией добивающего удара; без фильтра стихии — ноль, а не сумма всех */
  element_kills: {
    op: "sum",
    measure: (run: TaskRun, filter?: RunFilter | null) => (filter?.element === undefined ? 0 : (run.counters?.killsByElement[filter.element] ?? 0)),
  },
} as const satisfies Record<string, { op: "sum" | "max"; measure: (run: TaskRun, filter?: RunFilter | null) => number }>;

export type RunKind = keyof typeof RUN_KINDS;

/**
 * Состояния игрока (tasks/T-0106): число друзей и уровень аккаунта забег не
 * двигает, поэтому они не в `RUN_KINDS`. Сервер читает их при открытии витрины
 * достижений и дописывает прогресс с действием «максимум» — значение не убывает:
 * друзей стало меньше, а выполненное осталось выполненным. Процент кодекса врагов
 * (tasks/T-0127) и число найденных видов тайников (tasks/T-0261) дописывают их
 * собственные модули: витрина эти виды не читает.
 */
export const STATE_KINDS = {
  /** друзья в списке */
  friends: { op: "max" },
  /** уровень аккаунта */
  account_level: { op: "max" },
  /**
   * «Мастера оружия», которых игрок выполнил (T-0322): считает сервер по каталогу и
   * прогрессу, а не забег; цель — число «Мастеров» (`DYNAMIC_TARGET_KINDS`).
   */
  weapon_masters: { op: "max" },
  /** доля открытого кодекса врагов, процентов (tasks/T-0127): дописывает модуль кодекса */
  codex_percent: { op: "max" },
  /** найдено видов тайников, из шести (tasks/T-0261): дописывает модуль кодекса тайников */
  secrets_kinds: { op: "max" },
} as const satisfies Record<string, { op: "max" }>;

export type StateKind = keyof typeof STATE_KINDS;

/**
 * Виды, у которых цель считается, а не хранится (T-0322): хранимый `target` строки
 * сервер не читает, панель показывает «считается сама». «Коллекционер» требует всех
 * «Мастеров оружия», сколько их включено сейчас, — новое оружие поднимает цель.
 */
export const DYNAMIC_TARGET_KINDS = ["weapon_masters"] as const satisfies readonly StateKind[];

/** «Мастера оружия» каталога: включённые достижения вида «забеги с оружием». */
export function masterIdsOf(defs: readonly TaskDef[]): string[] {
  return defs.filter((def) => def.active && def.period === "achievement" && def.kind === "weapon_runs").map((def) => def.taskId);
}

/**
 * Строки каталога с посчитанной целью: у видов `DYNAMIC_TARGET_KINDS` — число включённых
 * «Мастеров», но не меньше единицы (схема нуля не допускает). Остальные строки не
 * меняются, исходный список — тоже.
 */
export function withDynamicTargets(defs: readonly TaskDef[]): TaskDef[] {
  const target = Math.max(1, masterIdsOf(defs).length);
  return defs.map((def) => ((DYNAMIC_TARGET_KINDS as readonly TaskKind[]).includes(def.kind) ? { ...def, target } : def));
}

/**
 * Партнёрские цели (Р52): их выполняет не забег, а действие игрока вне игры,
 * и у игрока они — своей категорией. `channel` — подписаться на канал или
 * вступить в чат, проверяет бот площадки по нажатию «Проверить»; `link` —
 * перейти по ссылке, `bot` — запустить бота: засчитывается переход через
 * сервер — проверить, что игрок открыл чужого бота, без постбэка партнёра
 * нечем. Цель у них всегда 1: действие делается, а не копится.
 *
 * Повтор (Р82, WP13, часть 7) — только у подписки: срок «каждый день» или
 * «каждую неделю» — своя строка прогресса за срок, и забор каждого срока
 * спрашивает бота, подписан ли игрок сейчас. Это награда за то, что игрок
 * остался, а не только за то, что пришёл. Переход по ссылке и запуск бота
 * не проверить — их повтор стал бы фермой, они только разовые.
 */
export const CHECKED_KINDS = ["channel", "link", "bot"] as const;
export type CheckedKind = (typeof CHECKED_KINDS)[number];

/** Цели, которые засчитывает сам переход: проверить их у площадки нечем. */
export const OPEN_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(["link", "bot"]);

/**
 * Статусные и сезонные знаки у имени (tasks/T-0235): строки каталога без прогресса.
 * Держит ли игрок знак, сервер вычисляет при чтении по состоянию аккаунта — забег
 * их не двигает, `claim` для них не существует, а в списке заданий игрока их нет.
 */
export const EMBLEM_KINDS = ["status", "season"] as const;
export type EmblemKind = (typeof EMBLEM_KINDS)[number];

export type TaskKind = RunKind | StateKind | CheckedKind | ClientKind | EmblemKind;
export const TASK_KIND_IDS: readonly TaskKind[] = [
  ...(Object.keys(RUN_KINDS) as RunKind[]),
  ...(Object.keys(STATE_KINDS) as StateKind[]),
  ...CHECKED_KINDS,
  ...(Object.keys(CLIENT_KINDS) as ClientKind[]),
  ...EMBLEM_KINDS,
];

export function isRunKind(kind: TaskKind): kind is RunKind {
  return Object.hasOwn(RUN_KINDS, kind);
}

export function isStateKind(kind: TaskKind): kind is StateKind {
  return Object.hasOwn(STATE_KINDS, kind);
}

/** Строка статусного или сезонного знака: не задание, прогресса и награды у неё нет. */
export function isEmblemKind(kind: string): kind is EmblemKind {
  return (EMBLEM_KINDS as readonly string[]).includes(kind);
}

/** Категория цели у игрока: партнёрские — своей вкладкой, остальные — по сроку. */
export type TaskCategory = TaskPeriod | "partner";

/** Площадки, где есть каналы: у веб-версии их нет. */
export const CHANNEL_PLATFORMS = ["telegram", "max", "vk"] as const satisfies readonly PlatformId[];

/**
 * Что нужно партнёрской цели: ссылка, которую откроет игрок, где цель видна,
 * и у канала — сам канал в записи площадки (у Telegram — `@имя` или id).
 *
 * Где видна: у канала — одна площадка (`platform`), бот спрашивает
 * подписчиков своей; у ссылки и бота — список площадок (`platforms`), без
 * списка — все. Ссылка партнёра бывает нужна в Telegram и MAX, но не в VK
 * (решение владельца, 01.10.2026). `platform` у ссылки — запись прошлой
 * панели, читается как список из одной. Что обязательно у какого вида —
 * проверяет `taskDefSchema`.
 */
export const taskParamsSchema = z
  .object({
    platform: z.enum(CHANNEL_PLATFORMS).optional(),
    platforms: z
      .array(z.enum(PLATFORM_IDS))
      .min(1)
      .max(PLATFORM_IDS.length)
      .refine((list) => new Set(list).size === list.length, { message: "площадка повторяется" })
      .optional(),
    chat: z.string().trim().min(2).max(64).optional(),
    url: z.url({ protocol: /^https$/ }).max(256),
  })
  .strict()
  .refine((params) => params.platform === undefined || params.platforms === undefined, { message: "площадка — одна или списком, не обоими" });

export type TaskParams = z.infer<typeof taskParamsSchema>;

/** Нет подключённых площадок: каналы чужих площадок не видны (поведение до связи аккаунтов, Р188). */
export const NO_LINKABLE: ReadonlySet<PlatformId> = new Set();

/**
 * Видна ли цель игроку этой площадки: цель без площадок — всем.
 *
 * Канал другой площадки (Р188, T-0377) виден, только если площадка в `linkable`:
 * у неё есть и проверка подписки, и бот, через который игрок свяжет аккаунты.
 * Каналом считается цель с `chat` — схема каталога даёт `chat` только подписке на
 * канал; площадка у ссылки и бота по-прежнему значит «где видна».
 */
export function visibleOn(params: TaskParams | null, platform: PlatformId, linkable: ReadonlySet<PlatformId> = NO_LINKABLE): boolean {
  if (params === null) return true;
  if (params.platforms !== undefined) return params.platforms.includes(platform);
  if (params.platform === undefined || params.platform === platform) return true;
  return params.chat !== undefined && linkable.has(params.platform);
}

/**
 * Как игрок проверяется в канале: `own` — канал его площадки, спрашиваем по его
 * id; `external` — канал другой площадки, нужна связь аккаунтов и кнопка бота.
 * У остальных целей способа нет.
 */
export type ChannelLinkMode = "own" | "external";

export function channelLinkMode(def: Pick<TaskDef, "kind" | "params">, platform: PlatformId): ChannelLinkMode | null {
  if (def.kind !== "channel" || def.params?.platform === undefined) return null;
  return def.params.platform === platform ? "own" : "external";
}

export type TaskRun = Pick<RecordedRun, "difficulty" | "mode" | "survivalSec" | "enemiesKilled" | "level" | "cheats" | "verdict" | "weapons" | "boosts" | "xpCollected" | "counters">;

/**
 * Засчитывается тот же забег, что приносит награду: с читами, отклонённый
 * разбором и «нажал и вышел» не двигают и задания — иначе их фармили бы
 * короткими забегами.
 */
export function countsForTasks(run: TaskRun): boolean {
  // Пролог задания не двигает (Р151): это обучение, а не охота за целью.
  if (run.mode === "prologue") return false;
  return runReward(run).skipped === null;
}

/** Ежедневные и недельные платят как задания, достижения — своей причиной: у них свой потолок. */
export function rewardReason(period: TaskPeriod): Extract<EarnReason, "task_reward" | "achievement_reward"> {
  return period === "achievement" ? "achievement_reward" : "task_reward";
}

/** Пределы лимита выполнений — те же у формы панели и в `CHECK` базы. */
export const TASK_LIMIT_RANGE = { min: 1, max: 1_000_000 } as const;

/**
 * Мягкий час (Р82): кто перешёл к заданию до исчерпания лимита, получает
 * награду ещё час — иначе игрок подписался бы зря. Час идёт от последнего
 * перехода, а переход после исчерпания час не продлевает.
 */
export const TASK_LIMIT_GRACE_MIN = 60;

/** Модели оплаты заказчику (Р138): за выполнение или доля дохода. */
export const PAY_MODELS = ["cpa", "rs"] as const;
export type PayModel = (typeof PAY_MODELS)[number];

/** Ставка: у CPA — центы доллара за выполнение, у RS — сотые доли процента (1 250 — 12,5%). */
export const PAY_RATE_MAX = { cpa: 100_000, rs: 10_000 } as const satisfies Record<PayModel, number>;

/** Сколько суток удержания может требовать заказчик; 0 — сразу. */
export const HOLD_DAYS = [0, 1, 3, 7] as const;

/** Идентификатор задания: латиница в нижнем регистре, цифры и подчёркивание, с буквы, до 48 знаков. */
const TASK_ID = /^[a-z][a-z0-9_]{1,47}$/;

/** Идентификатор лестницы достижений — по тому же образцу, до 32 знаков. */
const LADDER_ID = /^[a-z][a-z0-9_]{0,31}$/;

/** Строка каталога — как её правит панель и читает сервер. */
export const taskDefSchema = z
  .object({
    taskId: z.string().regex(TASK_ID, "id — латиница, цифры и подчёркивание, до 48 знаков"),
    period: z.enum(TASK_PERIODS),
    kind: z.enum(TASK_KIND_IDS as [TaskKind, ...TaskKind[]]),
    /** партнёрская цель — куда вести и что проверять; у целей забега — пусто, и панель до партнёрских целей поля не слала */
    params: taskParamsSchema.nullable().default(null),
    target: z.number().int().positive().max(10_000_000),
    /** `null` — текст по виду цели у клиента, с правильным склонением числа */
    title: z.string().trim().min(1).max(120).nullable(),
    coins: z.number().int().nonnegative().max(100_000),
    gems: z.number().int().nonnegative().max(1_000),
    shards: z.number().int().nonnegative().max(1_000),
    /** очки батл-пасса (WP26) */
    passPoints: z.number().int().nonnegative().max(10_000),
    /** место в списке: на входе игнорируется, его задаёт сервер — запросом порядка, а новому заданию — «конец списка» */
    sort: z.number().int().min(0).max(10_000).default(0),
    active: z.boolean(),
    /** ступень пула ротации; `null` — строка в игре всегда (партнёрские цели, достижения, добавленные руками) */
    tier: z.enum(POOL_TIERS).nullable().default(null),
    /** фильтр цели — оружие, стихия или сложность; у видов без фильтра пусто */
    filter: runFilterSchema.nullable().default(null),
    /** лимит выполнений партнёрской цели — сколько игроков получат награду; `null` — без лимита, и панель до лимита поля не слала */
    limit: z.number().int().min(TASK_LIMIT_RANGE.min).max(TASK_LIMIT_RANGE.max).nullable().default(null),
    /** картинка 1:1 партнёрской цели (Р82) — id из `media`; `null` — значок вида, и панель до картинок поля не слала */
    image: z.string().regex(IMAGE_ID).nullable().default(null),
    /** заказчик партнёрской цели (Р138); `null` — задание своё, и панель до заказчиков поля не слала */
    customer: z.string().trim().min(1).max(80).nullable().default(null),
    /** модель оплаты — вместе с заказчиком */
    payModel: z.enum(PAY_MODELS).nullable().default(null),
    /** ставка: центы у `cpa`, сотые доли процента у `rs` — вместе с моделью */
    rate: z.number().int().min(1).max(PAY_RATE_MAX.cpa).nullable().default(null),
    /** после скольких суток удержания выполнение оплачивается; 0 — сразу */
    holdDays: z.union([z.literal(0), z.literal(1), z.literal(3), z.literal(7)]).default(0),
    /** категория достижения; `null` — не достижение, и панель до престижа поля не слала */
    category: z.enum(CATEGORY_IDS).nullable().default(null),
    /** лестница: достижения с общим `ladder` идут ступенями `rung` с единицы */
    ladder: z.string().regex(LADDER_ID, "лестница — латиница, цифры и подчёркивание, до 32 знаков").nullable().default(null),
    rung: z.number().int().min(1).max(100).nullable().default(null),
    /** скрытое, пока не выполнено: до выполнения игрок видит только подсказку */
    hidden: z.boolean().default(false),
    /** подсказка у закрытого скрытого достижения; у открытых и обычных допустима, но не обязательна */
    hint: z.string().trim().min(1).max(120).nullable().default(null),
    /** очки престижа за выполненное достижение */
    prestige: z.number().int().min(0).max(PRESTIGE_MAX).default(0),
    /** редкость знака у имени (T-0235); `null` — знака нет, и панель до знаков поля не слала */
    emblemTier: z.enum(EMBLEM_TIERS).nullable().default(null),
  })
  .strict()
  // Награды нет только у знаков статуса и сезона: их не выполняют, а держат.
  .refine((task) => isEmblemKind(task.kind) || task.coins + task.gems + task.shards > 0, { message: "задание без награды" })
  // Лимит — у того, что выполняют действием вне игры: место в нём занимает
  // игрок, а у цели забега мест нет.
  .refine((task) => task.limit === null || isCheckedKind(task.kind), { message: "лимит выполнений — только у партнёрской цели", path: ["limit"] })
  // У цели забега рядом с текстом — её прогресс, картинку туда не ставим.
  .refine((task) => task.image === null || isCheckedKind(task.kind), { message: "картинка — только у партнёрской цели", path: ["image"] })
  // Продаётся действие вне игры: у цели забега заказчика и удержания нет.
  .refine((task) => isCheckedKind(task.kind) || (task.customer === null && task.holdDays === 0), { message: "заказчик и удержание — только у партнёрской цели", path: ["customer"] })
  .refine((task) => (task.customer === null) === (task.payModel === null), { message: "заказчик и модель оплаты задаются вместе", path: ["payModel"] })
  .refine((task) => (task.payModel === null) === (task.rate === null), { message: "ставка и модель оплаты задаются вместе", path: ["rate"] })
  .refine((task) => task.payModel === null || task.rate === null || task.rate <= PAY_RATE_MAX[task.payModel], {
    message: "ставка выше предела: у CPA — до 100 000 центов, у RS — до 10 000 (100%)",
    path: ["rate"],
  })
  .refine((task) => task.kind === "channel" || task.holdDays === 0, { message: "Удержание проверяется только у подписки на канал", path: ["holdDays"] })
  .refine((task) => isCheckedKind(task.kind) === (task.params !== null), { message: "ссылка — у партнёрской цели, и только у неё", path: ["params"] })
  .refine((task) => task.kind !== "channel" || (task.params?.platform !== undefined && task.params.chat !== undefined), {
    message: "у подписки на канал нужны площадка и канал — по ним спрашивает бот",
    path: ["params"],
  })
  .refine((task) => task.kind === "channel" || task.params?.chat === undefined, { message: "канал — только у подписки на канал", path: ["params"] })
  .refine((task) => task.kind !== "channel" || task.params?.platforms === undefined, {
    message: "у подписки на канал площадка одна — бот спрашивает подписчиков своей",
    path: ["params"],
  })
  // Партнёрское действие делается, а не копится: за срок его не «наберёшь».
  .refine((task) => task.tier === null || (task.period !== "achievement" && !isCheckedKind(task.kind)), {
    message: "ступень — только у дневных и недельных заданий",
    path: ["tier"],
  })
  .superRefine((task, ctx) => {
    const key = filterKeyOf(task.kind);
    if (key === null) {
      if (task.filter !== null) ctx.addIssue({ code: "custom", message: "у этого вида фильтра нет", path: ["filter"] });
      return;
    }
    const keys = task.filter === null ? [] : Object.entries(task.filter).filter(([, value]) => value !== undefined).map(([name]) => name);
    if (keys.length !== 1 || keys[0] !== key) {
      ctx.addIssue({ code: "custom", message: `у этого вида нужен фильтр: ${FILTER_LABELS[key]}`, path: ["filter"] });
    }
  })
  .superRefine((task, ctx) => {
    // Категория, лестница, подсказка, скрытость и престиж — у достижений забега и состояний.
    // Партнёрскую цель рисует вкладка партнёров, а у ежедневных и недельных престижа нет.
    const achievement = task.period === "achievement" && !isCheckedKind(task.kind);
    if (!achievement) {
      const present = [
        ["category", task.category !== null],
        ["ladder", task.ladder !== null],
        ["rung", task.rung !== null],
        ["hint", task.hint !== null],
        ["hidden", task.hidden],
        ["prestige", task.prestige !== 0],
      ] as const;
      for (const [field, set] of present) {
        if (set) ctx.addIssue({ code: "custom", message: "категория, лестница, подсказка, скрытость и престиж — только у достижений забега", path: [field] });
      }
    }
    if ((task.ladder === null) !== (task.rung === null)) ctx.addIssue({ code: "custom", message: "лестница и ступень задаются вместе", path: [task.ladder === null ? "ladder" : "rung"] });
    if (task.hidden && task.hint === null) ctx.addIssue({ code: "custom", message: "у скрытого достижения нужна подсказка — её игрок видит, пока оно закрыто", path: ["hint"] });
    // Друзей и уровень аккаунта читает витрина достижений: у ежедневной цели срок сбрасывал бы
    // прогресс, который до экрана заданий никто не обновляет.
    if (isStateKind(task.kind) && task.period !== "achievement") ctx.addIssue({ code: "custom", message: "друзья и уровень аккаунта — только у достижений", path: ["kind"] });
  })
  .superRefine((task, ctx) => {
    // Знак у имени (T-0235). У обычного достижения он необязателен, но безымянным не бывает:
    // название игрок видит рядом с именем. Партнёрская цель знака не несёт — её рисует вкладка партнёров.
    const achievement = task.period === "achievement" && !isCheckedKind(task.kind);
    if (task.emblemTier !== null && !achievement) ctx.addIssue({ code: "custom", message: "знак у имени — только у достижений забега", path: ["emblemTier"] });
    if (task.emblemTier !== null && task.title === null) ctx.addIssue({ code: "custom", message: "у знака нужно название — его игрок видит рядом с именем", path: ["title"] });
    // Категории `status` и `season` идут парой с одноимённым видом цели.
    const paired = task.kind === "status" ? "status" : task.kind === "season" ? "season" : null;
    if (paired === null && (task.category === "status" || task.category === "season")) {
      ctx.addIssue({ code: "custom", message: "категории «Статус» и «Сезоны» — только у знаков этих видов", path: ["category"] });
    }
    if (paired === null) return;
    if (task.category !== paired) ctx.addIssue({ code: "custom", message: `у знака вида ${paired} категория — ${paired}`, path: ["category"] });
    if (task.period !== "achievement") ctx.addIssue({ code: "custom", message: "знак статуса и сезона — только достижение", path: ["period"] });
    if (task.target !== 1) ctx.addIssue({ code: "custom", message: "у знака статуса и сезона цель — 1: его держат, а не копят", path: ["target"] });
    if (task.coins + task.gems + task.shards + task.passPoints !== 0) ctx.addIssue({ code: "custom", message: "у знака статуса и сезона награды нет", path: ["coins"] });
    if (task.emblemTier === null) ctx.addIssue({ code: "custom", message: "у знака статуса и сезона нужна редкость", path: ["emblemTier"] });
    if (task.hint === null) ctx.addIssue({ code: "custom", message: "у знака статуса и сезона нужна подсказка — условие, которое видит игрок у закрытого знака", path: ["hint"] });
    if (task.prestige !== 0 || task.hidden || task.ladder !== null || task.rung !== null) {
      ctx.addIssue({ code: "custom", message: "у знака статуса и сезона нет престижа, лестницы и скрытости", path: ["prestige"] });
    }
  })
  .refine((task) => !isCheckedKind(task.kind) || task.target === 1, { message: "у партнёрской цели цель — 1", path: ["target"] })
  // Цели по сигналу клиента (Р187): срок закреплён за видом, цель одна, ротации, фильтра,
  // лимита и картинки нет — задание в игре всегда, вне пула.
  .superRefine((task, ctx) => {
    if (!isClientKind(task.kind)) return;
    if (task.period !== CLIENT_KINDS[task.kind].period) {
      const message = task.kind === "home_screen" ? "главный экран — только достижение" : "история — только недельное";
      ctx.addIssue({ code: "custom", message, path: ["period"] });
    }
    if (task.target !== 1) ctx.addIssue({ code: "custom", message: "у этого задания цель — 1", path: ["target"] });
    const extra = [
      ["tier", task.tier !== null],
      ["filter", task.filter !== null],
      ["limit", task.limit !== null],
      ["image", task.image !== null],
    ] as const;
    const first = extra.find(([, set]) => set);
    if (first !== undefined) ctx.addIssue({ code: "custom", message: "ступень, фильтр, лимит и картинка — не у этого задания", path: [first[0]] });
    // Витрина берёт только достижения с категорией: без неё игрок задание не увидит.
    if (task.kind === "home_screen" && task.category === null) {
      ctx.addIssue({ code: "custom", message: "у достижения «главный экран» нужна категория — без неё витрина его не покажет", path: ["category"] });
    }
  })
  // Повтор — только там, где каждый срок проверяет бот: повтор перехода по
  // ссылке платил бы каждый день за одно и то же нажатие.
  .refine((task) => !isCheckedKind(task.kind) || task.kind === "channel" || task.period === "achievement", {
    message: "повтор — только у подписки на канал: переход по ссылке и запуск бота разовые",
    path: ["period"],
  });

const FILTER_LABELS = { weapon: "оружие", element: "стихия", difficulty: "сложность" } as const;

/** Ключ фильтра вида; `null` — у вида фильтра нет. */
export function filterKeyOf(kind: TaskKind): "weapon" | "element" | "difficulty" | null {
  return Object.hasOwn(RUN_FILTER_KEYS, kind) ? RUN_FILTER_KEYS[kind as keyof typeof RUN_FILTER_KEYS] : null;
}

export function isCheckedKind(kind: TaskKind): boolean {
  return (CHECKED_KINDS as readonly string[]).includes(kind);
}

export type TaskDef = z.infer<typeof taskDefSchema>;

/** Потолок места в списке — тот же, что у схемы строки каталога. */
export const TASK_SORT_MAX = 10_000;

/**
 * Список с ручным порядком в панели: три срока и партнёрские цели отдельным
 * списком, какой бы срок у них ни был — так их видит игрок.
 */
export const TASK_GROUPS = ["daily", "weekly", "achievement", "partner"] as const;
export type TaskGroup = (typeof TASK_GROUPS)[number];

export function taskGroup(def: Pick<TaskDef, "kind" | "period">): TaskGroup {
  return isCheckedKind(def.kind) ? "partner" : def.period;
}

/** Запрос «новый порядок списка»: все id группы в нужном порядке, без повторов. */
export const taskOrderSchema = z
  .object({
    group: z.enum(TASK_GROUPS),
    ids: z.array(z.string().regex(TASK_ID)).min(1).max(TASK_SORT_MAX),
  })
  .strict()
  .refine((order) => new Set(order.ids).size === order.ids.length, { message: "id не повторяются", path: ["ids"] });

/** Что игрок знает о своём месте в задании с лимитом; без лимита и для выполнивших — ничего. */
export interface TaskSlots {
  /** сколько мест осталось; 0 — исчерпано */
  left: number;
  total: number;
  /** исчерпано, но место игрока держится до этого времени — мягкий час */
  holdUntil: Date | null;
}

/** Участие игрока в партнёрской цели: последний переход и первое выполнение. */
export interface TaskParticipation {
  completions: number;
  openedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Видна ли цель с лимитом игроку и что сказать ему о местах. Выполнивший
 * место уже занял — лимит его не касается. Исчерпано — цель видна только
 * тем, кто перешёл к ней в последний час; остальным её нет.
 */
export function slotsFor(limit: number | null, participation: TaskParticipation | null, at: Date): { visible: boolean; slots: TaskSlots | null } {
  if (limit === null || (participation !== null && participation.completedAt !== null)) return { visible: true, slots: null };
  const completions = participation?.completions ?? 0;
  const left = Math.max(0, limit - completions);
  if (left > 0) return { visible: true, slots: { left, total: limit, holdUntil: null } };
  const holdUntil = graceEnd(participation?.openedAt ?? null);
  return holdUntil !== null && holdUntil > at ? { visible: true, slots: { left: 0, total: limit, holdUntil } } : { visible: false, slots: null };
}

/** Конец мягкого часа от перехода; без перехода часа нет. */
export function graceEnd(openedAt: Date | null): Date | null {
  return openedAt === null ? null : new Date(openedAt.getTime() + TASK_LIMIT_GRACE_MIN * 60_000);
}
