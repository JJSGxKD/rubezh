import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Прокси для исходящих запросов (`/admin/proxies`, docs/35-stage4-plan.md Р91,
 * tasks/T-0065): список, проверка и режимы сервисов клиента исходящих.
 * Пароль сервер не отдаёт никогда — только «задан» и «не читается»; панель
 * шлёт его лишь тогда, когда его ввели.
 */

export const PROXY_SCHEMES = ["http", "https", "socks5"] as const;
export type ProxyScheme = (typeof PROXY_SCHEMES)[number];

export const PROXY_MODES = ["direct_first", "proxy_only", "direct_only"] as const;
export type ProxyMode = (typeof PROXY_MODES)[number];

export const proxySchema = z.object({
  proxyId: z.string(),
  name: z.string(),
  scheme: z.enum(PROXY_SCHEMES),
  host: z.string(),
  port: z.number(),
  username: z.string().nullable(),
  passwordSet: z.boolean(),
  /** пароль зашифрован другим ключом: прокси не работает, пока пароль не задан заново */
  passwordUnreadable: z.boolean(),
  country: z.string(),
  enabled: z.boolean(),
  priority: z.number(),
  note: z.string().nullable(),
  lastCheck: z.object({ at: z.string(), ok: z.boolean(), note: z.string().nullable() }).nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});

export type ProxyRow = z.infer<typeof proxySchema>;

const listSchema = z.object({ enabled: z.boolean(), proxies: z.array(proxySchema) });
export type ProxiesOverview = z.infer<typeof listSchema>;

const modeSchema = z.object({
  service: z.string(),
  mode: z.enum(PROXY_MODES),
  default: z.enum(PROXY_MODES),
  /** режим задан в панели, а не взят по умолчанию */
  custom: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type ModeRow = z.infer<typeof modeSchema>;

const modesSchema = z.object({ modes: z.array(modeSchema) });
export type ModesOverview = z.infer<typeof modesSchema>;

const checkSchema = z.object({ ok: z.boolean(), message: z.string(), proxy: proxySchema });
export type ProxyCheck = z.infer<typeof checkSchema>;

/** Форма прокси как её вводит человек: числа и пустые поля — строками. */
export interface ProxyForm {
  name: string;
  scheme: ProxyScheme;
  host: string;
  port: string;
  username: string;
  password: string;
  country: string;
  enabled: boolean;
  note: string;
  /** порядок перебора; пусто — новый прокси встанет в конец, правка оставит прежний */
  priority?: string;
  /** «Удалить пароль» — только явно; пустое поле пароля значит «не менять» */
  clearPassword?: boolean;
}

/** Пределы те же, что на сервере (`modules/proxies/proxies-rules.ts`): он проверит ещё раз. */
const LIMITS = { name: 60, host: 255, username: 128, password: 256, note: 200, priority: 10_000 } as const;
const HOST_LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;

export function fetchProxies(api: AdminApi): Promise<ApiResult<ProxiesOverview>> {
  return api.request("/proxies", { schema: listSchema });
}

/** Тело записи: строки обрезаны, страна заглавными, порт числом; пустые логин и заметка — `null`, пустого пароля нет. */
function bodyOf(form: ProxyForm): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    scheme: form.scheme,
    host: form.host.trim(),
    port: Number(form.port.trim()),
    username: form.username.trim() === "" ? null : form.username.trim(),
    country: form.country.trim().toUpperCase(),
    enabled: form.enabled,
    note: form.note.trim() === "" ? null : form.note.trim(),
  };
  if (form.priority !== undefined && form.priority.trim() !== "") body.priority = Number(form.priority.trim());
  if (form.clearPassword === true) body.clearPassword = true;
  else if (form.password !== "") body.password = form.password;
  return body;
}

export function createProxy(api: AdminApi, form: ProxyForm): Promise<ApiResult<ProxyRow>> {
  return api.request("/proxies", { method: "POST", body: bodyOf(form), schema: proxySchema });
}

export function updateProxy(api: AdminApi, proxyId: string, form: ProxyForm): Promise<ApiResult<ProxyRow>> {
  return api.request(`/proxies/${encodeURIComponent(proxyId)}`, { method: "PATCH", body: bodyOf(form), schema: proxySchema });
}

/** Запрос на ipify через этот прокси: ответ несёт итог словами и обновлённую строку. */
export function checkProxy(api: AdminApi, proxyId: string): Promise<ApiResult<ProxyCheck>> {
  return api.request(`/proxies/${encodeURIComponent(proxyId)}/check`, { method: "POST", schema: checkSchema, timeoutMs: 20_000 });
}

export function fetchModes(api: AdminApi): Promise<ApiResult<ModesOverview>> {
  return api.request("/proxies/modes", { schema: modesSchema });
}

export function setServiceMode(api: AdminApi, service: string, mode: ProxyMode): Promise<ApiResult<ModeRow>> {
  return api.request(`/proxies/modes/${encodeURIComponent(service)}`, { method: "PUT", body: { mode }, schema: modeSchema });
}

const MODE_LABELS: Record<ProxyMode, string> = {
  direct_first: "Сначала напрямую",
  proxy_only: "Только через прокси",
  direct_only: "Только напрямую",
};

export const modeLabel = (mode: ProxyMode): string => MODE_LABELS[mode];

/** Что делает режим — строкой под выбором. */
export const MODE_NOTES: Record<ProxyMode, string> = {
  direct_first: "Прокси — только если прямой запрос не прошёл",
  proxy_only: "Прямого запроса нет вовсе",
  direct_only: "Прокси сервис не видят",
};

