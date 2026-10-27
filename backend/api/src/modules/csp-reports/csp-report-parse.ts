/**
 * Разбор тела отчёта браузера о заблокированном адресе (Р108,
 * docs/35-stage4-plan.md; tasks/T-0155).
 *
 * Тело приходит от кого угодно и без входа, поэтому из него берутся только
 * два значения — директива и имя хоста, — каждое из закрытого набора или
 * жёстко проверенной формы. Путь и параметры адреса, адрес страницы, источник
 * скрипта и всё прочее отбрасываются здесь, до хранилища и лога: в них бывают
 * чужие данные, в том числе данные запуска игрока.
 */

export interface CspHit {
  directive: string;
  host: string;
}

/** Метка для всего, что не удалось опознать: расширение браузера, битый адрес, чужая директива. */
const OTHER = "other";

/**
 * Директивы, о нарушении которых отчёт имеет смысл хранить. Список закрытый:
 * имя из тела, не попавшее сюда, стало бы ключом в Redis по слову постороннего.
 */
const KNOWN_DIRECTIVES: ReadonlySet<string> = new Set([
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "media-src",
  "font-src",
  "connect-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "object-src",
  "default-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
]);

/** Слова, которыми браузер называет блокировку не адреса, а способа: встроенный скрипт, eval, data: и blob:. */
const KEYWORD_SOURCES: ReadonlySet<string> = new Set(["inline", "eval", "data", "blob"]);

const NETWORK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);

/** Длиннее имя хоста в DNS не бывает. */
const MAX_HOST_LENGTH = 253;
const HOST_PATTERN = /^[a-z0-9.-]+$/;

/**
 * Записей `report-to` на запрос: браузер собирает в один пакет несколько
 * нарушений, но сотни в одном теле — уже не браузер.
 */
const MAX_REPORT_TO_ENTRIES = 20;

function directiveOf(value: unknown): string {
  if (typeof value !== "string") return OTHER;
  const name = value.trim().toLowerCase();
  return KNOWN_DIRECTIVES.has(name) ? name : OTHER;
}

function hostOf(value: unknown): string {
  if (typeof value !== "string") return OTHER;
  const text = value.trim().toLowerCase();
  if (KEYWORD_SOURCES.has(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return OTHER;
  }
  // `data:image/…` и `blob:https://…` — тоже слова, а не хосты: дальше схемы не идём.
  if (url.protocol === "data:" || url.protocol === "blob:") return url.protocol.slice(0, -1);
  if (!NETWORK_SCHEMES.has(url.protocol)) return OTHER;
  const host = url.hostname;
  if (host === "" || host.length > MAX_HOST_LENGTH || !HOST_PATTERN.test(host)) return OTHER;
  return host;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `violated-directive` — строка вида «script-src 'self' https://x»: директива в ней первое слово. */
function firstWord(value: unknown): unknown {
  return typeof value === "string" ? (value.trim().split(/\s+/)[0] ?? "") : value;
}

function fromReportUri(report: Record<string, unknown>): CspHit[] {
  const effective = report["effective-directive"];
  const violated = report["violated-directive"];
  const blocked = report["blocked-uri"];
  // Отчёт, в котором нет ни одного из трёх полей, ничего не сообщает.
  if (effective === undefined && violated === undefined && blocked === undefined) return [];
  const directive = typeof effective === "string" && effective.trim() !== "" ? effective : firstWord(violated);
  return [{ directive: directiveOf(directive), host: hostOf(blocked) }];
}

function fromReportTo(entries: readonly unknown[]): CspHit[] {
  const hits: CspHit[] = [];
  for (const entry of entries) {
    if (hits.length >= MAX_REPORT_TO_ENTRIES) break;
    if (!isRecord(entry) || entry.type !== "csp-violation" || !isRecord(entry.body)) continue;
    hits.push({ directive: directiveOf(entry.body.effectiveDirective), host: hostOf(entry.body.blockedURL) });
  }
  return hits;
}

/**
 * Попадания из тела отчёта обоих форматов: `report-uri`
 * (`{ "csp-report": {…} }`) и `report-to` (массив записей). Непонятное тело —
 * пустой список, не исключение: отчёт браузера никто не повторяет и никому не
 * отвечает подробностями.
 */
export function parseCspReports(body: unknown): CspHit[] {
  if (Array.isArray(body)) return fromReportTo(body);
  if (isRecord(body) && isRecord(body["csp-report"])) return fromReportUri(body["csp-report"]);
  return [];
}
