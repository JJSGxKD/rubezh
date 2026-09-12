// Общие типы для всего монорепо.
// См. docs/01-tech-stack.md §1 и §4 — почему core-game не знает о платформе,
// а всё общение идёт через PlatformAdapter.

export type Platform = "telegram" | "max" | "vk" | "web";

export interface UserContext {
  id: string;
  platform: Platform;
  displayName: string;
  /** null, если платформа не отдаёт фото — см. docs/08-web-and-identity.md §4 */
  avatarUrl: string | null;
  /** только для telegram/web, см. docs/01-tech-stack.md §7 */
  locale?: string;
}

export interface PurchaseResult {
  success: boolean;
  itemId: string;
  transactionId?: string;
  error?: string;
}

export type HapticType = "light" | "medium" | "heavy" | "success" | "error";

export interface AdResult {
  shown: boolean;
  rewarded: boolean;
}

/**
 * Единый интерфейс платформенного адаптера.
 * core-game работает только через него, ничего не знает о конкретной
 * платформе. См. docs/01-tech-stack.md §1.
 */
export interface PlatformAdapter {
  init(): Promise<UserContext>;
  purchase(itemId: string): Promise<PurchaseResult>;
  share(payload: SharePayload): void;
  haptic(type: HapticType): void;
  /** опционально — не везде доступно, см. docs/01-tech-stack.md §6 */
  showAd?(): Promise<AdResult>;
  /** опционально — площадка может не дать хранилища, см. KeyValueStorage */
  storage?: KeyValueStorage;
}

export interface SharePayload {
  runScore: number;
  runDurationSec: number;
  imageUrl?: string;
}

/**
 * Хранилище «ключ — значение» на устройстве: локальный рекорд, настройки,
 * `installId` (docs/27-design-system-and-app-shell.md §7).
 *
 * Порт, а не прямой `localStorage`: на iOS он теряется вместе с данными сайта,
 * и Telegram-адаптер должен уметь переехать на `DeviceStorage` площадки, не
 * трогая ни оболочку, ни движок. Методы синхронные и ничего не бросают —
 * в приватном режиме и при переполнении реализация возвращает `null` и молча
 * пропускает запись: потерянный рекорд не стоит упавшего запуска.
 */
export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

// --- Контент как данные, см. docs/01-tech-stack.md §9 ---

/**
 * Параметры паттернов, которые крутит геймдизайнер. Всё, что не задано в
 * контенте, берётся из умолчаний паттерна в core-game.
 *
 * Расстояния и скорости — в игровых единицах, как `speed` врага; время — в
 * секундах. Ключ карты — имя паттерна: так TypeScript не даст положить врагу
 * параметр чужого паттерна, а опечатка в имени параметра видна сразу, а не
 * через молча проигнорированное значение.
 */
export interface EnemyPatternParams {
  swarm: Record<string, never>;
  chase: {
    /** насколько быстро доворачивает к игроку, доля скорости в секунду */
    steeringPerSec?: number;
  };
  kite_and_shoot: {
    /** дистанция, которую стрелок держит до игрока */
    preferredDistance?: number;
    shotIntervalSec?: number;
    projectileSpeed?: number;
  };
  dash: {
    /** с какого расстояния до игрока начинается подготовка рывка */
    triggerDistance?: number;
    /** сколько враг стоит и мигает перед рывком — время игрока на реакцию */
    telegraphSec?: number;
    dashSpeed?: number;
    dashDurationSec?: number;
    /** передышка после рывка, пока враг снова не пойдёт на игрока */
    recoverSec?: number;
  };
  orbit: {
    /** радиус кольца, на которое враг выходит вокруг игрока */
    orbitRadius?: number;
    /** на сколько кольцо сужается за секунду */
    shrinkPerSec?: number;
    /** радиус, дальше которого кольцо не сужается; 0 — до касания */
    minRadius?: number;
  };
  exploder: {
    /** с какого расстояния до игрока загорается фитиль */
    triggerDistance?: number;
    fuseSec?: number;
    blastRadius?: number;
  };
  splitter: {
    /** id врага, на которых распадается; сам не может быть делящимся */
    childEnemy: string;
    childCount?: number;
  };
}

export type EnemyPattern = keyof EnemyPatternParams;

interface EnemyDefBase {
  id: string;
  hp: number;
  speed: number;
  /** урон касанием, взрывом или снарядом — в зависимости от паттерна */
  damage: number;
  /** опыт за убийство: кристалл такой ценности остаётся на месте смерти */
  xp: number;
}

/**
 * Параметры обязательны только там, где у паттерна нет разумного умолчания:
 * делящемуся врагу не из чего выбрать, на кого распадаться.
 */
type EnemyDefFor<P extends EnemyPattern> = EnemyDefBase & { pattern: P } & (
    {} extends EnemyPatternParams[P]
      ? { params?: EnemyPatternParams[P] }
      : { params: EnemyPatternParams[P] }
  );

export type EnemyDef = { [P in EnemyPattern]: EnemyDefFor<P> }[EnemyPattern];

export interface WaveSpawn {
  enemy: string;
  count: number;
}

export interface WaveDef {
  second: number;
  spawns: WaveSpawn[];
}

// --- Оружие, пассивки и прокачка внутри забега ---
// Персонаж атакует постоянно; вид атаки задаёт оружие, силу — его уровень и
// пассивки. Новое поведение — код, новое оружие на готовом поведении и все
// числа — данные (docs/26-stage2-plan.md, WP2).

