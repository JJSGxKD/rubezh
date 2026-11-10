import { randomBytes } from "node:crypto";
import type { NodeState, StoredNode } from "./subscription.repository.js";

/**
 * Правила нескольких подписок Xray (docs/35-stage4-plan.md Р192,
 * tasks/T-0384): предел числа, формат ключа, доля входов, ссылка на узел в
 * пуле и порядок снятия узлов сверх доли. Чистые функции без базы и сети.
 */

/**
 * Не больше десяти: входов спутника (`XRAY_SLOT_COUNT`) по умолчанию 100, и при
 * десяти подписках на каждую приходится не меньше десяти узлов — ниже этого
 * подписка в переборе почти ничего не добавляет. Загрузка подписки идёт до 15 с
 * под замком в 120 с: за тик успевают несколько подписок, а десять обходятся за
 * пару минут. Поднять предел — правка кода, не панели.
 */
export const SUBSCRIPTIONS_MAX = 10;

/**
 * Ключ подписки: строчные латиница и цифры. От ключа зависят имя шифртекста
 * адреса и `x-hwid`, поэтому он неизменен с рождения; он же входит в тег выхода
 * Xray и в имя файла-части в томе, потому формат жёсткий.
 */
export const SUBSCRIPTION_KEY_FORMAT = /^[a-z0-9]{1,16}$/;

/** Ключ новой подписки: 12 строчных hex. Исходная подписка сохранила ключ `main`. */
export const newSubscriptionKey = (): string => randomBytes(6).toString("hex");

/**
 * Доля входов одной подписки: поровну между всеми, включая выключенные.
 * Выключение не отдаёт входы другим — включение назад мгновенное, без загрузки.
 */
export const slotQuota = (slotCount: number, subscriptions: number): number => Math.floor(slotCount / Math.max(1, subscriptions));

/** Узел в пуле и в журнале: ключ узла уникален только внутри подписки. */
export const nodeRef = (subscriptionKey: string, nodeKey: string): string => `${subscriptionKey}:${nodeKey}`;

const REMOVAL_RANK: Record<NodeState, number> = { down: 0, unknown: 1, healthy: 2 };

/**
 * Какие узлы снять, если их больше доли: сначала не отвечающие, затем не
 * проверенные, затем здоровые с большей задержкой; при равенстве — с большим
 * слотом (его освобождать выгоднее: наименьшие слоты остаются на месте).
 * Возвращает снимаемые узлы в порядке снятия; узлов не больше доли — пусто.
 */
export function trimToQuota(nodes: readonly StoredNode[], quota: number): StoredNode[] {
  const excess = nodes.length - Math.max(0, quota);
  if (excess <= 0) return [];
  return [...nodes]
    .sort((a, b) => REMOVAL_RANK[a.state] - REMOVAL_RANK[b.state] || (b.latencyMs ?? Infinity) - (a.latencyMs ?? Infinity) || b.slot - a.slot)
    .slice(0, excess);
}
