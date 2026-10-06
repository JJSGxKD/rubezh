/**
 * Реклама в числах и правилах (docs/35-stage4-plan.md §3.7, WP12;
 * docs/07-monetization-and-ads.md). Чистые функции без базы и Redis: их
 * проверяют тесты, а сервис лишь подставляет состояние.
 *
 * Меняются здесь, в карте конфигурации — docs/30-configuration-map.md.
 */

/**
 * Места показа (§3.7): второй шанс, крутка колеса, удвоение награды за
 * забег, задания и межстраничная между забегами (О18). Награду за место
 * выдаёт его хозяин — колесо, забег, задания, — забирая сессию показа; модуль
 * рекламы лишь ручается, что показ был.
 */
export const AD_PLACES = ["second_chance", "wheel_spin", "run_double", "task", "interstitial"] as const;
export type AdPlace = (typeof AD_PLACES)[number];

/**
 * Условие успеха предложения (Р6): какой-то рекламе достаточно показа,
 * какой-то клика, а какой-то — целевого действия. Задаётся у блока сети.
 */
export const AD_SUCCESS = ["view", "click", "cpa"] as const;
export type AdSuccess = (typeof AD_SUCCESS)[number];

/** Устройство игрока — для флагов блока: сеть может не работать на десктопе. */
export const AD_DEVICES = ["android", "ios", "desktop", "web"] as const;
export type AdDevice = (typeof AD_DEVICES)[number];

export interface PlaceRules {
  /** за показ в месте игрок получает награду; межстраничная — без награды, и VIP её не видит (§3.6) */
  rewarded: boolean;
  /**
   * VIP получает награду места без ролика (§3.6). Задание сети — не ролик:
   * его выполняют руками, и пропуск его не заменяет.
   */
  pass: boolean;
  /**
   * Пауза после награды: база × множитель в степени (наград за сутки − 1),
   * не больше потолка. Частые награды становятся реже, не исчезая (§3.7).
   * `null` — места без награды или с ограничением у хозяина (второй шанс
   * ограничен числом продолжений в забеге).
   */
  cooldown: { baseMin: number; factor: number; capMin: number } | null;
}

/**
 * **Рабочие числа (Р31)**, О27 решит окончательно. Колесо за рекламу — раз в
 * два часа, дальше реже, до шести (Р44: кулдаун у всех, VIP пропускает только
 * ролик). Удвоение за забег — после каждого забега, но всё реже к вечеру.
 * Как часто показывать межстраничную, решает её политика
 * (`interstitial-policy.ts`) числами из панели.
 */
export const PLACE_RULES: Record<AdPlace, PlaceRules> = {
  second_chance: { rewarded: true, pass: true, cooldown: null },
  wheel_spin: { rewarded: true, pass: true, cooldown: { baseMin: 120, factor: 1.5, capMin: 360 } },
  run_double: { rewarded: true, pass: true, cooldown: { baseMin: 5, factor: 1.5, capMin: 60 } },
  // Сколько заданий сети и как часто, решает хозяин места — задания — по
  // строке сети из панели (`tasks/network-task-rules.ts`).
  task: { rewarded: true, pass: false, cooldown: null },
  interstitial: { rewarded: false, pass: false, cooldown: null },
};

/**
 * Места, которые клиент просит сам (`POST /ads/sessions`). Задание сети
 * выдаёт хозяин места по своему потолку — иначе прямой запрос обходил бы
 * его, а подтверждение сети выполнило бы чужую сессию.
 */
export const OFFERED_PLACES = AD_PLACES.filter((place): place is Exclude<AdPlace, "task"> => place !== "task");

/**
 * Сколько живёт сессия показа. Показ и клик решаются за минуты; целевое
 * действие сеть подтверждает днями — сессия ждёт постбэка.
 */
export const SESSION_TTL_MIN: Record<AdSuccess, number> = { view: 30, click: 60, cpa: 7 * 24 * 60 };

/** Сеть, показанная игроку в этом месте за последний час, пропускается: у сетей свой лимит частоты. */
export const NETWORK_PAUSE_MIN = 60;

/** Пауза после `ordinal`-й награды за сутки, минуты; до первой — ноль. */
export function cooldownMinutes(rules: PlaceRules["cooldown"], ordinal: number): number {
  if (rules === null || ordinal <= 0) return 0;
  let delay = rules.baseMin;
  for (let index = 1; index < ordinal && delay < rules.capMin; index++) delay *= rules.factor;
  return Math.min(rules.capMin, Math.round(delay));
}

/**
 * Больше всего наград места за игровые сутки: первая в полночь, каждая
 * следующая — сразу по кулдауну. По этому числу хозяин места сверяет свой
 * суточный потолок кошелька; `null` — кулдауна нет, считает хозяин.
 */
