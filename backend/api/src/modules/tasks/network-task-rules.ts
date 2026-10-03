import { z } from "zod";
import type { PlaceHistory } from "../ads/ads.repository.js";

/**
 * Задания рекламных сетей во вкладке «Партнёры» (docs/35-stage4-plan.md
 * WP13, часть 6, Р80): сами задания приходят от сети, а каталог держит
 * строку на сеть — сколько её заданий игрок получит за игровые сутки,
 * паузу после выполненного и награду. Бесконечная лента обесценила бы и
 * награду, и само задание (О41).
 *
 * Чистые функции без базы: выполненные считаются по истории места `task`
 * (сессии с начала вчерашних игровых суток), её даёт модуль рекламы.
 */

/**
 * Пределы строки — те же у формы панели и в базе. Пауза не короче пяти
 * минут: сеть может повторить подтверждение, и повтор не должен выполнить
 * следующее задание игрока, заведённое сразу за первым.
 */
export const NETWORK_TASK_LIMITS = {
  dailyCap: { min: 1, max: 50 },
  pauseMin: { min: 5, max: 24 * 60 },
} as const;

/** Строка сети — как её правит панель и читает сервер. */
export const networkTaskSchema = z
  .object({
    networkKey: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
    active: z.boolean(),
    dailyCap: z.number().int().min(NETWORK_TASK_LIMITS.dailyCap.min).max(NETWORK_TASK_LIMITS.dailyCap.max),
    pauseMin: z.number().int().min(NETWORK_TASK_LIMITS.pauseMin.min).max(NETWORK_TASK_LIMITS.pauseMin.max),
    coins: z.number().int().nonnegative().max(100_000),
    gems: z.number().int().nonnegative().max(1_000),
    shards: z.number().int().nonnegative().max(1_000),
  })
  .strict()
  .refine((task) => task.coins + task.gems + task.shards > 0, { message: "задание без награды" });

export type NetworkTaskDef = z.infer<typeof networkTaskSchema>;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface NetworkTaskState {
  /** выполнено за текущие игровые сутки */
  doneToday: number;
  /** последнее выполненное — от него идёт пауза */
  lastDoneAt: Date | null;
}

/**
 * Выполненное — то, что подтвердила сеть (`completed_at`), забрано оно или
 * нет: награду за подтверждённое задание игрок получит, а потолок
 * считает задания, а не выдачи.
 */
export function networkTaskState(networkKey: string, history: PlaceHistory): NetworkTaskState {
  let doneToday = 0;
  let lastDoneAt: Date | null = null;
  for (const session of history.sessions) {
    if (session.networkKey !== networkKey || session.completedAt === null) continue;
    if (session.completedAt >= history.dayStart) doneToday++;
    if (lastDoneAt === null || session.completedAt > lastDoneAt) lastDoneAt = session.completedAt;
  }
  return { doneToday, lastDoneAt };
}

/**
 * Когда сеть даст следующее задание; `null` — уже даёт. Потолок суток
 * выбран — с начала следующих игровых суток, но не раньше конца паузы.
 */
export function nextTaskAt(def: Pick<NetworkTaskDef, "dailyCap" | "pauseMin">, state: NetworkTaskState, dayStart: Date, at: Date): Date | null {
  const pauseEnd = state.lastDoneAt === null ? 0 : state.lastDoneAt.getTime() + def.pauseMin * MINUTE_MS;
  const capEnd = state.doneToday >= def.dailyCap ? dayStart.getTime() + DAY_MS : 0;
  const next = Math.max(pauseEnd, capEnd);
  return next > at.getTime() ? new Date(next) : null;
}

/** Можно ли выдать новое задание сети: потолок суток не выбран и пауза прошла. */
export function admitsTask(def: Pick<NetworkTaskDef, "dailyCap" | "pauseMin">, history: PlaceHistory, networkKey: string, at: Date): boolean {
  return nextTaskAt(def, networkTaskState(networkKey, history), history.dayStart, at) === null;
}
