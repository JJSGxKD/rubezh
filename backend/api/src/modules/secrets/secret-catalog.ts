import { randomBytes } from "node:crypto";
import type { AppConfig } from "../../config/app-config.js";

/**
 * Каталог ключей интеграций (docs/35-stage4-plan.md Р84, WP46): токены
 * внешних сервисов, которые команда меняет из панели без релиза и без
 * доступа к серверу.
 *
 * Порядок тот же, что у настроек: панель → окружение. Значение из панели
 * лежит в базе только шифртекстом (`secret-cipher.ts`), и панель его не
 * показывает никогда — только последние знаки, чтобы сверить с кабинетом.
 *
 * **Сюда не попадают** внутренние секреты (JWT, сессии, псевдонимы
 * выгрузок, сам ключ шифрования), адреса базы и Redis и токен бота: им
 * подписан вход каждого игрока и вход в панель, и ошибку в нём из панели уже
 * не исправить.
 */

export interface SecretCheckResult {
  ok: boolean;
  /** что ответил сервис — словами для панели */
  message: string;
}

export interface SecretDefinition {
  /** `fx.coingecko-pro` — латиница, точки, дефисы */
  readonly key: string;
  /** сервис — по нему ключи сгруппированы в панели */
  readonly service: string;
  readonly title: string;
  /** что даёт ключ и что будет без него */
  readonly hint: string;
  /** где взять: кабинет сервиса; `null` — ссылки нет */
  readonly cabinetUrl: string | null;
  /** вид ключа — проверяется до записи: опечатку лучше поймать в форме, чем в отказе сервиса */
  readonly pattern: RegExp;
  /** как выглядит ключ — для подсказки в поле */
  readonly example: string;
  /** значение из окружения; `null` — там не задано */
  readonly fromEnv: (config: AppConfig) => string | null;
  /** проверка связи с сервисом этим ключом; нет — сервис проверки не даёт */
  readonly check?: (value: string, fetchImpl: typeof fetch) => Promise<SecretCheckResult>;
  /**
   * Ключ создаёт наш сервер, а не сервис: секрет в адресе, который зовёт
   * сеть. Панель его не вводит, а просит создать — и сервер один раз
   * показывает, что вставить в кабинет сервиса: адрес с секретом. Дальше —
   * только последние знаки, как у любого ключа.
   */
  readonly generated?: GeneratedSecret;
}

export interface GeneratedSecret {
  /** что вставить в кабинет сервиса — с новым секретом внутри */
  readonly reveal: (value: string, config: AppConfig) => string;
  /** куда именно вставить — словами для панели */
  readonly where: string;
  /** как создать значение, если сервис принимает не любой знак; нет — 32 случайных байта в base64url */
  readonly generate?: () => string;
}

export const SECRET_KEY = /^[a-z][a-z0-9.-]{1,63}$/;

/** Любой ключ — без пробелов и служебных знаков: перенос строки из буфера обмена — частая опечатка. */
export const SECRET_TEXT = /^[\x21-\x7e]{1,512}$/;

const CHECK_TIMEOUT_MS = 5_000;

const nonEmpty = (value: string): string | null => (value === "" ? null : value);

interface KeyCheckSpec {
  /** как сервис называется в сообщениях панели */
  service: string;
  url: (value: string) => string;
  headers: (value: string) => Record<string, string>;
  /** что проверить, когда сервис не принял ключ */
  refusalHint: string;
}

