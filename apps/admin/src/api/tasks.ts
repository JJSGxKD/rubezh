import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Каталог заданий и достижений (`/admin/tasks`, docs/35-stage4-plan.md Р52,
 * WP13): цели, награды, текст и включённость без релиза — под `tasks.edit`.
 * Удаления нет: задание выключают, на него ссылается прогресс игроков. Срок
 * и вид после создания не меняются.
 *
 * Партнёрские цели — подписка на канал, переход по ссылке, запуск бота —
 * выполняет действие игрока вне игры, а не забег: у них ссылка, площадка и у
 * канала — сам канал, и они — только достижение с целью 1. У игрока и в
 * панели они — своей группой.
 */

export const TASK_PERIODS = ["daily", "weekly", "achievement"] as const;
export type TaskPeriod = (typeof TASK_PERIODS)[number];

export const PERIOD_TITLES: Record<TaskPeriod, string> = { daily: "Ежедневные", weekly: "Недельные", achievement: "Достижения" };

/** Подписи видов, которые панель знает; незнакомый вид от сервера новее панели показывается как есть. */
export const KIND_TITLES: Partial<Record<string, string>> = {
  runs: "Забеги",
  kills: "Враги",
  survive_sec: "Время в сумме, с",
  best_survival_sec: "Рекорд времени, с",
  run_level: "Уровень в забеге",
  xp_collected: "Опыт в сумме",
  weapon_runs: "Забеги с оружием",
  element_runs: "Забеги со стихией",
  difficulty_runs: "Забеги на сложности",
  difficulty_survive_sec: "Время на сложности, с",
  boost_runs: "Забеги с бустом",
  boss_kills: "Боссы",
  elite_kills: "Элиты",
  chests_opened: "Сундуки",
  crystals_collected: "Кристаллы",
  evolution_runs: "Эволюции",
  no_hit_sec: "Без попаданий подряд, с",
  no_kill_sec: "Без убийств подряд, с",
  element_kills: "Убийства стихией",
  weapon_masters: "Мастера оружия (Коллекционер)",
  friends: "Друзья в списке",
  account_level: "Уровень аккаунта",
  status: "Знак статуса",
  season: "Знак сезона",
  channel: "Подписка на канал",
  link: "Переход по ссылке",
  bot: "Запуск бота",
  home_screen: "Игра на главном экране",
  story_share: "История с игрой",
};

/** Ступени пула ротации: из строк ступени игрок видит набор дня или недели. */
export const POOL_TIERS = ["easy", "medium", "hard"] as const;
export type PoolTier = (typeof POOL_TIERS)[number];
export const TIER_TITLES: Record<PoolTier, string> = { easy: "Лёгкое", medium: "Среднее", hard: "Сложное" };
/** Пусто — задание в игре всегда, как до ротации. */
export const NO_TIER_TITLE = "Не в ротации (всегда)";

/** Фильтр цели забега; ключ вида — тот же, что у сервера (`tasks/task-rules.ts`, `RUN_FILTER_KEYS`). */
export type FilterKey = "weapon" | "element" | "difficulty";
export const FILTER_KEYS: Record<string, FilterKey> = {
  weapon_runs: "weapon",
  element_runs: "element",
  difficulty_runs: "difficulty",
  difficulty_survive_sec: "difficulty",
  element_kills: "element",
};
export const FILTER_LABELS: Record<FilterKey, string> = { weapon: "оружие", element: "стихия", difficulty: "сложность" };

/** Русские имена для выбора фильтра: панель движка не знает, список сверяет только глаз команды. */
export const WEAPON_TITLES: Record<string, string> = { spark: "Искра", knife: "Нож", wardstone: "Оберег", hearth: "Очаг", storm: "Гроза", sting: "Жало", meteor: "Метеор", flail: "Кистень" };
export const ELEMENT_TITLES: Record<string, string> = { fire: "Огонь", cold: "Холод", lightning: "Молния", poison: "Яд" };
export const DIFFICULTY_TITLES: Record<string, string> = { easy: "Лёгкая", normal: "Нормальная", hard: "Сложная" };
export const FILTER_OPTIONS: Record<FilterKey, Record<string, string>> = { weapon: WEAPON_TITLES, element: ELEMENT_TITLES, difficulty: DIFFICULTY_TITLES };

/** Подписка — её проверяет бот площадки по каналу. */
export const CHANNEL_KIND = "channel";

/**
 * Повтор подписки на канал (Р82, WP13, часть 7) — тем же сроком, что у
 * заданий: разово — достижение, каждый день и каждую неделю — свой срок, и
 * каждый срок бот спрашивает, подписан ли игрок сейчас. У ссылки и бота
 * повтора нет: переход не проверить.
 */
export const REPEAT_TITLES: Record<TaskPeriod, string> = { achievement: "Разово", daily: "Каждый день", weekly: "Каждую неделю" };

/** Партнёрские виды: ссылка вместо числа, своя группа в каталоге. */
export const PARTNER_KINDS: ReadonlySet<string> = new Set([CHANNEL_KIND, "link", "bot"]);

