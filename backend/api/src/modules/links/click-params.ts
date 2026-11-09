import { isMacroValue, networkParamsOf } from "./link-networks.js";
import type { LinkRecord } from "./links.repository.js";

/**
 * Что ссылка сохраняет на клике (tasks/T-0070, docs/24-attribution-and-sharing.md §3.2): метки сети — как
 * раньше, а у ссылки с владельцем-партнёром или со своим адресом постбэка — ещё и `click_id` и `sub1`…`sub5`.
 * Партнёр кладёт их в адрес ссылки сам, мы сохраняем и возвращаем в постбэке. Хранятся они там же, где метки
 * сети (`link_click.network_params`), и так же обнуляются через 31 сутки.
 */

export const POSTBACK_PARAMS = ["click_id", "sub1", "sub2", "sub3", "sub4", "sub5"] as const;

/**
 * Параметры клика ссылки; `null` — сохранять нечего. Значения проходят то же правило, что метки сети
 * (`isMacroValue`): печатные знаки без пробелов, до 256, без `{`, — неподставленный макрос партнёра
 * (`sub2={sub2}` буквально) отбрасывается. Ссылка без сети, без владельца и без адреса не пишет ничего.
 */
export function clickParamsOf(link: Pick<LinkRecord, "network" | "partner" | "postbackUrl">, query: Readonly<Record<string, string | undefined>>): Record<string, string> | null {
  const params: Record<string, string> = link.network === null ? {} : (networkParamsOf(link.network, query) ?? {});
  if (link.partner !== null || link.postbackUrl !== null) {
    for (const key of POSTBACK_PARAMS) {
      const value = query[key]?.trim();
      if (value === undefined || !isMacroValue(value)) continue;
      params[key] = value;
    }
  }
  return Object.keys(params).length === 0 ? null : params;
}
