import { countriesOf, type SubscriptionInfo, type SubscriptionNode } from "../../api/proxy-subscription";
import { formatTime } from "../../format";

/**
 * Чистые функции блока «Подписка Xray» (docs/35-stage4-plan.md Р101): проверка
 * адреса до отправки, строки трафика и итога обновления, порядок узлов. Вынесены
 * из компонентов ради теста; сервер проверит то же самое ещё раз.
 */

const URL_PROBLEMS = {
  malformed: "Не похоже на адрес подписки: скопируйте ссылку целиком",
  crypt: "Зашифрованная ссылка Happ не подойдёт: нужен исходный адрес подписки https://",
  scheme: "Нужен адрес https:// — http и другие схемы не подходят",
  credentials: "Уберите логин и пароль из адреса: подписке они не нужны",
  host: "Это адрес локальной сети — нужен адрес поставщика в интернете",
} as const;
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan"];
const COUNTRIES_MAX = 10;
const GB = 1024 ** 3;

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return false;
  const [a = 0, b = 0] = [Number(match[1]), Number(match[2])];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Адрес так, как его отправим: без пробелов по краям, без обёртки Happ
 * `happ://add/` и со схемой `https://`, если её не вставили — поставщики
 * часто дают ссылку без схемы, а «логин и пароль» в тексте ошибки сбивали.
 */
export function normalizeSubscriptionUrl(raw: string): string {
  const text = raw.trim().replace(/^happ:\/\/add\//i, "");
  if (text === "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return `https://${text}`;
}

/**
 * Что не так с адресом подписки; `null` — годится. `keep` — правка: пустое поле
 * оставляет прежний адрес. Закрытые адреса отсекаются очевидные, окончательно
 * решает сервер (он ещё и спрашивает DNS).
 */
export function subscriptionUrlProblem(raw: string, options: { keep?: boolean } = {}): string | null {
  const text = normalizeSubscriptionUrl(raw);
  if (text === "") return options.keep === true ? null : "Укажите адрес подписки";
  if (/^happ:\/\/crypt/i.test(text)) return URL_PROBLEMS.crypt;
  if (!URL.canParse(text)) return URL_PROBLEMS.malformed;
  const url = new URL(text);
  if (url.protocol !== "https:") return URL_PROBLEMS.scheme;
  if (url.username !== "" || url.password !== "") return URL_PROBLEMS.credentials;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix)) || isPrivateIpv4(host)) return URL_PROBLEMS.host;
  // Одна метка без точки — имя сервиса в сети контейнеров (`redis`), не поставщик подписки.
  if (!host.startsWith("[") && !host.includes(".")) return URL_PROBLEMS.host;
  return null;
}

/** Что не так со странами; `null` — годится. Пусто — любые. */
export function countriesProblem(text: string): string | null {
  const codes = countriesOf(text);
  if (codes.some((code) => !/^[A-Z]{2}$/.test(code))) return "Страны — коды из двух латинских букв через запятую, например DE, NL";
  if (codes.length > COUNTRIES_MAX) return "Стран — не больше десяти";
  return null;
}

function gigabytes(bytes: number): string {
  const value = Math.round((bytes / GB) * 10) / 10;
  return value.toLocaleString("ru-RU");
}

/** «01.12.2026» по UTC: срок поставщика не зависит от часового пояса того, кто смотрит. */
function dateOf(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${String(date.getUTCFullYear())}`;
}

/** Трафик и срок словами; поставщик ничего не сообщил — `null`. */
export function trafficLine(subscription: Pick<SubscriptionInfo, "trafficUsedBytes" | "trafficTotalBytes" | "expiresAt">): string | null {
  const total = subscription.trafficTotalBytes;
  const until = subscription.expiresAt === null ? null : dateOf(subscription.expiresAt);
  if (total === null) return until === null ? null : `Подписка действует до ${until}`;
  const left = Math.max(0, total - (subscription.trafficUsedBytes ?? 0));
  const traffic = `Осталось ${gigabytes(left)} ГБ из ${gigabytes(total)} ГБ`;
  return until === null ? traffic : `${traffic} · до ${until}`;
}

/** Итог последнего обновления: неудачный — красным, текст сервера как есть. */
export function refreshLine(subscription: Pick<SubscriptionInfo, "lastRefreshAt" | "lastRefreshOk" | "lastRefreshNote">): { tone: "neutral" | "danger"; text: string } {
  if (subscription.lastRefreshAt === null) return { tone: "neutral", text: "Ещё не обновлялась — сервер обновит подписку в течение минуты" };
  if (subscription.lastRefreshOk === false) return { tone: "danger", text: subscription.lastRefreshNote ?? "Обновление не удалось" };
  const when = `Обновлена ${formatTime(subscription.lastRefreshAt)}`;
  return { tone: "neutral", text: subscription.lastRefreshNote === null ? when : `${when} — ${subscription.lastRefreshNote}` };
}

export interface NodeRow {
  nodeKey: string;
  name: string;
  protocol: string;
  host: string;
  countryText: string;
  statusLabel: string;
  tone: "success" | "neutral" | "danger";
  latencyText: string;
}

const STATE_VIEW = {
  healthy: { rank: 0, label: "Работает", tone: "success" },
  unknown: { rank: 1, label: "Не проверен", tone: "neutral" },
  down: { rank: 2, label: "Не отвечает", tone: "danger" },
} as const;

/** Рабочие сверху, быстрые первыми; затем не проверенные, затем не отвечающие. */
export function nodeRows(nodes: readonly SubscriptionNode[]): NodeRow[] {
  return [...nodes]
    .sort((a, b) => STATE_VIEW[a.state].rank - STATE_VIEW[b.state].rank || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity) || a.name.localeCompare(b.name, "ru"))
    .map((node) => ({
      nodeKey: node.nodeKey,
      name: node.name,
      protocol: node.protocol,
      host: node.host,
      countryText: node.country ?? "—",
      statusLabel: STATE_VIEW[node.state].label,
      tone: STATE_VIEW[node.state].tone,
      latencyText: node.state === "healthy" && node.latencyMs !== null ? `${String(node.latencyMs)} мс` : "—",
    }));
}
