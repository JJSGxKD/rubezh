import { z } from "zod";
import { formatDateTime, formatNumber } from "../format";
import type { Route } from "../routes";
import { DEVICE_TITLES, PLACE_TITLES, PLATFORM_TITLES, SUCCESS_TITLES } from "./ads";
import { STATUS_LOOK } from "./broadcasts";
import { KIND_TITLES } from "./changelog";
import type { AdminApi, ApiResult } from "./client";
import { WALLET_RESOURCES, resourceName } from "./players";
import { roleName } from "./roles";

/**
 * Журнал аудита (`/admin/audit`, docs/29-admin-panel.md §3.4) словами: что
 * сделали, над чем и что изменилось — вместо имени действия, uuid и JSON.
 * Сервер хранит записи как есть; слова, ссылки на объекты и разбор «было →
 * стало» — здесь, чтобы новое действие не требовало миграции журнала.
 */

export const auditEntrySchema = z.object({
  entryId: z.string(),
  actorAccountId: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  targetName: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

const pageSchema = z.object({ entries: z.array(auditEntrySchema), next: z.string().nullable() });
export type AuditPage = z.infer<typeof pageSchema>;

export const AUDIT_PAGE = 50;

/**
 * Виды действий — те же группы, что в меню: человек ищет «что меняли в
 * промокодах» теми же словами, какими находит раздел. Сервер отбирает по
 * началам имён действий.
 */
export const AUDIT_AREAS = [
  { id: "support", title: "Поддержка", prefixes: ["players.", "wallet.", "referrals."] },
  { id: "growth", title: "Привлечение", prefixes: ["links.", "partner.", "promo."] },
  { id: "revenue", title: "Доход", prefixes: ["shop.", "ads.", "fx."] },
  { id: "engagement", title: "Вовлечение", prefixes: ["tasks.", "broadcast.", "changelog."] },
  { id: "operations", title: "Эксплуатация", prefixes: ["flags.", "settings.", "secrets.", "data."] },
  { id: "team", title: "Команда", prefixes: ["admin.", "roles."] },
] as const;
export type AuditAreaId = (typeof AUDIT_AREAS)[number]["id"];

/** Отбор журнала: вид действий, человек, объект; `null` — без отбора. */
export interface AuditFilter {
  area: AuditAreaId | null;
  actor: { id: string; name: string } | null;
  target: { id: string; name: string } | null;
}

export const NO_AUDIT_FILTER: AuditFilter = { area: null, actor: null, target: null };

export function fetchAudit(api: AdminApi, filter: AuditFilter, before: string | null): Promise<ApiResult<AuditPage>> {
  const area = AUDIT_AREAS.find((item) => item.id === filter.area);
  return api.request("/audit", {
    query: {
      limit: AUDIT_PAGE,
      before: before ?? undefined,
      actions: area?.prefixes.join(","),
      actor: filter.actor?.id,
      target: filter.target?.id,
    },
    schema: pageSchema,
  });
}

/**
 * Что сделали — существительным, а не глаголом: «Ира — блокировка игрока»
 * читается одинаково, кто бы ни нажал, а «заблокировал» пришлось бы
 * угадывать в роде.
 */
const ACTION_TITLES: Record<string, string> = {
  "admin.login": "Вход в панель",
  "roles.assign": "Выдача роли",
  "roles.revoke": "Снятие роли",
  "players.pii.view": "Просмотр личных данных",
  "players.ban": "Блокировка игрока",
  "players.unban": "Снятие блокировки",
  "players.message": "Сообщение игроку",
  "wallet.adjust": "Ручная операция с кошельком",
  "referrals.reject": "Отклонение приглашения",
  "data.export": "Выгрузка данных",
  "fx.manual_rate": "Заданный курс",
  "settings.save": "Изменение настройки",
  "settings.reset": "Сброс настройки к окружению",
  "secrets.save": "Замена ключа интеграции",
  "secrets.reset": "Сброс ключа интеграции к окружению",
  "flags.save": "Изменение флага",
  "flags.remove": "Удаление флага",
  "tasks.create": "Новое задание",
  "tasks.update": "Правка задания",
  "partner.create": "Новый партнёр",
  "partner.update": "Правка партнёра",
  "shop.promo.create": "Новая акция",
  "shop.promo.cancel": "Снятие акции",
  "links.create": "Новая ссылка",
  "broadcast.create": "Новая рассылка",
  "broadcast.update": "Правка рассылки",
  "broadcast.approve": "Одобрение рассылки",
  "broadcast.start": "Запуск рассылки",
  "broadcast.paused": "Пауза рассылки",
  "broadcast.sending": "Рассылка продолжена",
  "broadcast.cancelled": "Отмена рассылки",
  "changelog.create": "Новая строка «Что нового»",
  "changelog.update": "Правка строки «Что нового»",
  "changelog.remove": "Удаление строки «Что нового»",
  "changelog.publish": "Публикация версии",
  "changelog.import": "Строки из PR при выкате",
  "promo.create": "Новый промокод",
  "promo.update": "Правка промокода",
  "promo.pause": "Пауза промокода",
  "promo.resume": "Промокод снова действует",
  "promo.remove": "Удаление промокода",
  "ads.network.update": "Правка рекламной сети",
  "ads.block.create": "Новый рекламный блок",
  "ads.block.update": "Правка рекламного блока",
};

/** Незнакомое действие — новее панели — показывается как записано: лучше код, чем пустота. */
export function actionTitle(action: string): string {
  return ACTION_TITLES[action] ?? action;
}

export function isKnownAction(action: string): boolean {
  return action in ACTION_TITLES;
}

/** Над чем: что это, как называется и куда ведёт, если у объекта есть экран. */
export interface AuditObject {
  kind: string;
  label: string;
  route: Route | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" && found.trim() !== "" ? found : null;
}

/** Название объекта из записанного состояния: после правки — новое, после удаления — прежнее. */
function named(entry: AuditEntry, key: string): string | null {
  return field(entry.after, key) ?? field(entry.before, key);
}

const short = (id: string): string => (UUID.test(id) ? id.slice(0, 8) : id);

export function auditObject(entry: AuditEntry): AuditObject | null {
  const { action, target } = entry;
  // Вход — сам в себя: объект повторил бы колонку «Кто».
  if (action === "admin.login") return null;
  if (action === "players.pii.view") {
    if (target !== null && target.startsWith("report:")) {
      const reportId = target.slice("report:".length);
      return { kind: "отчёт диагностики", label: short(reportId), route: { section: "diagnostics", id: reportId } };
    }
    if (target === null) {
      const query = field(entry.after, "query");
      return { kind: query === null ? "список игроков" : "поиск", label: query === null ? "с фильтрами" : `«${query}»`, route: null };
    }
  }
  if (target === null) return null;
  const area = action.split(".")[0] ?? "";
  if (["players", "wallet", "referrals", "roles"].includes(area)) {
    return { kind: "игрок", label: entry.targetName ?? short(target), route: { section: "players", id: target } };
  }
  switch (area) {
    case "partner":
      return { kind: "партнёр", label: named(entry, "name") ?? short(target), route: { section: "partners", id: target } };
    case "promo":
      return { kind: "промокод", label: named(entry, "title") ?? short(target), route: action === "promo.remove" ? null : { section: "promo-codes", id: target } };
    case "broadcast":
      return { kind: "рассылка", label: named(entry, "title") ?? short(target), route: { section: "broadcasts", id: target } };
    case "shop":
      return { kind: "акция", label: short(target), route: { section: "promos", id: null } };
    case "settings":
      return { kind: "настройка", label: target, route: { section: "settings", id: null } };
    case "secrets":
      return { kind: "ключ", label: named(entry, "title") ?? target, route: { section: "secrets", id: null } };
    case "flags":
      return { kind: "флаг", label: target, route: { section: "flags", id: null } };
    case "tasks":
      return { kind: "задание", label: target, route: { section: "tasks", id: null } };
    case "links":
      return { kind: "ссылка", label: target, route: { section: "links", id: null } };
    case "changelog":
      return action === "changelog.publish" || action === "changelog.import"
        ? { kind: "версия", label: target, route: { section: "changelog", id: null } }
        : { kind: "строка версии", label: named(entry, "version") ?? short(target), route: { section: "changelog", id: null } };
    case "ads":
      return action.startsWith("ads.network.")
        ? { kind: "сеть", label: target, route: { section: "ads", id: null } }
        : { kind: "блок", label: named(entry, "externalId") ?? short(target), route: { section: "ads", id: null } };
    case "fx":
      return { kind: "курс", label: target.replace(":", " · "), route: { section: "fx", id: null } };
    case "data":
      return { kind: "выгрузка", label: short(target), route: { section: "exports", id: null } };
    default:
      return { kind: "объект", label: short(target), route: null };
  }
}

/**
 * Поля записанных состояний — словами. Порядок словаря — порядок важности:
 * в таблице видны первые изменения, и название должно идти раньше даты
 * обновления. Незнакомое поле показывается как записано.
 */
const FIELD_TITLES: Record<string, string> = {
  role: "роль",
  roles: "роли",
  name: "имя",
  title: "название",
  text: "текст",
  value: "значение",
  fingerprint: "ключ",
  enabled: "включено",
  active: "включено",
  status: "состояние",
  bannedAt: "блокировка с",
  banReason: "причина блокировки",
  reason: "причина",
  resource: "ресурс",
  delta: "изменение",
  balance: "баланс",
  reward: "награда",
  message: "сообщение игроку",
  percent: "доля игроков, %",
  platforms: "площадки",
  devices: "устройства",
  segment: "аудитория",
  version: "версия",
  kind: "вид",
  published: "опубликовано",
  price: "курс",
  quote: "валюта",
  expiresAt: "действует до",
  startsAt: "начало",
  endsAt: "конец",
  maxRedemptions: "лимит активаций",
  newPlayersDays: "только новичкам, дней",
  pausedAt: "пауза с",
  partnerName: "партнёр",
  contact: "связь",
  note: "заметка",
  priority: "место в круге",
  place: "место показа",
  externalId: "блок в кабинете",
  success: "условие успеха",
  keys: "ключи",
  source: "источник",
  campaign: "кампания",
  platform: "площадка",
  approvedBy: "одобрил",
  audience: "получателей",
  referrerId: "пригласивший",
  query: "запрос",
  found: "найдено",
  shown: "показано",
  list: "фильтры",
  from: "с",
  to: "по",
  codes: "кодов",
  sizeBytes: "размер, байт",
  via: "откуда",
};

export function fieldTitle(key: string): string {
  return FIELD_TITLES[key] ?? key;
}

/** Служебное, что меняется при каждой правке и ничего не говорит человеку. */
const NOISE = new Set(["updatedAt", "createdAt", "createdBy", "campaignId", "partnerId", "promoId", "blockId", "entryId", "taskId", "redeemed", "codeSample", "networkKey"]);

export interface AuditChange {
  field: string;
  before: unknown;
  after: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isBlank = (value: unknown): boolean => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const rank = (key: string): number => {
  const index = Object.keys(FIELD_TITLES).indexOf(key);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

/**
 * Какая это запись: правка — было и стало, заведение — только «стало»,
 * удаление — только «было»; от этого зависит, рисовать ли стрелку.
 */
export function auditMode(entry: AuditEntry): "update" | "create" | "remove" {
  const was = entry.before !== null && entry.before !== undefined;
  const now = entry.after !== null && entry.after !== undefined;
  if (was && !now) return "remove";
  if (!was && now) return "create";
  return "update";
}

/**
 * Что изменилось — по полям: у правки только отличия, у заведения — что
 * задали, у удаления — что было. Значение без полей — одной строкой без
 * подписи.
 */
export function auditChanges(entry: AuditEntry): AuditChange[] {
  const { before, after } = entry;
  if (!isRecord(before) && !isRecord(after)) {
    return before === null && after === null ? [] : [{ field: "", before, after }];
  }
  const was = isRecord(before) ? before : {};
  const now = isRecord(after) ? after : {};
  const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((key) => !NOISE.has(key));
  return keys
    .filter((key) => !same(was[key], now[key]))
    // У нового пустое поле — «не задано», а не изменение: пустой список площадок значит «везде».
    .filter((key) => isRecord(before) || !isBlank(now[key]))
    .sort((a, b) => rank(a) - rank(b))
    .map((key) => ({ field: key, before: was[key] ?? null, after: now[key] ?? null }));
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Значения-перечисления словами — тем же словарём, что в разделах: «пачка
 * кодов», а не `batch`. Незнакомое значение остаётся как записано.
 */
const VALUE_TITLES: Record<string, Partial<Record<string, string>>> = {
  kind: { shared: "общий код", batch: "пачка кодов", ...KIND_TITLES },
  status: Object.fromEntries(Object.entries(STATUS_LOOK).map(([status, look]) => [status, look.text])),
  source: { base: "панель", env: "окружение сервера", default: "умолчание", none: "не задан" },
  place: PLACE_TITLES,
  success: SUCCESS_TITLES,
  platform: PLATFORM_TITLES,
  platforms: PLATFORM_TITLES,
  devices: DEVICE_TITLES,
};

const word = (key: string, value: string): string => VALUE_TITLES[key]?.[value] ?? value;

/** Значение поля для человека: даты местным временем, да/нет, роли по-русски. */
export function auditValue(value: unknown, key = "", max = 80): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "number") return formatNumber(value);
  const amounts = resourceAmounts(value);
  if (amounts !== null) return amounts;
  if (typeof value === "string") {
    if (key === "role") return roleName(value);
    if (key === "resource") return resourceName(value);
    if (key in VALUE_TITLES) return word(key, value);
    if (ISO.test(value)) return formatDateTime(value);
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) {
    if (value.length === 0) return "—";
    return value.map((item) => (typeof item !== "string" ? String(item) : key === "roles" ? roleName(item) : word(key, item))).join(", ");
  }
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const RESOURCE_IDS = new Set(WALLET_RESOURCES.map(([id]) => id));

/** Награда и прочие наборы ресурсов: «Монеты 1 000 · Самоцветы 25»; нули не показываются. */
function resourceAmounts(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || !entries.every(([id, amount]) => RESOURCE_IDS.has(id) && typeof amount === "number")) return null;
  const parts = entries.filter(([, amount]) => amount !== 0).map(([id, amount]) => `${resourceName(id)} ${formatNumber(amount as number)}`);
  return parts.length === 0 ? "ничего" : parts.join(" · ");
}

/** Целиком, как записано, — для карточки записи. */
export function prettyAudit(value: unknown): string {
  return value === null || value === undefined ? "—" : JSON.stringify(value, null, 2);
}
