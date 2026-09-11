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
}

export interface SharePayload {
  runScore: number;
  runDurationSec: number;
  imageUrl?: string;
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

export interface UpgradeDef {
  id: string;
  name: string;
  description: string;
  /** может встречаться несколько раз в течение забега — стаки */
  maxStacks?: number;
}

// --- Экономика / SKU, см. docs/05-game-design.md §5, docs/07-monetization-and-ads.md ---

export interface EconomyItemDef {
  id: string;
  kind: "skin" | "continue" | "character_unlock" | "ad_removal_pack" | "seasonal";
  priceByPlatform: Partial<Record<Platform, number>>;
}