/** Названия сервисов клиента исходящих — по-русски; незнакомый показывается как есть. */
const SERVICE_TITLES: Record<string, string> = {
  "fx.cbr": "Курсы: Банк России",
  "fx.ecb": "Курсы: ЕЦБ",
  "fx.erapi": "Курсы: ExchangeRate API",
  "fx.forexrateapi": "Курсы: ForexRateAPI",
  "fx.coingecko": "Курсы: CoinGecko",
  "fx.coinmarketcap": "Курсы: CoinMarketCap",
  "fx.tonapi": "Курсы: TON API",
  "fx.binance": "Курсы: Binance",
  "telegram.bot": "Bot API Telegram",
  "taddy.api": "Taddy: реклама",
  "taddy.exchange": "Taddy: лента заданий",
  "ads.creatives": "Креативы рекламных сетей",
  "ads.postback": "Постбэки в кабинеты сетей",
  "secrets.check": "Проверка ключей из панели",
};

export const serviceTitle = (service: string): string => SERVICE_TITLES[service] ?? service;

/** Состояние прокси словами — для значка и строки под ним. */
export function checkSummary(row: Pick<ProxyRow, "lastCheck" | "passwordUnreadable">): { tone: "success" | "danger" | "neutral"; label: string; detail: string } {
  if (row.passwordUnreadable) {
    return { tone: "danger", label: "Пароль не читается", detail: "Пароль зашифрован другим ключом шифрования — прокси не используется, пока пароль не задан заново." };
  }
  if (row.lastCheck === null) return { tone: "neutral", label: "Не проверялся", detail: "Нажмите «Проверить»: сервер сходит через прокси на ipify и покажет внешний адрес." };
  if (row.lastCheck.ok) return { tone: "success", label: "Работает", detail: row.lastCheck.note ?? "" };
  return { tone: "danger", label: "Не отвечает", detail: row.lastCheck.note ?? "Проверка не прошла" };
}

/** Адрес как его видит человек: схема, хост и порт; IPv6 в скобках. */
export function proxyAddress(row: Pick<ProxyRow, "scheme" | "host" | "port">): string {
  const host = row.host.includes(":") ? `[${row.host}]` : row.host;
  return `${row.scheme}://${host}:${String(row.port)}`;
}

/** Похоже на IPv6 без скобок. Строгую проверку делает сервер; здесь — отличить адрес от «имя:порт». */
function looksLikeIpv6(host: string): boolean {
  if (!/^[0-9A-Fa-f:]+$/.test(host) || !host.includes(":")) return false;
  const groups = host.split(":");
  if (groups.some((group) => group.length > 4)) return false;
  const compressed = host.includes("::");
  if (compressed) return host.split("::").length === 2 && groups.length <= 8;
  return groups.length === 8;
}

/** Что не так с адресом прокси; `null` — годится. Сервер проверит то же самое. */
export function proxyHostProblem(host: string): string | null {
  if (host === "") return "Укажите адрес прокси";
  if (host.length > LIMITS.host) return `Адрес — не длиннее ${String(LIMITS.host)} знаков`;
  if (host.includes("://")) return "Адрес — без схемы: схему выбирают отдельным полем";
  if (/\s/.test(host)) return "Адрес — без пробелов";
  if (host.includes("/")) return "Адрес — без пути";
  if (looksLikeIpv6(host)) return null;
  if (host.includes(":")) return "Адрес — без порта: порт — в отдельном поле";
  return host.split(".").every((label) => HOST_LABEL.test(label)) ? null : "Адрес — домен, имя сервиса в сети контейнеров или IP";
}

/**
 * Что не так с формой; `null` — можно отправлять. `existing` — правка: у прокси
 * уже есть пароль, и без логина он не останется.
 */
export function proxyProblem(form: ProxyForm, existing?: { passwordSet: boolean }): string | null {
  const name = form.name.trim();
  if (name === "") return "Укажите название";
  if (name.length > LIMITS.name) return `Название — не длиннее ${String(LIMITS.name)} знаков`;
  const host = proxyHostProblem(form.host.trim());
  if (host !== null) return host;
  const port = form.port.trim();
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) return "Порт — число от 1 до 65535";
  if (!/^[A-Za-z]{2}$/.test(form.country.trim())) return "Страна — две латинские буквы, например DE";
  const username = form.username.trim();
  if (username.length > LIMITS.username) return `Логин — не длиннее ${String(LIMITS.username)} знаков`;
  if (form.password.length > LIMITS.password) return `Пароль — не длиннее ${String(LIMITS.password)} знаков`;
  const keepsPassword = existing?.passwordSet === true && form.clearPassword !== true;
  if (username === "" && (form.password !== "" || keepsPassword)) return "Пароль задают вместе с логином — укажите логин или удалите пароль";
  const priority = form.priority?.trim() ?? "";
  if (priority !== "" && (!/^\d{1,5}$/.test(priority) || Number(priority) > LIMITS.priority)) return `Порядок — целое число от 0 до ${String(LIMITS.priority)}`;
  if (form.note.trim().length > LIMITS.note) return `Заметка — не длиннее ${String(LIMITS.note)} знаков`;
  return null;
}

/** Форма из строки прокси — для окна правки. Пароль пустой: прежний сервер оставит сам. */
export function formOf(row: ProxyRow): ProxyForm {
  return {
    name: row.name,
    scheme: row.scheme,
    host: row.host,
    port: String(row.port),
    username: row.username ?? "",
    password: "",
    country: row.country,
    enabled: row.enabled,
    note: row.note ?? "",
    priority: String(row.priority),
  };
}

export const EMPTY_FORM: ProxyForm = { name: "", scheme: "http", host: "", port: "", username: "", password: "", country: "", enabled: true, note: "" };
