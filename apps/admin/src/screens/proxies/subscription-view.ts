import { countriesOf, type SubscriptionDevice, type SubscriptionInfo, type SubscriptionNode, type SubscriptionOverview, type SubscriptionRouting } from "../../api/proxy-subscription";
import { formatTime, plural } from "../../format";

/**
 * Чистые функции блока «Подписки Xray» (docs/35-stage4-plan.md Р101, Р192):
 * проверка адреса до отправки, строки трафика, устройства, маршрутизации и итога
 * обновления, транспорт и безопасность узла словами, сводка по узлам и входам,
 * порядок узлов. Вынесены из компонентов ради теста; сервер проверит то же самое
 * ещё раз.
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

/** Транспорт узла так, как его называет Xray: `tcp` с версии 24 — «RAW». */
const TRANSPORTS: ReadonlyMap<string, string> = new Map([
  ["tcp", "RAW"],
  ["ws", "WebSocket"],
  ["grpc", "gRPC"],
  ["httpupgrade", "HTTPUpgrade"],
  ["xhttp", "XHTTP"],
]);

/** Транспорт словами; нет сведений — прочерк, незнакомое значение — как есть. */
export function transportLabel(network: string | null): string {
  if (network === null) return "—";
  return TRANSPORTS.get(network) ?? network;
}

/**
 * Безопасность словами: «TLS», «REALITY», для `none` — по протоколу. VLESS и
 * Trojan без TLS и REALITY идут открытым текстом — «без шифрования». VMess и
 * Shadowsocks шифруют сами, и такая надпись была бы неправдой — «шифр протокола».
 * Протокол незнакомый — значение как есть. Флаг `flow` дописывается: Vision коротко,
 * другой — как есть. Нет сведений о безопасности — прочерк.
 */
export function securityLabel(protocol: string, security: string | null, flow: string | null): string {
  if (security === null) return "—";
  let base: string;
  if (security === "tls") base = "TLS";
  else if (security === "reality") base = "REALITY";
  else if (security === "none" && (protocol === "vless" || protocol === "trojan")) base = "без шифрования";
  else if (security === "none" && (protocol === "vmess" || protocol === "shadowsocks")) base = "шифр протокола";
  else base = security;
  if (flow === null || flow === "") return base;
  return `${base} · ${flow === "xtls-rprx-vision" ? "Vision" : flow}`;
}

/** «Занимает 1 устройство у поставщика · отпечаток 3f9a2c1b… · Linux, v2rayN/7.0». */
export function deviceLine(device: SubscriptionDevice): string {
  const head = `Занимает ${String(device.count)} ${plural(device.count, ["устройство", "устройства", "устройств"])} у поставщика`;
  if (device.hwidPrefix === null) return `${head} · отпечаток появится, когда на сервере будет ключ шифрования`;
  return `${head} · отпечаток ${device.hwidPrefix}… · ${device.os}, ${device.userAgent}`;
}

const ROUTING_SOURCES: Record<SubscriptionRouting["source"], string> = {
  none: "",
  json: "в JSON-конфиге",
  header: "в заголовке поставщика",
  "json+header": "в JSON-конфиге и заголовке поставщика",
};

/**
 * Своя маршрутизация подписки — только для сведения. Записи мимо туннеля и
 * блокировки считаются числом, подсказки — имена списков `geosite:`/`geoip:`;
 * нулевая часть опускается. Заголовок, который не разобрался, — «состав не разобран».
 */
