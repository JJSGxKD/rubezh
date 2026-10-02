/**
 * Сети, где команда или партнёр закупают рекламу и которым мы отдаём
 * конверсии обратно (docs/35-stage4-plan.md Р86, WP43).
 *
 * Ссылка кампании знает свою сеть: панель сразу отдаёт адрес с макросами
 * сети, переходник сохраняет подставленные сетью значения на клике, а
 * регистрация и покупки игрока уходят постбэком в кабинет, где куплена
 * реклама. Новая сеть — профиль здесь и отправитель постбэка в
 * `modules/ad-conversions`.
 */

export const LINK_NETWORKS = ["adsgram"] as const;
export type LinkNetwork = (typeof LINK_NETWORKS)[number];

export interface LinkNetworkProfile {
  title: string;
  /**
   * Параметр нашего адреса → макрос сети. Порядок — порядок в адресе.
   * Имена — как в примере из документации сети: человеку, который сверяет
   * ссылку с кабинетом, проще узнать знакомое.
   */
  macros: Readonly<Record<string, string>>;
}

/**
 * AdsGram (документация «Трекинг конверсий»): `{record_data}` обязателен для
 * веб-ссылок — а наш адрес веб, через переходник, — `{campaign_id}` — для
 * ссылок внутри Telegram; без обязательного макроса конверсии не
 * отслеживаются. В кампаниях Telegram Ads макросы не передаются.
 */
export const LINK_NETWORK_PROFILES: Readonly<Record<LinkNetwork, LinkNetworkProfile>> = {
  adsgram: {
    title: "AdsGram",
    macros: { campaign: "{campaign_id}", banner: "{banner_id}", pub: "{publisher_id}", clickid: "{click_id}", record: "{record_data}" },
  },
};

export function isLinkNetwork(value: string): value is LinkNetwork {
  return (LINK_NETWORKS as readonly string[]).includes(value);
}

/** Строка запроса с макросами сети — её дописывают к адресу ссылки. */
export function macroQuery(network: LinkNetwork): string {
  return Object.entries(LINK_NETWORK_PROFILES[network].macros)
    .map(([param, macro]) => `${param}=${macro}`)
    .join("&");
}

/**
 * Значение макроса: печатное без пробелов, до 256 знаков. Неподставленный
 * макрос (`{record_data}` буквально) — переход из превью кабинета или ручная
 * проверка ссылки: такого клика сеть не знает, и отдавать его ей незачем.
 */
const MACRO_VALUE = /^[\x21-\x7e]{1,256}$/;

/** Подставленные сетью значения из запроса клика; `null` — ни одного. */
export function networkParamsOf(network: LinkNetwork, query: Readonly<Record<string, string | undefined>>): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (const param of Object.keys(LINK_NETWORK_PROFILES[network].macros)) {
    const value = query[param]?.trim();
    if (value === undefined || !MACRO_VALUE.test(value) || value.includes("{")) continue;
    params[param] = value;
  }
  return Object.keys(params).length === 0 ? null : params;
}
