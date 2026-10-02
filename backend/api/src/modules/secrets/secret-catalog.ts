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
}

export const SECRET_KEY = /^[a-z][a-z0-9.-]{1,63}$/;

/** Любой ключ — без пробелов и служебных знаков: перенос строки из буфера обмена — частая опечатка. */
export const SECRET_TEXT = /^[\x21-\x7e]{1,512}$/;

const CHECK_TIMEOUT_MS = 5_000;

const nonEmpty = (value: string): string | null => (value === "" ? null : value);

/** Пинг CoinGecko: у демо и платного ключа свой адрес и свой заголовок. */
function coingeckoCheck(plan: "demo" | "pro") {
  return async (value: string, fetchImpl: typeof fetch): Promise<SecretCheckResult> => {
    const host = plan === "pro" ? "https://pro-api.coingecko.com" : "https://api.coingecko.com";
    try {
      const response = await fetchImpl(`${host}/api/v3/ping`, {
        headers: { [`x-cg-${plan}-api-key`]: value, accept: "application/json" },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (response.ok) return { ok: true, message: "CoinGecko принял ключ" };
      if (response.status === 401 || response.status === 403 || response.status === 400) {
        return { ok: false, message: `CoinGecko не принял ключ (${String(response.status)}): проверьте, что ключ ${plan === "pro" ? "платный" : "демо"} и скопирован целиком` };
      }
      if (response.status === 429) return { ok: false, message: "CoinGecko ответил «слишком много запросов» — ключ не проверен, попробуйте через минуту" };
      return { ok: false, message: `CoinGecko ответил ${String(response.status)} — ключ не проверен` };
    } catch (error: unknown) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      return { ok: false, message: timeout ? "CoinGecko не ответил за 5 секунд — ключ не проверен" : "CoinGecko недоступен с сервера — ключ не проверен" };
    }
  };
}

const FX_SERVICE = "Курсы валют · CoinGecko";

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