export type WeaponBehavior =
  | "projectile_nearest"
  | "projectile_facing"
  | "orbit"
  | "aura"
  | "area_strike";

/**
 * Числа оружия на одном уровне. Что именно значит поле, зависит от поведения:
 * у зоны урона `cooldownSec` — период тика, у снаряда — перезарядка.
 * Незаданное поле поведение берёт из своих умолчаний.
 */
export interface WeaponLevel {
  damage: number;
  cooldownSec: number;
  /** снарядов или орбитеров за срабатывание */
  projectiles?: number;
  /** сколько врагов пробивает снаряд, прежде чем исчезнуть */
  pierce?: number;
  /** радиус зоны: аура, удар по площади, орбита */
  areaRadius?: number;
  projectileSpeed?: number;
  /** время жизни снаряда или зоны */
  ttlSec?: number;
}

export interface WeaponDef {
  id: string;
  behavior: WeaponBehavior;
  nameKey: string;
  descriptionKey: string;
  /** можно выбрать на старте забега */
  starting?: boolean;
  /** вес в выборе улучшений; по умолчанию 1 */
  weight?: number;
  /** уровни по порядку: levels[0] — первый уровень */
  levels: WeaponLevel[];
}

/** Характеристики игрока, которые меняют пассивки. */
export type PlayerStat =
  | "damage"
  | "cooldown"
  | "area"
  | "projectileSpeed"
  | "duration"
  | "projectiles"
  | "moveSpeed"
  | "maxHp"
  | "regenPerSec"
  | "pickupRadius"
  | "armor";

/**
 * Пассивное улучшение. `levels` — итоговое значение на каждом уровне, а не
 * прибавка к предыдущему: так в таблице сразу видно, что даёт третий уровень,
 * и нельзя случайно получить произведение прибавок.
 */
export interface PassiveDef {
  id: string;
  nameKey: string;
  descriptionKey: string;
  stat: PlayerStat;
  /** `mul` — множитель (1.1 это +10%), `add` — слагаемое */
  op: "add" | "mul";
  weight?: number;
  levels: number[];
}

/** Сколько оружий и пассивок игрок держит одновременно. */
export interface LoadoutLimits {
  weapons: number;
  passives: number;
}

/**
 * Кривая опыта: сколько нужно на уровень N. Задаётся формулой, а не таблицей
 * на сто строк, — геймдизайнеру нужно крутить темп, а не каждое число.
 */
export interface LevelCurveDef {
  /** опыт на второй уровень */
  baseXp: number;
  /** во сколько раз дороже следующий уровень */
  growth: number;
}

export type UpgradeOptionKind =
  | "weapon_new"
  | "weapon_level"
  | "passive_new"
  | "passive_level"
  | "heal";

/**
 * Вариант выбора при наборе уровня. `id` устойчив между прогонами — именно он
 * пишется в лог ввода, чтобы забег воспроизводился (docs/28-diagnostics.md §3.4).
 */
export interface UpgradeOption {
  id: string;
  kind: UpgradeOptionKind;
  /** id оружия или пассивки; для лечения — пустая строка */
  refId: string;
  /** уровень, который игрок получит, выбрав вариант */
  level: number;
  nameKey: string;
  descriptionKey: string;
}

// --- Итог забега, см. docs/26-stage2-plan.md, WP3 ---
// Движок считает и отдаёт, оболочка показывает на экране смерти и отправляет
// событием `run_finished` / `run_abandoned`. Сам движок в сеть не ходит и об
// аналитике не знает (docs/27-design-system-and-app-shell.md §3.1).
//
// Считает это всё клиент, поэтому для сервера `RunResult` — заявление игрока,
// а не факт (docs/15-engineering-standards.md §7.1). Приёмник телеметрии
// (WP8) обязан относиться к нему так же: для аналитики закрытого теста этого
// достаточно, для лидерборда этапа 4 — нет, там нужна перепроверка забега по
// seed'у и логу ввода (docs/17-testing-strategy.md §3.5).

/** Чем закончился забег: смертью или сдачей на экране паузы. */
export type RunOutcome = "died" | "abandoned";

export interface RunWeaponSummary {
  id: string;
  level: number;
  /** нанесённый урон — главный вход геймдизайнера для баланса оружий */
  damage: number;
}

export interface RunPassiveSummary {
  id: string;
  level: number;
}

export interface RunResult {
  runId: string;
  /** seed забега: с ним и логом ввода забег воспроизводится целиком */
  seed: number;
  outcome: RunOutcome;
  startingWeaponId: string;
  /** главный показатель забега (Р2) и будущая метрика лидерборда */
  survivalSec: number;
  level: number;
  xpCollected: number;
  enemiesKilled: number;
  /** убийства по id врага; враги без убийств не попадают */
  killsByEnemy: Record<string, number>;
  damageDealt: number;
  damageTaken: number;
  weapons: RunWeaponSummary[];
  passives: RunPassiveSummary[];
  /** id врага, нанёсшего смертельный урон; null — забег кончился не смертью */
  deathCause: string | null;
  /** пройденное расстояние в игровых единицах — показатель стиля игры */
  distance: number;
  /** пик числа врагов одновременно в мире */
  peakEnemies: number;
}

// --- Экономика / SKU, см. docs/05-game-design.md §5, docs/07-monetization-and-ads.md ---

export interface EconomyItemDef {
  id: string;
  kind: "skin" | "continue" | "character_unlock" | "ad_removal_pack" | "seasonal";
  priceByPlatform: Partial<Record<Platform, number>>;
}