/**
 * Виды по сигналу клиента (Р187, `tasks/client-signal-rules.ts`, `CLIENT_KINDS`): засчитывает
 * сообщение игры, сервер действие проверить не может. Срок закреплён за видом, цель — 1.
 */
export const CLIENT_KINDS: ReadonlyMap<string, TaskPeriod> = new Map<string, TaskPeriod>([
  ["home_screen", "achievement"],
  ["story_share", "weekly"],
]);

/**
 * Состояния игрока, которые забег не двигает (`tasks/task-rules.ts`, `STATE_KINDS`): сервер
 * читает их при открытии витрины достижений. Только у достижений — срок их не сбросил бы.
 */
export const STATE_KINDS: ReadonlySet<string> = new Set(["friends", "account_level", "weapon_masters"]);

/**
 * Виды, у которых цель считает сервер (`tasks/task-rules.ts`, `DYNAMIC_TARGET_KINDS`): «Коллекционер»
 * требует всех «Мастеров оружия», сколько их включено сейчас. Хранимое число не читается, поэтому форма
 * показывает подпись вместо поля.
 */
export const COMPUTED_TARGET_KINDS: ReadonlySet<string> = new Set(["weapon_masters"]);

/** Подпись цели, которую считает сервер. */
export const COMPUTED_TARGET_TITLE = "считается сама";

/**
 * Знаки статусов и сезонов у имени (T-0235, `tasks/task-rules.ts`, `EMBLEM_KINDS`): строки каталога без
 * цели и награды. Игрок их не выполняет, а держит, пока сервер по состоянию аккаунта находит условие
 * выполненным (VIP идёт, аккаунт тестера, место в сезоне). Заводит их миграция; панель правит название,
 * подсказку, редкость знака, порядок и «включено».
 */
export const EMBLEM_KINDS: ReadonlySet<string> = new Set(["status", "season"]);

/** Строка каталога — знак статуса или сезона. */
export function isEmblemRow(task: Pick<TaskDef, "kind">): boolean {
  return EMBLEM_KINDS.has(task.kind);
}

/** Категории достижений — те же, что у сервера; названия — те, что видит игрок. */
export const ACHIEVEMENT_CATEGORIES = ["combat", "collection", "mastery", "friends"] as const;
/** Категории знаков статуса и сезона: свои группы в разделе «Знаки» у игрока. */
export const EMBLEM_CATEGORIES = ["status", "season"] as const;
export const ALL_CATEGORIES = [...ACHIEVEMENT_CATEGORIES, ...EMBLEM_CATEGORIES] as const;
export type AchievementCategory = (typeof ALL_CATEGORIES)[number];
export const CATEGORY_TITLES: Record<AchievementCategory, string> = { combat: "Бой", collection: "Коллекция", mastery: "Мастерство", friends: "Друзья", status: "Статус", season: "Сезоны" };

/** Редкость знака у имени: шкала предметов и тон `team` для знака «Команда» (как на сервере, `EMBLEM_TIERS`). */
export const EMBLEM_TIERS = ["common", "uncommon", "rare", "epic", "legendary", "mythic", "team"] as const;
export type EmblemTier = (typeof EMBLEM_TIERS)[number];
export const EMBLEM_TIER_TITLES: Record<EmblemTier, string> = {
  common: "Обычный",
  uncommon: "Добротный",
  rare: "Редкий",
  epic: "Эпический",
  legendary: "Легендарный",
  mythic: "Мифический",
  team: "Команда",
};
/** Пусто — у достижения знака нет. */
export const NO_EMBLEM_TITLE = "Нет знака";
/** Пусто — достижение вне витрины: игрок видит его только во вкладке заданий. */
export const NO_CATEGORY_TITLE = "Без категории";

/** Пределы полей достижения — те же, что у схемы сервера и `CHECK` базы. */
export const HINT_MAX = 120;
export const LADDER_MAX = 32;
export const RUNG_MAX = 100;
export const PRESTIGE_MAX = 10_000;
const LADDER_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** Площадки, где есть каналы, — те же, что принимает сервер. */
export const CHANNEL_PLATFORMS = ["telegram", "max", "vk"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];
export const CHANNEL_PLATFORM_TITLES: Record<ChannelPlatform, string> = { telegram: "Telegram", max: "MAX", vk: "VK" };

/** Где видна ссылка или бот партнёра: любые площадки игры, браузерная тоже. */
export const PARTNER_PLATFORMS = ["telegram", "max", "vk", "web"] as const;
export type PartnerPlatform = (typeof PARTNER_PLATFORMS)[number];
export const PARTNER_PLATFORM_TITLES: Record<PartnerPlatform, string> = { ...CHANNEL_PLATFORM_TITLES, web: "Браузер" };

const CHAT_MIN = 2;
const CHAT_MAX = 64;
const URL_MAX = 256;

/** Цели во времени — в секундах: форма подсказывает минуты. */
export const TIME_KINDS: ReadonlySet<string> = new Set(["survive_sec", "best_survival_sec", "no_hit_sec", "no_kill_sec"]);

/** Тот же формат id, что проверяет сервер (`tasks/task-rules.ts`). */
export const TASK_ID_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;
export const TITLE_MAX = 120;