/** Проверка связи с сервисом ключом: один лёгкий запрос, ответы — словами для панели. */
function keyCheck(spec: KeyCheckSpec) {
  return async (value: string, fetchImpl: typeof fetch): Promise<SecretCheckResult> => {
    try {
      const response = await fetchImpl(spec.url(value), {
        headers: { ...spec.headers(value), accept: "application/json" },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (response.ok) return { ok: true, message: `${spec.service} принял ключ` };
      if (response.status === 401 || response.status === 403 || response.status === 400) {
        return { ok: false, message: `${spec.service} не принял ключ (${String(response.status)}): ${spec.refusalHint}` };
      }
      if (response.status === 429) return { ok: false, message: `${spec.service} ответил «слишком много запросов» — ключ не проверен, попробуйте через минуту` };
      return { ok: false, message: `${spec.service} ответил ${String(response.status)} — ключ не проверен` };
    } catch (error: unknown) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      return { ok: false, message: timeout ? `${spec.service} не ответил за 5 секунд — ключ не проверен` : `${spec.service} недоступен с сервера — ключ не проверен` };
    }
  };
}

/** Пинг CoinGecko: у демо и платного ключа свой адрес и свой заголовок. */
function coingeckoCheck(plan: "demo" | "pro") {
  return keyCheck({
    service: "CoinGecko",
    url: () => `${plan === "pro" ? "https://pro-api.coingecko.com" : "https://api.coingecko.com"}/api/v3/ping`,
    headers: (value) => ({ [`x-cg-${plan}-api-key`]: value }),
    refusalHint: `проверьте, что ключ ${plan === "pro" ? "платный" : "демо"} и скопирован целиком`,
  });
}

const FX_SERVICE = "Курсы валют · CoinGecko";
const CMC_SERVICE = "Курсы валют · CoinMarketCap";
const TONAPI_SERVICE = "Курсы валют · tonapi";
const ERAPI_SERVICE = "Курсы валют · ExchangeRate-API";
const FOREXRATEAPI_SERVICE = "Курсы валют · ForexRateAPI";
const ADSGRAM_SERVICE = "Трекинг закупок · AdsGram";
const ADSGRAM_TASKS_SERVICE = "Задания сетей · AdsGram";

/**
 * Адрес награды за задание AdsGram (docs/35-stage4-plan.md WP13, часть 6):
 * AdsGram зовёт его, когда игрок выполнил задание, и подставляет вместо
 * `[userId]` его id в Telegram. Подписи у запроса нет — подделку отличает
 * только секрет в пути. Путь — тот же, что у ручки
 * `ads/adsgram-reward.controller.ts`; их совпадение проверяет HTTP-тест.
 */
export const ADSGRAM_REWARD_PATH = "/api/v1/ads/adsgram/reward";

/** Секрет адреса — 32 случайных байта в base64url: подобрать его перебором нельзя. */
export const GENERATED_SECRET_BYTES = 32;

const VK_SERVICE = "VK";

/**
 * Сообщество VK как бот (docs/35-stage4-plan.md Р188, tasks/T-0378). Адрес
 * методов и версия API — одни на клиент сообщества (`platforms/vk/vk-api.ts`) и
 * на проверку ключа из панели; путь вебхука — тот же, что у контроллера
 * `platforms/vk/vk-callback.controller.ts`, их совпадение проверяет HTTP-тест.
 */
export const VK_API_URL = "https://api.vk.com/method";
export const VK_API_VERSION = "5.199";
export const VK_CALLBACK_PATH = "/api/v1/vk/callback";

/** Секрет Callback API — латиница и цифры: другие знаки VK в поле «Секретный ключ» не принимает. */
const VK_SECRET_LENGTH = 40;
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** Наибольшее кратное 62 в диапазоне байта: остальные значения отбрасываются, чтобы знаки выпадали поровну. */
const ALPHANUMERIC_LIMIT = 248;

/** Случайная строка из латиницы и цифр без перекоса по знакам. */
export function alphanumericSecret(length: number): string {
  let value = "";
  while (value.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= ALPHANUMERIC_LIMIT) continue;
      value += ALPHANUMERIC.charAt(byte % ALPHANUMERIC.length);
      if (value.length === length) break;
    }
  }
  return value;
}