export function maxRewardsPerDay(place: AdPlace): number | null {
  const rules = PLACE_RULES[place].cooldown;
  if (rules === null) return null;
  let rewards = 1;
  for (let minute = cooldownMinutes(rules, 1); minute < 24 * 60; minute += cooldownMinutes(rules, rewards)) rewards++;
  return rewards;
}

/**
 * Сколько ждёт выполненная сессия, пока хозяин места её заберёт. Показ
 * забирают сразу — окно лишь переживает обрыв сети; целевое действие
 * подтверждается днями, а игрок может открыть игру ещё позже. Окно не даёт
 * копить досмотренные ролики впрок.
 */
export const CLAIM_WINDOW_MIN: Record<AdSuccess, number> = { view: 30, click: 30, cpa: 7 * 24 * 60 };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Сессия места в истории игрока — то, из чего выводятся пауза сетей и кулдаун. */
export interface PlaceHistoryEntry {
  networkKey: string;
  createdAt: Date;
  shownAt: Date | null;
  claimedAt: Date | null;
}

export interface PlaceState {
  /** последняя награда и которой по счёту она была в свои игровые сутки */
  lastReward: { at: Date; ordinal: number } | null;
  /** сеть последней награды этих суток — от неё идёт круг */
  lastRewardedToday: string | null;
  /** сеть → когда её в последний раз выдавали в этом месте за паузу, мс */
  seenAt: Map<string, number>;
}

/**
 * Состояние места по истории с начала вчерашних суток. Кулдаун последней
 * награды переживает полночь: счёт наград обнуляется, а пауза после
 * вчерашней награды — нет, иначе ролики приберегали бы к полуночи. Суток в
 * Москве всегда 24 часа — перевода часов нет.
 *
 * Сеть считается выданной с момента выдачи, а не показа: не отдавшая рекламу
 * сеть тоже уходит на паузу — так отказ первой сети уводит к следующей.
 */
export function placeState(sessions: readonly PlaceHistoryEntry[], dayStart: Date, now: Date): PlaceState {
  const today = dayStart.getTime();
  const yesterday = today - DAY_MS;
  const pauseFrom = now.getTime() - NETWORK_PAUSE_MIN * MINUTE_MS;
  let last: { at: Date; networkKey: string } | null = null;
  let rewardsToday = 0;
  let rewardsYesterday = 0;
  const seenAt = new Map<string, number>();
  for (const session of sessions) {
    const created = session.createdAt.getTime();
    if (created > pauseFrom) seenAt.set(session.networkKey, Math.max(created, seenAt.get(session.networkKey) ?? 0));
    if (session.claimedAt === null) continue;
    const claimed = session.claimedAt.getTime();
    if (claimed >= today) rewardsToday++;
    else if (claimed >= yesterday) rewardsYesterday++;
    if (last === null || session.claimedAt > last.at) last = { at: session.claimedAt, networkKey: session.networkKey };
  }
  const lastToday = last !== null && last.at.getTime() >= today;
  return {
    lastReward: last === null ? null : { at: last.at, ordinal: lastToday ? rewardsToday : rewardsYesterday },
    lastRewardedToday: lastToday && last !== null ? last.networkKey : null,
    seenAt,
  };
}

/** Когда в месте снова можно забрать награду; `null` — уже можно. */
export function nextRewardAt(place: AdPlace, state: PlaceState, now: Date): Date | null {
  if (state.lastReward === null) return null;
  const at = state.lastReward.at.getTime() + cooldownMinutes(PLACE_RULES[place].cooldown, state.lastReward.ordinal) * MINUTE_MS;
  return at > now.getTime() ? new Date(at) : null;
}

export interface NetworkCandidate {
  networkKey: string;
  /** меньше — раньше в круге */
  priority: number;
}

/**
 * Порядок сетей для показа (§3.7): показанная игроку в этом месте за час
 * пропускается; в пределах суток — круг по приоритету от сети последней
 * награды; все сети на паузе — первой идёт та, что показывалась давнее всех.
 *
 * `seenAt` — когда сеть в последний раз показывалась в этом месте за час;
 * `lastRewarded` — сеть последней награды в этом месте за игровые сутки.
 */
export function networkOrder(networks: readonly NetworkCandidate[], seenAt: ReadonlyMap<string, number>, lastRewarded: string | null): NetworkCandidate[] {
  const sorted = [...networks].sort((a, b) => a.priority - b.priority || a.networkKey.localeCompare(b.networkKey));
  const fresh = sorted.filter((network) => !seenAt.has(network.networkKey));
  if (fresh.length === 0) return [...sorted].sort((a, b) => (seenAt.get(a.networkKey) ?? 0) - (seenAt.get(b.networkKey) ?? 0));
  const last = lastRewarded === null ? undefined : sorted.find((network) => network.networkKey === lastRewarded);
  if (last === undefined) return fresh;
  // Следующие по кругу — после сети последней награды, затем с начала круга.
  const after = fresh.filter((network) => network.priority > last.priority);
  const before = fresh.filter((network) => network.priority <= last.priority);
  return [...after, ...before];
}