/**
 * У подписки на канал площадка одна (`platform`): бот спрашивает своих
 * подписчиков. У ссылки и бота — список (`platforms`), без списка — все
 * площадки; `platform` у ссылки — запись прошлой панели, форма читает её
 * как список из одной.
 */
const paramsSchema = z.object({
  platform: z.enum(CHANNEL_PLATFORMS).optional(),
  platforms: z.array(z.enum(PARTNER_PLATFORMS)).optional(),
  chat: z.string().optional(),
  url: z.string(),
});
export type TaskParams = z.infer<typeof paramsSchema>;

export const PAY_MODELS = ["cpa", "rs"] as const;
export type PayModel = (typeof PAY_MODELS)[number];

const filterSchema = z.object({
  weapon: z.string().optional(),
  element: z.string().optional(),
  difficulty: z.string().optional(),
});
export type TaskFilter = z.infer<typeof filterSchema>;

const taskSchema = z.object({
  taskId: z.string(),
  period: z.enum(TASK_PERIODS),
  kind: z.string(),
  /** сервер до партнёрских целей поля не отдавал */
  params: paramsSchema.nullable().default(null),
  target: z.number(),
  title: z.string().nullable(),
  coins: z.number(),
  gems: z.number(),
  shards: z.number(),
  passPoints: z.number(),
  sort: z.number(),
  active: z.boolean(),
  /** ступень пула ротации; сервер до ротации поля не отдавал */
  tier: z.enum(POOL_TIERS).nullable().default(null),
  /** оружие, стихия или сложность цели; сервер до ротации поля не отдавал */
  filter: filterSchema.nullable().default(null),
  /** лимит выполнений партнёрской цели; сервер до лимита поля не отдавал */
  limit: z.number().nullable().default(null),
  /** картинка 1:1 партнёрской цели — id из `media`; сервер до картинок поля не отдавал */
  image: z.string().nullable().default(null),
  /** заказчик, модель оплаты, ставка и срок удержания партнёрской цели (Р138); сервер до них полей не отдавал */
  customer: z.string().nullable().default(null),
  payModel: z.enum(PAY_MODELS).nullable().default(null),
  rate: z.number().nullable().default(null),
  holdDays: z.number().default(0),
  /** поля достижения с престижем (T-0106); сервер до них полей не отдавал */
  category: z.enum(ALL_CATEGORIES).nullable().default(null),
  ladder: z.string().nullable().default(null),
  rung: z.number().nullable().default(null),
  hidden: z.boolean().default(false),
  hint: z.string().nullable().default(null),
  prestige: z.number().default(0),
  /** редкость знака у имени (T-0235); сервер до знаков поля не отдавал */
  emblemTier: z.enum(EMBLEM_TIERS).nullable().default(null),
});

export type TaskDef = z.infer<typeof taskSchema>;

/** Пределы и варианты полей заказчика — те же, что у сервера и в `CHECK` базы (`tasks/task-rules.ts`). */
export const CUSTOMER_MAX = 80;
export const PAY_RATE_MAX: Record<PayModel, number> = { cpa: 100_000, rs: 10_000 };
export const HOLD_DAYS = [0, 1, 3, 7] as const;
export const HOLD_TITLES: Record<(typeof HOLD_DAYS)[number], string> = { 0: "сразу", 1: "1 сутки", 3: "3 суток", 7: "7 суток" };
export const PAY_MODEL_TITLES: Record<PayModel, string> = { cpa: "CPA — за выполнение", rs: "RS — доля дохода" };

/** Пределы лимита — те же, что у сервера и в `CHECK` базы (`tasks/task-rules.ts`). */
export const TASK_LIMIT_RANGE = { min: 1, max: 1_000_000 } as const;

/**
 * Задания рекламной сети (docs/35-stage4-plan.md WP13, часть 6): строка на
 * сеть — сколько её заданий игрок получит за игровые сутки, пауза после
 * выполненного и награда. Сами задания приходят от сети; `ready` — что ещё
 * нужно, чтобы игроки их увидели.
 */