export function routingLine(routing: SubscriptionRouting | null): string {
  if (routing === null) return "Своя маршрутизация: станет известно после обновления подписки";
  if (routing.source === "none") return "Своя маршрутизация: нет";
  const head = `Своя маршрутизация: есть (${ROUTING_SOURCES[routing.source]})`;
  const tail = "Наш перебор её не применяет";
  if (routing.direct === null && routing.block === null) return `${head}, состав не разобран. ${tail}`;

  const parts: string[] = [];
  const direct = routing.direct ?? 0;
  const block = routing.block ?? 0;
  if (direct > 0) parts.push(`мимо туннеля ${String(direct)}${routing.hints.length === 0 ? "" : `, например ${routing.hints.join(", ")}`}`);
  if (block > 0) parts.push(`блокируется ${String(block)}`);
  return parts.length === 0 ? `${head}. ${tail}` : `${head} — ${parts.join("; ")}. ${tail}`;
}

/** Итог последнего обновления: неудачный — красным, текст сервера как есть. */
export function refreshLine(subscription: Pick<SubscriptionInfo, "lastRefreshAt" | "lastRefreshOk" | "lastRefreshNote">): { tone: "neutral" | "danger"; text: string } {
  if (subscription.lastRefreshAt === null) return { tone: "neutral", text: "Ещё не обновлялась — сервер обновит подписку в течение минуты" };
  if (subscription.lastRefreshOk === false) return { tone: "danger", text: subscription.lastRefreshNote ?? "Обновление не удалось" };
  const when = `Обновлена ${formatTime(subscription.lastRefreshAt)}`;
  return { tone: "neutral", text: subscription.lastRefreshNote === null ? when : `${when} — ${subscription.lastRefreshNote}` };
}

/** «37 узлов: работают 30, не отвечают 5, не проверены 2»; состояния без узлов не называются. */
export function nodesSummary(nodes: readonly Pick<SubscriptionNode, "state">[]): string {
  if (nodes.length === 0) return "Узлов пока нет";
  const groups = [
    { state: "healthy", forms: ["работает", "работают", "работают"] },
    { state: "down", forms: ["не отвечает", "не отвечают", "не отвечают"] },
    { state: "unknown", forms: ["не проверен", "не проверены", "не проверены"] },
  ] as const;
  const parts = groups.flatMap(({ state, forms }) => {
    const count = nodes.filter((node) => node.state === state).length;
    return count === 0 ? [] : [`${plural(count, forms)} ${String(count)}`];
  });
  return `${String(nodes.length)} ${plural(nodes.length, ["узел", "узла", "узлов"])}: ${parts.join(", ")}`;
}

/** «Входов Xray: 100, на подписку — 50»: входы делятся между подписками поровну. */
export function slotLine(overview: Pick<SubscriptionOverview, "slotCount" | "slotQuota">): string {
  return `Входов Xray: ${String(overview.slotCount)}, на подписку — ${String(overview.slotQuota)}`;
}

/** Кнопка таблицы узлов: «Показать узлы (37)» / «Скрыть узлы». */
export function nodesToggleLabel(count: number, open: boolean): string {
  return open ? "Скрыть узлы" : `Показать узлы (${String(count)})`;
}

/** Подписку можно добавить, пока их меньше предела сервера. */
export function canAddSubscription(overview: Pick<SubscriptionOverview, "limit" | "subscriptions">): boolean {
  return overview.subscriptions.length < overview.limit;
}

/** Почему добавить больше нельзя; `null` — можно. */
export function limitLine(overview: Pick<SubscriptionOverview, "limit" | "subscriptions">): string | null {
  return canAddSubscription(overview) ? null : `Подписок ${String(overview.limit)} — больше добавить нельзя: удалите лишнюю`;
}

export interface NodeRow {
  nodeKey: string;
  name: string;
  protocol: string;
  transportText: string;
  securityText: string;
  host: string;
  country: string | null;
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
      transportText: transportLabel(node.network),
      securityText: securityLabel(node.protocol, node.security, node.flow),
      host: node.host,
      country: node.country,
      statusLabel: STATE_VIEW[node.state].label,
      tone: STATE_VIEW[node.state].tone,
      latencyText: node.state === "healthy" && node.latencyMs !== null ? `${String(node.latencyMs)} мс` : "—",
    }));
}