/** Проверка ключа сообщества: `groups.getById` без сообщества отвечает о том, чей ключ, и расходов не имеет. */
async function vkCommunityTokenCheck(value: string, fetchImpl: typeof fetch): Promise<SecretCheckResult> {
  try {
    // Ключ — в теле, а не в адресе: адрес попадает в журналы по дороге.
    const response = await fetchImpl(`${VK_API_URL}/groups.getById`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ v: VK_API_VERSION, access_token: value }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, message: `VK ответил ${String(response.status)} — ключ не проверен` };
    // VK отвечает 200 и на отказ: ошибка лежит в теле.
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const error = (body as { error: unknown }).error;
      const code = typeof error === "object" && error !== null && "error_code" in error ? Number((error as { error_code: unknown }).error_code) : null;
      if (code === 6 || code === 9 || code === 29) return { ok: false, message: "VK ответил «слишком много запросов» — ключ не проверен, попробуйте через минуту" };
      return {
        ok: false,
        message: `VK не принял ключ${code === null ? "" : ` (код ${String(code)})`}: проверьте, что это ключ доступа сообщества с правами на сообщения и управление, скопированный целиком`,
      };
    }
    if (typeof body === "object" && body !== null && "response" in body) return { ok: true, message: "VK принял ключ" };
    return { ok: false, message: "VK ответил непонятно — ключ не проверен" };
  } catch (error: unknown) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, message: timeout ? "VK не ответил за 5 секунд — ключ не проверен" : "VK недоступен с сервера — ключ не проверен" };
  }
}