const networkTaskSchema = z.object({
  networkKey: z.string(),
  title: z.string(),
  active: z.boolean(),
  dailyCap: z.number(),
  pauseMin: z.number(),
  coins: z.number(),
  gems: z.number(),
  shards: z.number(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
  ready: z.object({
    block: z.boolean(),
    /** какой блок нужен — словами; сервер до ленты Taddy знал только Task-блок AdsGram */
    blockTitle: z.string().default("Task-блок"),
    confirm: z.boolean(),
    confirmWith: z.string().nullable(),
    /** подтверждение — ключ в «Ключах интеграций»; иначе сеть проверяет выполнение по своему API */
    confirmSecret: z.boolean().default(true),
  }),
});
export type NetworkTaskRow = z.infer<typeof networkTaskSchema>;

const catalogSchema = z.object({
  tasks: z.array(taskSchema),
  kinds: z.array(z.string()),
  periods: z.array(z.enum(TASK_PERIODS)),
  /** сервер до заданий сетей поля не отдавал */
  networks: z.array(networkTaskSchema).default([]),
  /** сколько игроков выполнили партнёрскую цель; сервер до лимита поля не отдавал */
  completions: z.record(z.string(), z.number()).default({}),
  /** id заданий пула, что в игре сейчас; сервер до ротации поля не отдавал */
  rotation: z.object({ daily: z.array(z.string()), weekly: z.array(z.string()) }).default({ daily: [], weekly: [] }),
});
export type TaskCatalog = z.infer<typeof catalogSchema>;

export function fetchTasks(api: AdminApi): Promise<ApiResult<TaskCatalog>> {
  return api.request("/tasks", { schema: catalogSchema });
}

export function saveTask(api: AdminApi, task: TaskDef): Promise<ApiResult<TaskDef>> {
  const title = task.title?.trim() ?? "";
  // Место в списке правкой не задаётся: новое задание встаёт в конец, у существующего остаётся прежнее.
  const body: Partial<TaskDef> = { ...task, ...cleanAchievement(task), ...cleanCustomer(task), taskId: task.taskId.trim(), title: title === "" ? null : title, params: cleanParams(task), filter: cleanFilter(task) };
  delete body.sort;
  return api.request("/tasks", { method: "POST", body, schema: taskSchema });
}

const orderSchema = z.object({ order: z.array(z.string()) });

/** Новый порядок списка заданий одним запросом: id группы в нужном порядке. */
export function reorderTasks(api: AdminApi, group: TaskGroup, ids: readonly string[]): Promise<ApiResult<{ order: string[] }>> {
  return api.request("/tasks/order", { method: "POST", body: { group, ids }, schema: orderSchema });
}

/**
 * Параметры в том виде, что принимает сервер: обрезанные, у подписки — одна
 * площадка и канал, у ссылки и бота — список площадок, пустой — без него.
 */
function cleanParams(task: Pick<TaskDef, "kind" | "params">): TaskParams | null {
  if (task.params === null) return null;
  const url = task.params.url.trim();
  if (task.kind === CHANNEL_KIND) {
    const chat = task.params.chat?.trim();
    return { ...(task.params.platform === undefined ? {} : { platform: task.params.platform }), ...(chat === undefined ? {} : { chat }), url };
  }
  const platforms = partnerPlatforms(task.params);
  return platforms.length === 0 ? { url } : { platforms: PARTNER_PLATFORMS.filter((platform) => platforms.includes(platform)), url };
}

/** Фильтр в том виде, что принимает сервер: один ключ вида, остальное убрано. */
function cleanFilter(task: Pick<TaskDef, "kind" | "filter">): TaskFilter | null {
  const key = FILTER_KEYS[task.kind];
  const value = key === undefined ? undefined : task.filter?.[key];
  return key === undefined || value === undefined || value === "" ? null : { [key]: value };
}

/** Поля достижения «нет»: у ежедневных, недельных и партнёрских целей их не бывает. */
const ACHIEVEMENT_EMPTY = { category: null, ladder: null, rung: null, hidden: false, hint: null, prestige: 0, emblemTier: null } as const;

/** Заказчика нет: задание своё. У цели забега и вида по сигналу клиента продавать нечего. */
export const NO_CUSTOMER_FIELDS = { customer: null, payModel: null, rate: null, holdDays: 0 } as const;

/** Пустые необязательные поля обычного задания — достижения и заказчика; для формы «нового» и тестов. */
export const NO_ACHIEVEMENT_FIELDS = { ...ACHIEVEMENT_EMPTY, ...NO_CUSTOMER_FIELDS } as const;

/** Подпись ставки: «$0,40 за выполнение» или «12,5% дохода»; `null` — ставка не задана. */
export function rateLabel(payModel: PayModel | null, rate: number | null): string | null {
  if (payModel === null || rate === null || !Number.isFinite(rate)) return null;
  if (payModel === "cpa") return `$${(rate / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} за выполнение`;
  return `${(rate / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}% дохода`;
}

/**
 * Поля заказчика в том виде, что принимает сервер: у цели забега — пусто,
 * пустой заказчик снимает и модель со ставкой, а удержание считается только у
 * подписки на канал.
 */
function cleanCustomer(task: Pick<TaskDef, "kind" | "customer" | "payModel" | "rate" | "holdDays">): Pick<TaskDef, "customer" | "payModel" | "rate" | "holdDays"> {
  if (!PARTNER_KINDS.has(task.kind)) return NO_CUSTOMER_FIELDS;
  const holdDays = task.kind === CHANNEL_KIND ? task.holdDays : 0;
  const customer = task.customer?.trim() ?? "";
  if (customer === "") return { ...NO_CUSTOMER_FIELDS, holdDays };
  return { customer, payModel: task.payModel, rate: task.rate, holdDays };
}

/** Достижение игрока: срок «достижение», но не партнёрская цель — её рисует вкладка партнёров. */
export function isAchievement(task: Pick<TaskDef, "kind" | "period">): boolean {
  return task.period === "achievement" && !PARTNER_KINDS.has(task.kind);
}

/** Поля достижения в том виде, что принимает сервер: обрезанные, пустое — «нет», у не-достижения — всё пусто. */
function cleanAchievement(
  task: Pick<TaskDef, "kind" | "period" | "category" | "ladder" | "rung" | "hidden" | "hint" | "prestige" | "emblemTier">,
): Pick<TaskDef, "category" | "ladder" | "rung" | "hidden" | "hint" | "prestige" | "emblemTier"> {
  if (!isAchievement(task)) return ACHIEVEMENT_EMPTY;
  const ladder = task.ladder?.trim() ?? "";
  const hint = task.hint?.trim() ?? "";
  return {
    category: task.category,
    ladder: ladder === "" ? null : ladder,
    rung: ladder === "" ? null : task.rung,
    hidden: task.hidden,
    hint: hint === "" ? null : hint,
    prestige: task.prestige,
    emblemTier: task.emblemTier,
  };
}

/** Смена срока в форме: у не-достижения поля достижения остаются пустыми, а не висят скрытыми в форме. */
export function withPeriod(task: TaskDef, period: TaskPeriod): TaskDef {
  const next = { ...task, period };
  return isAchievement(next) ? next : { ...next, ...ACHIEVEMENT_EMPTY };
}

/** Площадки ссылки или бота; пусто — все. Запись прошлой панели с одной площадкой — список из неё. */
export function partnerPlatforms(params: TaskParams | null): PartnerPlatform[] {
  if (params === null) return [];
  if (params.platforms !== undefined) return params.platforms;
  return params.platform === undefined ? [] : [params.platform];
}

/** Галочка площадки у ссылки или бота: список без неё или с ней. */
export function togglePlatform(params: TaskParams | null, platform: PartnerPlatform): TaskParams {
  const current = partnerPlatforms(params);
  const next = current.includes(platform) ? current.filter((item) => item !== platform) : [...current, platform];
  const url = params?.url ?? "";
  return next.length === 0 ? { url } : { platforms: PARTNER_PLATFORMS.filter((item) => next.includes(item)), url };
}

/**
 * Смена вида в форме: у партнёрской цели — ссылка, срок «достижение» и цель
 * 1, у подписки ещё площадка и канал; у вида забега параметров нет. Остальное
 * поле формы сохраняет.
 */
export function withKind(task: TaskDef, kind: string): TaskDef {
  // Вид по сигналу клиента: срок и цель закреплены, ступени, фильтра, лимита и картинки нет. Историю считают недельным
  // заданием, поэтому поля достижения у неё пусты; у главного экрана категорию выбирают в форме.
  const clientPeriod = CLIENT_KINDS.get(kind);
  if (clientPeriod !== undefined) {
    const next = { ...task, kind, period: clientPeriod, target: 1, params: null, limit: null, image: null, filter: null, tier: null };
    return clientPeriod === "achievement" ? { ...next, ...NO_CUSTOMER_FIELDS } : { ...next, ...NO_ACHIEVEMENT_FIELDS };
  }
  // Фильтр принадлежит виду: у другого вида он был бы чужим. Друзья и уровень аккаунта читает витрина достижений, поэтому срок у них — «достижение».
  if (STATE_KINDS.has(kind)) return { ...task, ...NO_CUSTOMER_FIELDS, kind, period: "achievement", params: null, limit: null, image: null, filter: null, tier: null };
  if (!PARTNER_KINDS.has(kind)) return { ...task, ...NO_CUSTOMER_FIELDS, kind, params: null, limit: null, image: null, filter: null };
  const url = task.params?.url ?? "";
  const kept = partnerPlatforms(task.params);
  const channelPlatform = task.params?.platform ?? CHANNEL_PLATFORMS.find((platform) => kept.includes(platform)) ?? "telegram";
  const params: TaskParams =
    kind === CHANNEL_KIND ? { platform: channelPlatform, chat: task.params?.chat ?? "", url } : kept.length === 0 ? { url } : { platforms: kept, url };
  // Повтор выбирают у подписки сами; ссылка и бот — только разово.
  const period = kind === CHANNEL_KIND && task.kind === CHANNEL_KIND ? task.period : "achievement";
  // Удержание проверяется только у подписки: при смене вида на ссылку или бота оно сбрасывается.
  return { ...task, ...ACHIEVEMENT_EMPTY, kind, period, target: 1, params, filter: null, tier: null, holdDays: kind === CHANNEL_KIND ? task.holdDays : 0 };
}

/** Площадка партнёрской цели; `undefined` — цель видна на всех площадках. */
export function withPlatform(params: TaskParams | null, platform: ChannelPlatform | undefined): TaskParams {
  const url = params?.url ?? "";
  const chat = params?.chat === undefined ? {} : { chat: params.chat };
  return platform === undefined ? { ...chat, url } : { ...chat, platform, url };
}

function isHttpsUrl(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === "https:";
}

function partnerProblem(task: TaskDef): string | null {
  if (task.params === null) return "У партнёрской цели нужна ссылка, у подписки на канал — ещё площадка и канал";
  if (task.target !== 1) return "У партнёрской цели цель — 1: действие делают, а не копят";
  if (task.kind !== CHANNEL_KIND && task.period !== "achievement") return "Повтор — только у подписки на канал: переход по ссылке и запуск бота не проверить, их повтор стал бы фермой";
  if (task.kind === CHANNEL_KIND) {
    if (task.params.platform === undefined) return "У подписки на канал нужна площадка — бот спрашивает свою";
    const chat = task.params.chat?.trim() ?? "";
    if (chat.length < CHAT_MIN || chat.length > CHAT_MAX) return `Канал — @имя или id, от ${String(CHAT_MIN)} до ${String(CHAT_MAX)} знаков`;
  }
  const url = task.params.url.trim();
  if (url.length > URL_MAX || !isHttpsUrl(url)) return `Ссылка — https://…, до ${String(URL_MAX)} знаков`;
  const customerProblem = customerProblemOf(task);
  if (customerProblem !== null) return customerProblem;
  if (task.limit !== null && (!Number.isInteger(task.limit) || task.limit < TASK_LIMIT_RANGE.min || task.limit > TASK_LIMIT_RANGE.max)) {
    return `Лимит выполнений — целое от ${String(TASK_LIMIT_RANGE.min)} до ${TASK_LIMIT_RANGE.max.toLocaleString("ru-RU")} или пусто — без лимита`;
  }
  return null;
}

/** Заказчик, модель, ставка и удержание: те же правила, что у схемы сервера и `CHECK` базы. */
function customerProblemOf(task: TaskDef): string | null {
  const customer = task.customer?.trim() ?? "";
  if (customer.length > CUSTOMER_MAX) return `Заказчик — до ${String(CUSTOMER_MAX)} знаков`;
  if (!HOLD_DAYS.some((days) => days === task.holdDays)) return "Удержание — сразу, 1, 3 или 7 суток";
  if (task.kind !== CHANNEL_KIND && task.holdDays !== 0) return "Удержание проверяется только у подписки на канал";
  if (customer === "") return task.payModel === null && task.rate === null ? null : "Модель и ставка — только у заданий с заказчиком";
  if (task.payModel === null) return "У заказчика нужна модель оплаты — CPA или RS";
  if (task.rate === null || !Number.isInteger(task.rate) || task.rate < 1 || task.rate > PAY_RATE_MAX[task.payModel]) {
    return task.payModel === "cpa" ? "Ставка CPA — целые центы, от 1 до 100 000" : "Ставка RS — сотые доли процента, от 1 до 10 000 (1 250 — это 12,5%)";
  }
  return null;
}

function filterProblemOf(task: Pick<TaskDef, "kind" | "filter">): string | null {
  const key = FILTER_KEYS[task.kind];
  const present = Object.entries(task.filter ?? {}).filter(([, value]) => value !== undefined && value !== "");
  if (key === undefined) return present.length === 0 ? null : "У этого вида фильтра нет";
  const value = task.filter?.[key];
  if (present.length !== 1 || value === undefined || value === "") return `У этого вида нужен фильтр: ${FILTER_LABELS[key]}`;
  return null;
}

/** Поля достижения: те же правила, что у схемы сервера и `CHECK` базы. */
function achievementProblemOf(task: TaskDef): string | null {
  if (STATE_KINDS.has(task.kind) && task.period !== "achievement") return "Друзья, уровень аккаунта и мастера оружия — только у достижений: срок их не сбросил бы";
  const ladder = task.ladder?.trim() ?? "";
  const hint = task.hint?.trim() ?? "";
  if (!isAchievement(task)) {
    const filled = task.category !== null || ladder !== "" || task.rung !== null || hint !== "" || task.hidden || task.prestige !== 0;
    if (task.emblemTier !== null) return "Знак у имени — только у достижений забега";
    return filled ? "Категория, лестница, подсказка, скрытость и престиж — только у достижений забега" : null;
  }
  if (!Number.isInteger(task.prestige) || task.prestige < 0 || task.prestige > PRESTIGE_MAX) return `Престиж — целое от 0 до ${PRESTIGE_MAX.toLocaleString("ru-RU")}`;
  if (ladder !== "" && !LADDER_PATTERN.test(ladder)) return `Лестница — латиница в нижнем регистре, цифры и подчёркивание, с буквы, до ${String(LADDER_MAX)} знаков`;
  if (ladder !== "" && (task.rung === null || !Number.isInteger(task.rung) || task.rung < 1 || task.rung > RUNG_MAX)) return `Ступень лестницы — целое от 1 до ${String(RUNG_MAX)}`;
  if (ladder === "" && task.rung !== null) return "Ступень без лестницы: укажите лестницу или очистите ступень";
  if (hint.length > HINT_MAX) return `Подсказка — до ${String(HINT_MAX)} знаков`;
  if (task.hidden && hint === "") return "У скрытого достижения нужна подсказка: её игрок видит, пока оно закрыто";
  if (task.emblemTier !== null && (task.title?.trim() ?? "") === "") return "У знака нужно название: его игрок видит рядом с именем";
  return null;
}

/**
 * Знак статуса или сезона: цели и награды у него нет, правятся только название, подсказка, редкость,
 * порядок и «включено». Те же правила, что у схемы сервера.
 */
function emblemRowProblem(task: TaskDef): string | null {
  if ((task.title?.trim() ?? "") === "") return "У знака нужно название: его игрок видит рядом с именем";
  if ((task.title?.trim().length ?? 0) > TITLE_MAX) return `Название — до ${String(TITLE_MAX)} знаков`;
  const hint = task.hint?.trim() ?? "";
  if (hint === "") return "У знака нужна подсказка — условие, которое игрок видит у закрытого знака";
  if (hint.length > HINT_MAX) return `Подсказка — до ${String(HINT_MAX)} знаков`;
  if (task.emblemTier === null) return "У знака статуса и сезона нужна редкость";
  // Заказчик продаёт действие вне игры, а знак держат: те же правила у схемы сервера и CHECK базы.
  if (task.customer !== null || task.payModel !== null || task.rate !== null || task.holdDays !== 0) return "У знака статуса и сезона нет заказчика и удержания";
  return null;
}

function nonNegativeInt(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Что не так с формой; `null` — можно сохранять. Сервер проверит то же и ещё
 * одно: у существующего задания не меняются срок и вид.
 */
export function taskProblem(task: TaskDef, isNew: boolean, catalog: readonly TaskDef[] = []): string | null {
  const id = task.taskId.trim();
  if (!TASK_ID_PATTERN.test(id)) return "id — латиница в нижнем регистре, цифры и подчёркивание, с буквы, до 48 знаков";
  if (isNew && catalog.some((existing) => existing.taskId === id)) return "Такой id уже есть — выберите его в списке, чтобы поправить";
  if (isEmblemRow(task)) return isNew ? "Знаки статусов и сезонов заводит миграция: здесь их можно только править" : emblemRowProblem(task);
  if (!Number.isInteger(task.target) || task.target <= 0) return "Цель — целое число больше нуля";
  if (![task.coins, task.gems, task.shards, task.passPoints].every(nonNegativeInt)) return "Награда и очки заданий — целые неотрицательные";
  if (task.coins + task.gems + task.shards === 0) return "Без награды задание некому выполнять — дайте монеты, самоцветы или осколки";
  if ((task.title?.trim().length ?? 0) > TITLE_MAX) return `Заголовок — до ${String(TITLE_MAX)} знаков`;
  if (task.tier !== null && (task.period === "achievement" || PARTNER_KINDS.has(task.kind))) return "Ступень — только у дневных и недельных заданий";
  const achievementProblem = achievementProblemOf(task);
  if (achievementProblem !== null) return achievementProblem;
  const clientPeriod = CLIENT_KINDS.get(task.kind);
  if (clientPeriod !== undefined) {
    if (task.period !== clientPeriod) return clientPeriod === "achievement" ? "Главный экран — только достижение" : "История — только недельное задание";
    if (task.target !== 1) return "У этого задания цель — 1";
    if (task.kind === "home_screen" && task.category === null) return "Достижению «главный экран» нужна категория — без неё витрина его не покажет";
  }
  const filterProblem = filterProblemOf(task);
  if (filterProblem !== null) return filterProblem;
  if (PARTNER_KINDS.has(task.kind)) return partnerProblem(task);
  if (task.params !== null) return "Ссылка — только у партнёрских целей";
  if (task.limit !== null) return "Лимит выполнений — только у партнёрских целей";
  if (task.image !== null) return "Картинка — только у партнёрских целей";
  if (task.customer !== null || task.holdDays !== 0) return "Заказчик и удержание — только у партнёрских целей";
  return null;
}

/**
 * Сколько выполнили — подписью списка: «37 из 500» у цели с лимитом,
 * «37» — без него. Исчерпан — отдельно: панель называет это словом.
 */
export function completionsLabel(task: Pick<TaskDef, "limit">, completions: number): { text: string; exhausted: boolean } {
  if (task.limit === null) return { text: String(completions), exhausted: false };
  return { text: `${String(completions)} из ${String(task.limit)}`, exhausted: completions >= task.limit };
}

export function rewardLabel(task: Pick<TaskDef, "coins" | "gems" | "shards">): string {
  const parts = [task.coins > 0 ? `${String(task.coins)} мон.` : null, task.gems > 0 ? `${String(task.gems)} самоцв.` : null, task.shards > 0 ? `${String(task.shards)} оск.` : null];
  return parts.filter((part): part is string => part !== null).join(" + ");
}

/** Цель подписью: время — минутами, канал — именем, ссылка — адресом, остальное — числом. */
export function targetLabel(task: Pick<TaskDef, "kind" | "target"> & Partial<Pick<TaskDef, "params" | "period">>): string {
  // Знак не выполняют, а держат: цели у него нет.
  if (isEmblemRow(task)) return "—";
  if (COMPUTED_TARGET_KINDS.has(task.kind)) return COMPUTED_TARGET_TITLE;
  const params = task.params ?? null;
  if (params !== null) {
    const listed = task.kind === CHANNEL_KIND ? (params.platform === undefined ? [] : [params.platform]) : partnerPlatforms(params);
    const where = listed.length === 0 ? "все площадки" : listed.map((platform) => PARTNER_PLATFORM_TITLES[platform]).join(", ");
    const what = task.kind === CHANNEL_KIND ? (params.chat ?? "") : URL.canParse(params.url) ? new URL(params.url).host : params.url;
    const repeat = task.period === undefined || task.period === "achievement" ? "" : ` · ${REPEAT_TITLES[task.period].toLowerCase()}`;
    return `${what} (${where})${repeat}`;
  }
  if (!TIME_KINDS.has(task.kind)) return String(task.target);
  const minutes = task.target / 60;
  return Number.isInteger(minutes) ? `${String(minutes)} мин` : `${String(task.target)} с`;
}

/** Группа каталога: срок, а партнёрские — своей, как у игрока. */
export type TaskGroup = TaskPeriod | "partner";
export const GROUP_TITLES: Record<TaskGroup, string> = { ...PERIOD_TITLES, partner: "Партнёрские" };

/** Группа задания: срок, а партнёрские виды — своя, какой бы срок ни был. */
export function taskGroupOf(task: Pick<TaskDef, "kind" | "period">): TaskGroup {
  return PARTNER_KINDS.has(task.kind) ? "partner" : task.period;
}

/** Каталог по группам в порядке показа игроку: место, потом id. */
export function groupByPeriod(tasks: readonly TaskDef[]): { group: TaskGroup; tasks: TaskDef[] }[] {
  return [...TASK_PERIODS, "partner" as const].map((group) => ({
    group,
    tasks: tasks.filter((task) => taskGroupOf(task) === group).sort((a, b) => a.sort - b.sort || a.taskId.localeCompare(b.taskId)),
  }));
}

/** Те же пределы, что держат сервер и база (`tasks/network-task-rules.ts`). */
export const NETWORK_TASK_LIMITS = {
  dailyCap: { min: 1, max: 50 },
  pauseMin: { min: 5, max: 24 * 60 },
} as const;

/** Что правит панель в строке сети. */
export type NetworkTaskInput = Pick<NetworkTaskRow, "networkKey" | "active" | "dailyCap" | "pauseMin" | "coins" | "gems" | "shards">;

export function saveNetworkTask(api: AdminApi, input: NetworkTaskInput): Promise<ApiResult<NetworkTaskRow>> {
  const { networkKey, ...body } = input;
  return api.request(`/tasks/networks/${encodeURIComponent(networkKey)}`, { method: "POST", body, schema: networkTaskSchema });
}

function within(value: number, range: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

/** Что не так со строкой сети; `null` — можно сохранять. */
export function networkTaskProblem(input: NetworkTaskInput): string | null {
  const { dailyCap, pauseMin } = NETWORK_TASK_LIMITS;
  if (!within(input.dailyCap, dailyCap)) return `Заданий в сутки — от ${String(dailyCap.min)} до ${String(dailyCap.max)}`;
  if (!within(input.pauseMin, pauseMin)) return `Пауза — от ${String(pauseMin.min)} минут до суток (${String(pauseMin.max)} мин)`;
  if (![input.coins, input.gems, input.shards].every(nonNegativeInt)) return "Награда — целые неотрицательные";
  if (input.coins + input.gems + input.shards === 0) return "Без награды задание сети некому выполнять — дайте монеты, самоцветы или осколки";
  return null;
}

/** Как часто — словами: «до 5 в сутки, пауза 30 мин». */
export function cadenceLabel(row: Pick<NetworkTaskRow, "dailyCap" | "pauseMin">): string {
  const pause = row.pauseMin % 60 === 0 ? `${String(row.pauseMin / 60)} ч` : `${String(row.pauseMin)} мин`;
  return `до ${String(row.dailyCap)} в сутки, пауза ${pause}`;
}

/**
 * Работает ли строка сети у игроков и если нет — почему. Порядок — от
 * решения команды к настройке: выключено здесь, нет блока в «Рекламе», нет
 * подтверждения в «Ключах интеграций».
 */
export function networkTaskState(row: Pick<NetworkTaskRow, "active" | "ready">): { tone: "success" | "warning" | "neutral"; label: string } {
  if (!row.active) return { tone: "neutral", label: "Выключено" };
  if (!row.ready.block || !row.ready.confirm) return { tone: "warning", label: "Игроки не видят" };
  return { tone: "success", label: "Работает" };
}

/** Неотрицательное целое из поля формы: пустое и битое — ноль, а не провал черновика. */
function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Черновик предпросмотра (docs/35-stage4-plan.md WP32): из чего игрок видит
 * строку задания — без лимита, порядка и включения. Партнёрская цель — своей
 * вкладкой, с картинкой и ссылкой; у цели забега их нет.
 */
export function taskPreview(task: Pick<TaskDef, "title" | "kind" | "period" | "target" | "coins" | "gems" | "shards" | "image" | "params"> & Partial<TaskDef>): {
  title: string | null;
  kind: string;
  period: TaskDef["period"];
  partner: boolean;
  target: number;
  reward: { coins: number; gems: number; shards: number };
  imageId: string | null;
  link: string | null;
} {
  const partner = PARTNER_KINDS.has(task.kind);
  const link = task.params?.url.trim() ?? "";
  return {
    title: task.title,
    kind: task.kind,
    period: task.period,
    partner,
    target: count(task.target),
    reward: { coins: count(task.coins), gems: count(task.gems), shards: count(task.shards) },
    imageId: partner ? task.image : null,
    link: partner && link !== "" ? link : null,
  };
}
