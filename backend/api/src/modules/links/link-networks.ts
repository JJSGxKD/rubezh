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
  /**
   * Какие из `macros` едут в прямую ссылку на Mini App (Р121) и в каком порядке.
   * Прямая ссылка — это стартовый параметр, он ограничен 512 знаками, поэтому в
   * неё берут только то, без чего конверсию не отправить и не сверить.
   * Последним стоит ключ, значение которого читается до конца строки
   * (`GREEDY_KEY`): внутри него бывают `_` и `-`, и после него ключи не разобрать.
   */
  direct: readonly string[];
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
    direct: ["campaign", "clickid", "record"],
  },
};

/** Все имена параметров меток всех сетей: по ним хвост прямой ссылки делится на пары. */
export const NETWORK_PARAM_KEYS: readonly string[] = [...new Set(Object.values(LINK_NETWORK_PROFILES).flatMap((profile) => Object.keys(profile.macros)))];

/**
 * Ключ, значение которого идёт до конца строки: `{record_data}` AdsGram — случайная строка с `_` и `-`,
 * и искать в ней границу следующей пары нельзя.
 */
const GREEDY_KEY = "record";

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

/**
 * Годится ли значение метки. Одно правило на метки сети и на `click_id` и `sub1`…`sub5` партнёра
 * (`click-params.ts`): второго не заводят.
 */
export function isMacroValue(value: string): boolean {
  return MACRO_VALUE.test(value) && !value.includes("{");
}

/** Подставленные сетью значения из запроса клика; `null` — ни одного. */
export function networkParamsOf(network: LinkNetwork, query: Readonly<Record<string, string | undefined>>): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (const param of Object.keys(LINK_NETWORK_PROFILES[network].macros)) {
    const value = query[param]?.trim();
    if (value === undefined || !isMacroValue(value)) continue;
    params[param] = value;
  }
  return Object.keys(params).length === 0 ? null : params;
}

/**
 * Хвост прямой ссылки на Mini App: `_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}`.
 * Значения — макросы профиля как есть, без кодирования: сеть ищет их в адресе буквально.
 */
export function directMacroTail(network: LinkNetwork): string {
  const { macros, direct } = LINK_NETWORK_PROFILES[network];
  return direct.map((key) => `_${key}-${macros[key] ?? ""}`).join("");
}

const TAIL_MARKER = new RegExp(`_(${NETWORK_PARAM_KEYS.join("|")})-`, "g");

/**
 * Метки сети из хвоста стартового параметра после кода ссылки (`l-<код>` + хвост). Хвост должен
 * начинаться с `_<ключ>-`, иначе это не метки сети и ответ `null`. Значение идёт до следующего
 * `_<ключ>-`, а значение `record` — до конца строки. Повтор ключа не перетирает первое значение;
 * пустое (неподставленный макрос) и не прошедшее проверку значение отбрасывается. Ключ в профиль
 * конкретной сети не проверяется: это делает `networkParamsOf`, когда известна сеть ссылки.
 */
export function networkTailParams(tail: string): Record<string, string> | null {
  const markers = [...tail.matchAll(TAIL_MARKER)];
  if (markers[0]?.index !== 0) return null;

  const params: Record<string, string> = {};
  for (const [position, marker] of markers.entries()) {
    const key = marker[1];
    if (key === undefined) continue;
    const start = (marker.index ?? 0) + marker[0].length;
    const end = key === GREEDY_KEY ? tail.length : (markers[position + 1]?.index ?? tail.length);
    const value = tail.slice(start, end);
    if (isMacroValue(value) && !(key in params)) params[key] = value;
    if (key === GREEDY_KEY) break;
  }
  return Object.keys(params).length === 0 ? null : params;
}