export const SECRETS = {
  coingeckoPro: {
    key: "fx.coingecko-pro",
    service: FX_SERVICE,
    title: "Платный ключ CoinGecko",
    hint: "Курсы TON и USDT с платного тарифа: свой адрес и большие лимиты. Задан — важнее демо-ключа.",
    cabinetUrl: "https://www.coingecko.com/en/developers/dashboard",
    pattern: /^CG-[A-Za-z0-9]{8,64}$/,
    example: "CG-AbCdEfGh1234567890",
    fromEnv: (config) => nonEmpty(config.fx.coingeckoProKey),
    check: coingeckoCheck("pro"),
  },
  coingeckoDemo: {
    key: "fx.coingecko-demo",
    service: FX_SERVICE,
    title: "Демо-ключ CoinGecko",
    hint: "Бесплатный ключ — 10 000 запросов в месяц. Без ключей курсы идут общим лимитом по адресу сервера.",
    cabinetUrl: "https://www.coingecko.com/en/developers/dashboard",
    pattern: /^CG-[A-Za-z0-9]{8,64}$/,
    example: "CG-AbCdEfGh1234567890",
    fromEnv: (config) => nonEmpty(config.fx.coingeckoDemoKey),
    check: coingeckoCheck("demo"),
  },
  coinmarketcap: {
    key: "fx.coinmarketcap",
    service: CMC_SERVICE,
    title: "Ключ CoinMarketCap",
    hint: "Четвёртый источник курса Gram и USDT, тариф Basic — 10 000 кредитов в месяц. Без ключа источника нет",
    cabinetUrl: "https://pro.coinmarketcap.com/account",
    // Ключ CoinMarketCap — UUID.
    pattern: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    example: "12345678-aaaa-4bbb-8ccc-123456789abc",
    // Только из панели: ключ перевыпускают в кабинете, окружение не нужно.
    fromEnv: () => null,
    // `/v1/key/info` кредитов не тратит.
    check: keyCheck({
      service: "CoinMarketCap",
      url: () => "https://pro-api.coinmarketcap.com/v1/key/info",
      headers: (value) => ({ "X-CMC_PRO_API_KEY": value }),
      refusalHint: "проверьте, что ключ скопирован целиком из кабинета CoinMarketCap",
    }),
  },
  tonapi: {
    key: "fx.tonapi",
    service: TONAPI_SERVICE,
    title: "Ключ tonapi",
    hint: "Необязателен: без ключа курс Gram идёт открытым лимитом",
    cabinetUrl: "https://tonconsole.com",
    // Ключ tonapi из TON Console — длинная строка из латиницы, цифр, точек и дефисов (бывает JWT).
    pattern: /^[A-Za-z0-9._-]{16,512}$/,
    example: "AFABCDEFGHIJKLMNOPQRSTUV",
    fromEnv: () => null,
    // Отдельного запроса «проверить ключ» у сервиса нет — спрашиваем курс.
    check: keyCheck({
      service: "tonapi",
      url: () => "https://tonapi.io/v2/rates?tokens=ton&currencies=usd",
      headers: (value) => ({ Authorization: `Bearer ${value}` }),
      refusalHint: "проверьте, что ключ скопирован целиком из TON Console",
    }),
  },
  erapi: {
    key: "fx.erapi",
    service: ERAPI_SERVICE,
    title: "Ключ ExchangeRate-API",
    hint: "Необязателен: без ключа курсы рубля и евро идут открытым адресом",
    cabinetUrl: "https://app.exchangerate-api.com",
    // Ключ ExchangeRate-API — 24 шестнадцатеричных знака. Он уходит в путь адреса, а журнал
    // исходящих прячет сегмент только от 24 знаков (`outbound-path.ts`): шаблон не должен пускать
    // ключ короче, иначе он ляжет в журнал открытым текстом. Сторож — тест в `secrets.test.ts`.
    pattern: /^[0-9a-fA-F]{24}$/,
    example: "0123456789abcdef01234567",
    fromEnv: () => null,
    // `/quota` запросы тарифа не расходует.
    check: keyCheck({
      service: "ExchangeRate-API",
      url: (value) => `https://v6.exchangerate-api.com/v6/${encodeURIComponent(value)}/quota`,
      headers: () => ({}),
      refusalHint: "проверьте, что ключ скопирован целиком из кабинета ExchangeRate-API",
    }),
  },
  forexrateapi: {
    key: "fx.forexrateapi",
    service: FOREXRATEAPI_SERVICE,
    title: "Ключ ForexRateAPI",
    hint: "Ещё один голос курсов рубля и евро. Без ключа источник выключен",
    cabinetUrl: "https://forexrateapi.com/dashboard",
    // Формат ключа в документации не описан: шаблон отсекает мусор и знаки, которым не место в заголовке.
    pattern: /^[A-Za-z0-9_-]{16,128}$/,
    example: "0123456789abcdef0123456789abcdef",
    fromEnv: () => null,
    // `/v1/usage` квоту тарифа не расходует.
    check: keyCheck({
      service: "ForexRateAPI",
      url: () => "https://api.forexrateapi.com/v1/usage",
      headers: (value) => ({ "X-API-KEY": value }),
      refusalHint: "проверьте, что ключ скопирован целиком из кабинета ForexRateAPI",
    }),
  },
  adsgramConversionToken: {
    key: "adsgram.conversion-token",
    service: ADSGRAM_SERVICE,
    title: "Токен конверсий AdsGram",
    hint: "Регистрации и покупки игроков, пришедших по ссылкам AdsGram из раздела «Ссылки», уходят в наш кабинет этим токеном — по ним AdsGram учится приводить тех, кто играет и платит. Нет токена — конверсии копятся и уйдут, когда его зададут.",
    cabinetUrl: "https://adsgram.ai",
    // Токен уходит в адрес запроса — только знаки, которые не нужно кодировать.
    pattern: /^[A-Za-z0-9._~-]{8,256}$/,
    example: "a1b2c3d4e5f6a7b8c9d0",
    // Только из панели: токен перевыпускают в кабинете, и заменять его
    // должен человек, а не выкат с новым `.env`.
    fromEnv: () => null,
  },
  adsgramRewardSecret: {
    key: "adsgram.reward-secret",
    service: ADSGRAM_TASKS_SERVICE,
    title: "Адрес награды за задание AdsGram",
    hint: "AdsGram зовёт этот адрес, когда игрок выполнил задание сети во вкладке «Партнёры», — и только тогда сервер даёт награду. Секрет в адресе отличает AdsGram от подделки. Пока адреса нет, заданий AdsGram у игроков нет: награду за них дать было бы нечем.",
    cabinetUrl: "https://partner.adsgram.ai",
    pattern: /^[A-Za-z0-9_-]{32,128}$/,
    example: "aBcD3fGh1jKlMn0pQrStUvWxYz_-aBcD3fGh1jKlMnO",
    // Только из панели: адрес вставляют в кабинет AdsGram, и создаёт его
    // человек, который тут же его туда и вставит.
    fromEnv: () => null,
    generated: {
      reveal: (value, config) => `${config.telegram.publicApiUrl}${ADSGRAM_REWARD_PATH}/${value}/[userId]`,
      where: "кабинет AdsGram → блок формата Task → поле Reward URL",
    },
  },
  vkCommunityToken: {
    key: "vk.community-token",
    service: VK_SERVICE,
    title: "Ключ доступа сообщества VK",
    hint: "Сообщество отвечает игрокам и проверяет вступление этим ключом. Права: сообщения сообщества, управление. Без ключа задания «вступите в сообщество» никому не видны.",
    cabinetUrl: "https://vk.com/groups?tab=admin",
    // Ключ сообщества — длинная строка печатных знаков (`vk1.a.…`); формат VK не описывает, шаблон отсекает мусор.
    pattern: /^[\x21-\x7e]{32,512}$/,
    example: "vk1.a.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    // Только из панели: ключ перевыпускают в кабинете, и заменять его должен человек.
    fromEnv: () => null,
    check: vkCommunityTokenCheck,
  },
  vkCallbackSecret: {
    key: "vk.callback-secret",
    service: VK_SERVICE,
    title: "Секрет Callback API VK",
    hint: "VK присылает его в каждом событии сообщества, и только с ним сервер принимает сообщения игроков. Создаёт сервер: адрес и секрет показываются один раз — вставьте их в настройки сообщества. Нет секрета — бот сообщества молчит.",
    cabinetUrl: "https://vk.com/groups?tab=admin",
    pattern: /^[A-Za-z0-9]{32,64}$/,
    example: "aBcD3fGh1jKlMn0pQrStUvWxYz0123456789",
    fromEnv: () => null,
    generated: {
      reveal: (value, config) => `${config.telegram.publicApiUrl}${VK_CALLBACK_PATH} — секретный ключ: ${value}`,
      where: "управление сообществом → Работа с API → Callback API: адрес и секретный ключ",
      generate: () => alphanumericSecret(VK_SECRET_LENGTH),
    },
  },
  vkCallbackConfirmation: {
    key: "vk.callback-confirmation",
    service: VK_SERVICE,
    title: "Строка подтверждения Callback API VK",
    hint: "VK показывает её в настройках Callback API («Строка, которую должен вернуть сервер») и просит вернуть при подключении адреса. Без неё VK не подтвердит сервер.",
    cabinetUrl: "https://vk.com/groups?tab=admin",
    pattern: /^[\x21-\x7e]{1,32}$/,
    example: "a1b2c3d4",
    fromEnv: () => null,
  },
} as const satisfies Record<string, SecretDefinition>;

export const SECRET_LIST: readonly SecretDefinition[] = Object.values(SECRETS);

export function secretByKey(key: string): SecretDefinition | undefined {
  return SECRET_LIST.find((secret) => secret.key === key);
}

/** Что не так с ключом; `null` — можно сохранять. Панель проверяет то же самое. */
export function secretProblem(secret: SecretDefinition, value: string): string | null {
  if (!SECRET_TEXT.test(value)) return "Ключ — без пробелов и переносов строки, до 512 знаков";
  if (!secret.pattern.test(value)) return `${secret.title} выглядит как «${secret.example}»`;
  return null;
}

/** Последние знаки — чтобы сверить с кабинетом сервиса, не раскрывая ключ. */
export function fingerprintOf(value: string): string {
  return value.length <= 8 ? "••••" : `••••${value.slice(-4)}`;
}
