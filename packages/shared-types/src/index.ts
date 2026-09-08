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

export type EnemyPattern = "swarm" | "chase" | "kite_and_shoot";

export interface EnemyDef {
  id: string;
  hp: number;
  speed: number;
  damage: number;
  pattern: EnemyPattern;
}

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
