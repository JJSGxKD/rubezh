/**
 * Цель ссылки кампании (docs/35-stage4-plan.md Р95, docs/24-attribution-and-sharing.md §3):
 * куда попадает человек и какой адрес у прямой ссылки. Чистые функции без
 * Nest и базы: адреса Mini App и чата собирает адаптер площадки и отдаёт
 * построителями, лендинг живёт на том же домене, что переходник.
 *
 * - `app` — Mini App площадки (умолчание, как было до целей);
 * - `bot` — чат с ботом, `/start <параметр>`;
 * - `landing` — лендинг: параметр уходит в адрес, а что с ним делать, решает
 *   страница.
 *
 * Прямая ссылка идёт без переходника: короче и без лишней страницы, но клика
 * нет, есть только запуск. У ссылки сети она тоже есть, но только у цели `app`
 * (Р121): метки клика едут в стартовом параметре Mini App (до 512 знаков), а в
 * `/start` бота (до 64) они не умещаются, у лендинга параметра запуска нет.
 */

import { directMacroTail, isLinkNetwork } from "./link-networks.js";

export const LINK_TARGETS = ["app", "bot", "landing"] as const;
export type LinkTarget = (typeof LINK_TARGETS)[number];

export function isLinkTarget(value: string): value is LinkTarget {
  return (LINK_TARGETS as readonly string[]).includes(value);
}

export interface LinkTargetBuilders {
  /** адрес Mini App с параметром запуска; `rawTail` дописывается без кодирования; `null` — сейчас не собрать */
  launch(param: string, rawTail?: string): string | null;
  /** адрес чата с ботом с параметром `/start`; `null` — сейчас не собрать */
  chat(param: string): string | null;
  /** домен лендинга без завершающей косой черты; пустой — адреса нет */
  landingBase: string;
}

/** Адрес по цели: у лендинга параметр — запрос `?<имя>=<значение>`. */
function addressOf(target: LinkTarget, param: string, landingQuery: "c" | "l", value: string, builders: LinkTargetBuilders): string | null {
  switch (target) {
    case "app":
      return builders.launch(param);
    case "bot":
      return builders.chat(param);
    case "landing":
      return builders.landingBase === "" ? null : `${builders.landingBase}/?${landingQuery}=${encodeURIComponent(value)}`;
  }
}

/** Куда ведёт переходник после клика. `null` — цель сейчас не собрать. */
export function clickTarget(target: LinkTarget, clickId: string, builders: LinkTargetBuilders): string | null {
  return addressOf(target, `c-${clickId}`, "c", clickId, builders);
}

/**
 * Диплинк той же цели: только `app` и `bot`; у лендинга и у площадки без
 * диплинков — `null`, и переходник отвечает обычным 302 (Р94, Р95).
 */
export function clickDeepTarget(
  target: LinkTarget,
  clickId: string,
  builders: { launchDeep(param: string): string | null; chatDeep(param: string): string | null },
): string | null {
  switch (target) {
    case "app":
      return builders.launchDeep(`c-${clickId}`);
    case "bot":
      return builders.chatDeep(`c-${clickId}`);
    case "landing":
      return null;
  }
}

/**
 * Прямая ссылка; `null` — у ссылки сети с целью не `app` её нет, сеть неизвестна или площадку сейчас
 * не собрать. У ссылки сети в адресе макросы сети без кодирования — их подставляет сама сеть.
 */
export function directUrl(link: { code: string; target: LinkTarget; network: string | null }, builders: LinkTargetBuilders): string | null {
  if (link.network === null) return addressOf(link.target, `l-${link.code}`, "l", link.code, builders);
  if (!isLinkNetwork(link.network) || link.target !== "app") return null;
  return builders.launch(`l-${link.code}`, directMacroTail(link.network));
}
