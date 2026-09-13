/**
 * Примеры для заглушек меты: награда дня, колесо, задания, достижения.
 *
 * Это не баланс. Настоящие награды, задания и шансы появятся вместе с
 * экономикой (этапы 4–5) и будут жить на сервере — клиенту нельзя доверять
 * выдачу валюты (docs/07-monetization-and-ads.md §7). Здесь — ровно столько,
 * чтобы экраны выглядели как будущие разделы и тестеры понимали, что там
 * будет.
 */

/**
 * Виды наград. Осколки — валюта забегов, самоцветы — донатная; названия —
 * рабочие, до решения по сеттингу. Сундуков со случайным содержимым нет и не
 * будет: это та же механика лутбокса под другим именем
 * (docs/03-notes-and-risks.md).
 */
export type RewardKind = "shards" | "premium" | "boost" | "skin";

export interface Reward {
  kind: RewardKind;
  amount: number;
}

function shards(amount: number): Reward {
  return { kind: "shards", amount };
}

function premium(amount: number): Reward {
  return { kind: "premium", amount };
}

function boost(amount: number): Reward {
  return { kind: "boost", amount };
}

function skin(amount: number): Reward {
  return { kind: "skin", amount };
}

/** Награда дня: семь дней, последний — крупный. */
export const DAILY_REWARDS: readonly Reward[] = [
  shards(100),
  boost(1),
  shards(200),
  premium(5),
  shards(300),
  boost(2),
  skin(1),
];

/**
 * Сектора колеса по часовой стрелке от верха. `weight` — шанс в процентах:
 * шансы показываются игроку на том же экране. Донатной валюты в колесе нет —
 * крутка бесплатная или за рекламу, и денежный путь к случайной награде
 * закрыт с обеих сторон (docs/07-monetization-and-ads.md §7).
 */
export interface WheelSector {
  reward: Reward;
  weight: number;
}

export const WHEEL_SECTORS: readonly WheelSector[] = [
  { reward: shards(50), weight: 26 },
  { reward: boost(1), weight: 16 },
  { reward: shards(100), weight: 18 },
  { reward: shards(500), weight: 3 },
  { reward: shards(25), weight: 24 },
  { reward: boost(2), weight: 7 },
  { reward: shards(250), weight: 5 },
  { reward: skin(1), weight: 1 },
];

export type TaskIcon = "runs" | "kills" | "survive" | "upgrades" | "elites" | "record";

export interface TaskDef {
  id: string;
  /** ключ i18n; `{target}` подставляется из `target` */
  titleKey: string;
  icon: TaskIcon;
  target: number;
  reward: Reward;
}

export const DAILY_TASKS: readonly TaskDef[] = [
  { id: "daily_runs", titleKey: "task.runs", icon: "runs", target: 3, reward: shards(60) },
  { id: "daily_kills", titleKey: "task.kills", icon: "kills", target: 300, reward: shards(80) },
  { id: "daily_survive", titleKey: "task.surviveMinutes", icon: "survive", target: 5, reward: shards(100) },
  { id: "daily_upgrades", titleKey: "task.upgrades", icon: "upgrades", target: 20, reward: boost(1) },
];

export const WEEKLY_TASKS: readonly TaskDef[] = [
  { id: "weekly_runs", titleKey: "task.runs", icon: "runs", target: 20, reward: shards(400) },
  { id: "weekly_kills", titleKey: "task.kills", icon: "kills", target: 5000, reward: shards(500) },
  { id: "weekly_elites", titleKey: "task.elites", icon: "elites", target: 30, reward: premium(10) },
];

/**
 * Достижения. Прогресс тех, что считаются по уже сохранённому на устройстве
 * (рекорд, число забегов), виден по-настоящему; выдачи наград пока нет.
 */
export type AchievementMetric = "bestSurvivalSec" | "runs";

export interface AchievementDef {
  id: string;
  icon: TaskIcon;
  metric: AchievementMetric;
  target: number;
  reward: Reward;
}

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { id: "survive_1", icon: "survive", metric: "bestSurvivalSec", target: 60, reward: shards(100) },
  { id: "survive_5", icon: "survive", metric: "bestSurvivalSec", target: 300, reward: premium(10) },
  { id: "survive_10", icon: "record", metric: "bestSurvivalSec", target: 600, reward: skin(1) },
  { id: "runs_10", icon: "runs", metric: "runs", target: 10, reward: shards(200) },
  { id: "runs_50", icon: "runs", metric: "runs", target: 50, reward: premium(20) },
];

export interface AchievementProgress {
  value: number;
  target: number;
  done: boolean;
}

export function achievementProgress(
  def: AchievementDef,
  stats: Readonly<Record<AchievementMetric, number>>,
): AchievementProgress {
  const raw = stats[def.metric];
  // Битое хранилище не должно показывать «NaN из 10» или полосу за край.
  const value = Number.isFinite(raw) && raw > 0 ? Math.min(raw, def.target) : 0;
  return { value, target: def.target, done: value >= def.target };
}
