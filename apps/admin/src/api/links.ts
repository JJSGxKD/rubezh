import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";
import { formatDateTime, formatNumber, formatTime } from "../format";

/**
 * Ссылки кампаний (`/admin/links`, docs/24-attribution-and-sharing.md §3) и
 * конверсии закупок, ушедшие по ним в рекламную сеть (WP43, Р86).
 */

/** Сети, куда умеем отдавать конверсии; сервер знает тот же список (`link-networks.ts`). */
export const LINK_NETWORKS = ["adsgram"] as const;
export type LinkNetwork = (typeof LINK_NETWORKS)[number];

export const NETWORK_TITLES: Record<LinkNetwork, string> = { adsgram: "AdsGram" };

export type RegistrationOn = "first_run" | "launch";

/** Куда ведёт ссылка (Р95); сервер знает тот же список (`link-targets.ts`). */
export const LINK_TARGETS = ["app", "bot", "landing"] as const;
export type LinkTarget = (typeof LINK_TARGETS)[number];

export const TARGET_TITLES: Record<LinkTarget, string> = { app: "Mini App", bot: "Бот", landing: "Лендинг" };

/** Подсказки целей и прямой ссылки. Словарь подсказок панели (`ui/help.ts`) вне зон T-0057, поэтому тексты — рядом с подписями. */
export const TARGET_HELP =
  "Куда попадает человек, перейдя по ссылке. Mini App — сразу в игру; бот — в чат с ботом, игру откроет он; лендинг — на страницу на домене переходника. Цель можно сменить позже: прошлые клики остаются, новые идут по-новому.";
export const DIRECT_HINT = "Без переходника: клики не считаются, только запуски. Короче — для поста, описания канала, партнёра.";
export const NETWORK_DIRECT_LABEL = "Прямая ссылка для рекламы";
export const NETWORK_DIRECT_HINT =
  "Для рекламы AdsGram: вставьте целиком, вместе с метками в фигурных скобках — сеть сама подставит данные клика. Сервер не видит клика, только запуск: клики и расходы смотрите в кабинете AdsGram. Запуск по этой ссылке засчитывается ссылке и уходит сети конверсией, как через переходник.";
export const NETWORK_DIRECT_NEEDS_APP =
  "Прямая ссылка для рекламы есть только у ссылки с целью Mini App: в чат с ботом параметр запуска — до 64 знаков, меток сети в него не уложить.";
export const DIRECT_UNAVAILABLE = "Прямую ссылку сейчас не собрать: серверу ещё не известен адрес бота или домена. Загляните позже.";
/**
 * Прямая ссылка для рекламы у ссылки сети: адрес есть — `ready`; цель не Mini App — `needs_app` (в `/start`
 * метки не умещаются, у лендинга нет параметра запуска); адреса нет при цели Mini App — `unavailable`
 * (бот ещё не представился).
 */
export function networkDirectState(link: { target: LinkTarget; directUrl: string | null }): "ready" | "needs_app" | "unavailable" {
  if (link.directUrl !== null) return "ready";
  return link.target === "app" ? "unavailable" : "needs_app";
}

export const LAUNCHES_HELP =
  "Первое число — запуски игры по кликам через переходник, второе — по прямой ссылке без него. Прямые клики не создают, поэтому в «Клик → запуск» они не входят. Засчитывает сервер по подписанному параметру запуска.";

/** Чья ссылка (Р96, T-0067): наша или партнёра; владелец задаётся при создании и потом не меняется. */
export const OWNER_TITLES = { own: "Наша", partner: "Партнёра" } as const;
export type LinkOwnerKind = keyof typeof OWNER_TITLES;

/** Подсказки владельца. Словарь подсказок панели (`ui/help.ts`) вне зон T-0067, поэтому тексты — рядом с подписями. */
export const OWNER_HELP =
  "Наша — обычная ссылка команды. Партнёра — игрок, который впервые пришёл по ней, записывается за партнёром, если тот активен, аккаунт не старше окна привязки, а игрока ещё никто не привёл: ни друг, ни другой партнёр. Владельца после создания не сменить: клики и привязки уже записаны за ним.";
export const OWNER_NO_PARTNERS = "Активных партнёров нет — заведите партнёра или верните его в статус «активен» в разделе «Партнёры».";
export const OWNER_PARTNERS_UNAVAILABLE = "Список партнёров не открылся — ссылка партнёра сейчас недоступна. Попробуйте обновить страницу.";

/** Что значит цель — для мастера и карточки. */
export const TARGET_HINTS: Record<LinkTarget, string> = {
  app: "Человек сразу попадает в игру.",
  bot: "Человек попадает в чат с ботом и жмёт «Старт»; игру откроет бот.",
  landing: "Человек попадает на лендинг; что дальше, решает страница.",
};

/** Владелец-партнёр ссылки; ссылка команды и сервер старше партнёрских ссылок дают `null`. */
// Событий и признака общего адреса партнёра у сервера старее T-0071 нет: тогда общего адреса как не бывало.
const linkPartnerSchema = z.object({
  partnerId: z.string(),
  name: z.string(),
  /** задан ли у партнёра общий адрес постбэка; сам адрес в ссылку не приходит */
  postbackSet: z.boolean().optional().catch(undefined),
  /** какие события уходят на общий адрес партнёра */
  postbackEvents: z.array(z.string()).optional().catch(undefined),
});
export type LinkPartner = z.infer<typeof linkPartnerSchema>;

const goalCountsSchema = z.object({ pending: z.number(), sent: z.number(), failed: z.number(), skipped: z.number() });
const summarySchema = z.object({ "1": goalCountsSchema, "2": goalCountsSchema, "3": goalCountsSchema });

export type GoalCounts = z.infer<typeof goalCountsSchema>;
export type ConversionSummary = z.infer<typeof summarySchema>;

export const linkSchema = z.object({
  code: z.string(),
  url: z.string(),
  platform: z.string(),
  campaign: z.string(),
  source: z.string().nullable(),
  medium: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  // Сеть, о которой панель ещё не знает, показывается обычной ссылкой, а не ломает список.
  network: z.enum(LINK_NETWORKS).nullable().catch(null),
  registrationOn: z.enum(["first_run", "launch"]).catch("first_run"),
  /** адрес с макросами сети — его вставляют в кабинет сети; у обычной ссылки `null` */
  networkUrl: z.string().nullable(),
  // Цель, о которой панель ещё не знает, показывается как Mini App, а не ломает список.
  target: z.enum(LINK_TARGETS).catch("app"),
  /** прямой адрес без переходника; `null` — у ссылки сети его нет или бот ещё не представился */
  directUrl: z.string().nullable(),
  // Сервер старее партнёрских ссылок или прислал мусор: ссылка считается ссылкой команды, список не ломается.
  partner: linkPartnerSchema.nullable().catch(null),
  // Автоисточник (Р116) и его показ. Сервер старее панели или мусор в поле: ссылка считается ручной,
  // список не ломается.
  auto: z.boolean().catch(false),
  autoKey: z.string().nullable().catch(null),
  partnerTag: z.string().nullable().catch(null),
  title: z.string().nullable().catch(null),
  hiddenAt: z.string().nullable().catch(null),
  // Адрес постбэка (T-0070): сервер старее панели или мусор в поле — адреса нет, события — одна регистрация.
  postbackUrl: z.string().nullable().catch(null),
  postbackSince: z.string().nullable().catch(null),
  postbackEvents: z.array(z.string()).catch(["registration"]),
});

/** Клики по классу устройства; без класса и незнакомый класс сервер сводит в `unknown`. */
const deviceCountsSchema = z.object({ mobile: z.number(), desktop: z.number(), web: z.number(), unknown: z.number() });

export type DeviceCounts = z.infer<typeof deviceCountsSchema>;

export const linkStatsSchema = linkSchema.extend({
  clicks: z.number(),
  clicks30d: z.number(),
  launches: z.number(),
  /** запуски по прямой ссылке — клика у них нет */
  directLaunches: z.number(),
  // Сервер старее панели: блока устройств нет, список не ломается.
  devices: deviceCountsSchema.catch({ mobile: 0, desktop: 0, web: 0, unknown: 0 }),
  conversions: summarySchema.nullable(),
});

export type Link = z.infer<typeof linkSchema>;
export type LinkRow = z.infer<typeof linkStatsSchema>;

const linksResponseSchema = z.object({
  links: z.array(linkStatsSchema),
  /** задан ли токен нашего кабинета сети — без значения */
  postback: z.object({ adsgramToken: z.boolean() }),
});

export type LinksResponse = z.infer<typeof linksResponseSchema>;

export interface NewLink {
  campaign: string;
  source?: string;
  medium?: string;
  note?: string;
  network?: LinkNetwork;
  registrationOn?: RegistrationOn;
  target?: LinkTarget;
  /** партнёр-владелец; не задан — ссылка команды */
  partnerId?: string;
}

/** Тот же формат, что проверяет сервер: кампания и источник уходят в разрезы аналитики. */
export const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Маршрут мастера ссылки с выбранным партнёром: `#/links/partner:<id>` — из карточки партнёра. */
export const LINK_PARTNER_ROUTE = "partner:";

export function partnerOfLinkRoute(id: string | null): string | null {
  return id !== null && id.startsWith(LINK_PARTNER_ROUTE) && id.length > LINK_PARTNER_ROUTE.length ? id.slice(LINK_PARTNER_ROUTE.length) : null;
}

/** Чья ссылка словами для колонки «Партнёр»: имя партнёра или «Наша». */
export function ownerLabel(partner: LinkPartner | null): string {
  return partner === null ? OWNER_TITLES.own : partner.name;
}

export function fetchLinks(api: AdminApi): Promise<ApiResult<LinksResponse>> {
  return api.request("/links", { schema: linksResponseSchema });
}

export function createLink(api: AdminApi, input: NewLink): Promise<ApiResult<Link>> {
  return api.request("/links", { method: "POST", body: input, schema: linkSchema });
}

/** Сменить цель: прошлые клики остаются, новые идут по-новому. */
export function retargetLink(api: AdminApi, code: string, target: LinkTarget): Promise<ApiResult<Link>> {
  return api.request(`/links/${encodeURIComponent(code)}`, { method: "PATCH", body: { target }, schema: linkSchema });
}

/**
 * Задать, сменить или снять адрес постбэка ссылки (T-0070). Пустой адрес и из одних пробелов снимают его; недопустимый
 * сервер отклоняет понятным текстом, и он доходит как есть.
 */
export function setLinkPostback(api: AdminApi, code: string, url: string | null): Promise<ApiResult<Link>> {
  const trimmed = url?.trim() ?? "";
  return api.request(`/links/${encodeURIComponent(code)}`, { method: "PATCH", body: { postbackUrl: trimmed === "" ? null : trimmed }, schema: linkSchema });
}

/**
 * Выбрать события, которые уходят на адрес ссылки (T-0071). Уходят в каноническом порядке и без повторов; пустой
 * выбор до сервера не доходит — его останавливает `eventsChoice`. Без своего адреса у ссылки сервер ответит отказом.
 */
export function setLinkPostbackEvents(api: AdminApi, code: string, events: readonly string[]): Promise<ApiResult<Link>> {
  return api.request(`/links/${encodeURIComponent(code)}`, { method: "PATCH", body: { postbackEvents: canonicalEvents(events) }, schema: linkSchema });
}

/** Дать автоисточнику название; пустое сбрасывает, и в списке снова кампания. Кампания и источник не меняются. */
export function renameLink(api: AdminApi, code: string, title: string): Promise<ApiResult<Link>> {
  const trimmed = title.trim();
  return api.request(`/links/${encodeURIComponent(code)}/display`, { method: "PATCH", body: { title: trimmed === "" ? null : trimmed }, schema: linkSchema });
}

/** Скрыть автоисточник из списка или вернуть; запуски по нему считаются как раньше. */
export function setLinkHidden(api: AdminApi, code: string, hidden: boolean): Promise<ApiResult<Link>> {
  return api.request(`/links/${encodeURIComponent(code)}/display`, { method: "PATCH", body: { hidden }, schema: linkSchema });
}

export const unknownKeysSchema = z.object({
  keys: z.array(z.object({ key: z.string(), hits: z.number(), firstAt: z.string(), lastAt: z.string() })),
  limit: z.number(),
});
export type UnknownKeys = z.infer<typeof unknownKeysSchema>;

/** Сводка ключей параметра запуска, которых нет в списке: только чтение. */
export function fetchUnknownKeys(api: AdminApi): Promise<ApiResult<UnknownKeys>> {
  return api.request("/links/unknown-keys", { schema: unknownKeysSchema });
}

export const AUTO_SOURCE_HELP = "Источник появился по первой ссылке с такими метками. Название можно поменять, а источник скрыть: запуски по нему продолжат считаться.";
export const UNKNOWN_KEYS_HELP = "Ключи в параметре запуска, которых нет в списке: источником они не становятся, а копятся здесь. Нужен ключ — добавьте его в список в коде (docs/24, §3.6).";
export const RENAME_HELP = "Меняется только название для людей. Кампания и источник остаются: по ним идут разрезы аналитики. Пустое название возвращает кампанию.";
export const TITLE_MAX = 80;

/** Название для списка и карточки: данное в панели, а нет — кампания. */
export function linkTitle(link: Pick<Link, "title" | "campaign">): string {
  return link.title !== null && link.title !== "" ? link.title : link.campaign;
}

/** Строки без скрытых источников; при `showHidden` — все. Порядок как пришёл. */
export function visibleLinks<T extends Pick<Link, "hiddenAt">>(rows: readonly T[], showHidden: boolean): T[] {
  return showHidden ? [...rows] : rows.filter((row) => row.hiddenAt === null);
}

/** Пары, по которым источник завёлся сам: подписанные словами, для карточки. У ручной ссылки — пусто. */
export function autoPairs(link: Pick<Link, "auto" | "source" | "campaign" | "medium" | "partnerTag">): { label: string; value: string }[] {
  if (!link.auto) return [];
  const pairs: { label: string; value: string }[] = [];
  if (link.source !== null && link.source !== "") pairs.push({ label: "Источник", value: link.source });
  if (link.campaign !== "") pairs.push({ label: "Кампания", value: link.campaign });
  if (link.medium !== null && link.medium !== "") pairs.push({ label: "Место", value: link.medium });
  if (link.partnerTag !== null && link.partnerTag !== "") pairs.push({ label: "Партнёр", value: link.partnerTag });
  return pairs;
}

/** Только что заведённая ссылка строкой списка — карточка открывается, не дожидаясь перечитывания. */
export function freshRow(link: Link): LinkRow {
  const counts = (): GoalCounts => ({ pending: 0, sent: 0, failed: 0, skipped: 0 });
  return { ...link, clicks: 0, clicks30d: 0, launches: 0, directLaunches: 0, devices: { mobile: 0, desktop: 0, web: 0, unknown: 0 }, conversions: link.network === null ? null : { "1": counts(), "2": counts(), "3": counts() } };
}

export type DeviceKey = keyof DeviceCounts;

export const DEVICE_TITLES: Record<DeviceKey, string> = {
  mobile: "С телефона",
  desktop: "С компьютера",
  web: "Из веб-версии",
  unknown: "Устройство не определено",
};

export interface DeviceRow {
  key: DeviceKey;
  title: string;
  count: number;
}

const DEVICE_ORDER: readonly DeviceKey[] = ["mobile", "desktop", "web", "unknown"];

/** Строки блока «Клики по устройствам»: телефон, компьютер, веб, не определено; нулевые пропускаются. */
export function deviceRows(devices: DeviceCounts): DeviceRow[] {
  return DEVICE_ORDER.filter((key) => devices[key] > 0).map((key) => ({ key, title: DEVICE_TITLES[key], count: devices[key] }));
}

/** «Через переходник + прямых» — одним числом в списке; прямые запуски в долю от кликов не входят. */
export function launchesLabel(row: Pick<LinkRow, "launches" | "directLaunches">): string {
  return `${formatNumber(row.launches)} + ${formatNumber(row.directLaunches)}`;
}

/** Доля запусков от кликов, целыми процентами; без кликов — `null`. */
export function conversion(row: Pick<LinkRow, "clicks" | "launches">): number | null {
  return row.clicks === 0 ? null : Math.round((row.launches / row.clicks) * 100);
}

// --- Адрес постбэка (T-0070) ---

/** Подписи и подсказки блока адреса. Словарь подсказок панели (`ui/help.ts`) вне зон T-0070, поэтому тексты — рядом с блоком. */
export const POSTBACK_BLOCK_TITLE = "Постбэк по этой ссылке";
export const POSTBACK_LINK_LABEL = "Адрес постбэка";
export const POSTBACK_LINK_OWNED_LABEL = "Адрес для этой ссылки (если пусто — общий адрес партнёра)";
export const POSTBACK_PARTNER_BLOCK_TITLE = "Постбэк партнёра";
export const POSTBACK_PARTNER_LABEL = "Общий адрес постбэка партнёра";
export const POSTBACK_HINT =
  "Мы отправим GET-запрос по этому адресу. Подставляются: {click_id}, {sub1}…{sub5} — значения из ссылки, {event} — событие, {event_id} — наш идентификатор события, по нему приёмник отсекает повторы, {amount} и {currency} — сумма и валюта платежа (звёзды — XTR). Адрес только https, без логина, пароля и порта.";
export const POSTBACK_PARAMS_NOTE = "К адресу ссылки можно добавить click_id и sub1…sub5 — мы сохраним их и вернём в постбэке.";
export const POSTBACK_OFFLINE = "Не удалось сохранить — проверьте связь";
/** Пример адреса: подставляется кнопкой «Вставить пример». */
export const POSTBACK_EXAMPLE = "https://example.com/postback?click_id={click_id}&event={event}&event_id={event_id}&amount={amount}&currency={currency}&sub1={sub1}";

/** Что отправляем сейчас: с какого времени идут клики или что адреса нет. Адрес без момента (в базе не бывает) — тоже «не задан». */
export function postbackState(setting: { postbackUrl: string | null; postbackSince: string | null }): string {
  if (setting.postbackUrl === null || setting.postbackSince === null) return "Адрес не задан — ничего не отправляем.";
  return `Отправляем по кликам с ${formatDateTime(setting.postbackSince)}. События по более ранним кликам не отправляются.`;
}

/** Событие постбэка, его название флажка и подсказка к нему. Порядок — канонический, как на сервере (`postback-events.ts`). */
export const POSTBACK_EVENT_OPTIONS = [
  { event: "registration", title: "Регистрация", hint: "Новый игрок зарегистрировался — по правилу ссылки" },
  { event: "purchase_first", title: "Первая покупка", hint: "Первая настоящая оплата игрока в течение 30 дней после клика" },
  { event: "purchase_repeat", title: "Повторная покупка", hint: "Каждая следующая оплата" },
  {
    event: "d1_return",
    title: "Возврат на следующий день",
    hint: "Игрок вернулся и сыграл засчитанный забег на следующие игровые сутки после дня регистрации; сутки — по Москве. По умолчанию выключено",
  },
] as const;

export const POSTBACK_EVENTS_LATER_NOTE = "Событие, включённое позже, уйдёт и по игрокам, которые пришли после даты начала отправки, пока не закрылось его окно.";
export const INHERITED_EVENTS_CAPTION = "События общего адреса партнёра";
export const INHERITED_EVENTS_NOTE = "Меняются в карточке партнёра.";
export const NO_EVENTS_CHOSEN = "Выберите хотя бы одно событие";
/** У AdsGram выбора нет: три фиксированных события, возврат он не принимает (`adsgram.destination.ts`). */
export const ADSGRAM_EVENTS_LINE = "AdsGram получает: регистрация, первая покупка, повторная покупка. Возврат на следующий день AdsGram не принимает.";

const POSTBACK_EVENT_TITLES: Readonly<Record<string, string>> = Object.fromEntries(POSTBACK_EVENT_OPTIONS.map((option) => [option.event, option.title.toLowerCase()]));

/** Известные события в каноническом порядке и без повторов; незнакомое (сервер новее панели) отбрасывается. */
export function canonicalEvents(events: readonly string[]): string[] {
  return POSTBACK_EVENT_OPTIONS.map((option) => option.event).filter((event) => events.includes(event));
}

/** «Получает: регистрация.» — события словами в каноническом порядке; незнакомое событие показывается как есть, в конце. */
export function postbackEventsLine(events: readonly string[]): string {
  if (events.length === 0) return "Получает: ничего.";
  const unknown = events.filter((event) => POSTBACK_EVENT_TITLES[event] === undefined);
  const titles = [...canonicalEvents(events).map((event) => POSTBACK_EVENT_TITLES[event] ?? event), ...unknown];
  return `Получает: ${titles.join(", ")}.`;
}

/** Что отправить по отмеченным флажкам: список в каноническом порядке или, если ничего не отмечено, — отказ словами, запрос не уходит. */
export function eventsChoice(selected: readonly string[]): { ok: true; events: string[] } | { ok: false; error: string } {
  const events = canonicalEvents(selected);
  return events.length === 0 ? { ok: false, error: NO_EVENTS_CHOSEN } : { ok: true, events };
}

/**
 * Чьи события показывает блок ссылки: свои (адрес ссылки задан — флажки меняются), общего адреса партнёра (у ссылки
 * своего нет, у партнёра есть — флажки недоступны) или никаких (адреса нет нигде, ничего не отправляем).
 */
export type LinkEventsView = { kind: "none" } | { kind: "own"; events: string[] } | { kind: "inherited"; events: string[] };

export function linkEventsView(link: Pick<Link, "postbackUrl" | "postbackEvents" | "partner">): LinkEventsView {
  if (link.postbackUrl !== null) return { kind: "own", events: link.postbackEvents };
  if (link.partner?.postbackSet === true) return { kind: "inherited", events: link.partner.postbackEvents ?? ["registration"] };
  return { kind: "none" };
}

/** Ошибка сохранения словами для поля: нет сети — наш текст, остальное — как ответил сервер, введённое остаётся. */
export function postbackSaveError(error: { kind: string; message: string }): string {
  return error.kind === "offline" ? POSTBACK_OFFLINE : error.message;
}

/** Назначения постбэков в журнале (T-0069, T-0070); сервер знает тот же список (`destination.ts`). */
export const DESTINATION_TITLES = { adsgram: "AdsGram", s2s: "Адрес сети", partner: "Партнёр" } as const;

/** Подпись назначения; назначение, о котором панель ещё не знает, показывается как есть. */
export function destinationTitle(destination: string): string {
  return (DESTINATION_TITLES as Readonly<Record<string, string>>)[destination] ?? destination;
}

// --- Конверсии сети ---

/** Цели, по которым сервер ведёт счёт ссылки: регистрация и покупки; возврат на следующий день в счёт не входит. */
export type SummaryGoal = 1 | 2 | 3;
/** Код события в журнале: 1–3 как `goaltype` AdsGram, 4 — возврат на следующий день (T-0071). */
export type ConversionGoal = SummaryGoal | 4;

export const GOALS: readonly SummaryGoal[] = [1, 2, 3];

export const GOAL_TITLES: Record<ConversionGoal, string> = { 1: "Регистрация", 2: "Первая покупка", 3: "Повторная покупка", 4: "Возврат на следующий день" };

export const conversionSchema = z.object({
  conversionId: z.string(),
  goal: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  // Куда уходит строка. Сервер старее панели: до постбэков назначение было одно — AdsGram.
  destination: z.string().catch("adsgram"),
  status: z.enum(["pending", "sent", "failed", "skipped"]),
  reason: z.string().nullable(),
  attempts: z.number(),
  httpStatus: z.number().nullable(),
  lastError: z.string().nullable(),
  accountId: z.string(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  nextAttemptAt: z.string(),
});

export type Conversion = z.infer<typeof conversionSchema>;

const journalSchema = z.object({ conversions: z.array(conversionSchema), next: z.string().nullable() });

export function fetchConversions(api: AdminApi, code: string, before: string | null): Promise<ApiResult<z.infer<typeof journalSchema>>> {
  const query = before === null ? "" : `?before=${encodeURIComponent(before)}`;
  return api.request(`/links/${encodeURIComponent(code)}/conversions${query}`, { schema: journalSchema });
}

/** Отправить снова — неотправленную или пропущенную: уйдёт ближайшим проходом, в течение минуты. */
export function resendConversion(api: AdminApi, code: string, conversionId: string): Promise<ApiResult<Conversion>> {
  return api.request(`/links/${encodeURIComponent(code)}/conversions/${encodeURIComponent(conversionId)}/send`, { method: "POST", schema: conversionSchema });
}

/** Что с конверсией — словами для журнала: заголовок, тон значка и подробность. */
export interface ConversionState {
  title: string;
  tone: "success" | "warning" | "danger" | "neutral" | "info";
  detail: string;
  /** можно отправить снова руками */
  resendable: boolean;
}

const SKIP_REASONS: Record<string, string> = {
  team: "аккаунт команды: свои проверки сети ни к чему. Проверяете связку с кабинетом — отправьте руками",
  no_macros: "в клике или параметре запуска нет меток сети — переход не из рекламы: превью кабинета или проверка ссылки руками",
  unknown_network: "сеть ссылки больше не поддерживается",
  no_address: "адрес постбэка снят",
  no_click_id: "в ссылке не было click_id",
};

export function conversionState(row: Conversion): ConversionState {
  switch (row.status) {
    case "sent":
      return { title: "Ушла", tone: "success", detail: `${formatDateTime(row.sentAt)}${row.httpStatus === null ? "" : `, ответ ${String(row.httpStatus)}`}`, resendable: false };
    case "failed":
      return {
        title: "Не ушла",
        tone: "danger",
        detail: `${row.lastError ?? "сеть отказала"}${row.attempts > 1 ? ` — попыток: ${String(row.attempts)}` : ""}`,
        resendable: true,
      };
    case "skipped":
      // Отправить руками можно только аккаунт команды: без меток сети повтор пропустился бы снова.
      return { title: "Пропущена", tone: "neutral", detail: (row.reason === null ? undefined : SKIP_REASONS[row.reason]) ?? row.reason ?? "", resendable: row.reason === "team" };
    case "pending":
      if (row.reason === "no_token") return { title: "Ждёт токен", tone: "warning", detail: "токен конверсий не задан — уйдёт в течение пяти минут после того, как его зададут", resendable: false };
      if (row.attempts > 0) {
        return { title: "Повтор", tone: "warning", detail: `${row.lastError ?? "сбой сети"}; следующая попытка в ${formatTime(row.nextAttemptAt)}`, resendable: false };
      }
      return { title: "В очереди", tone: "info", detail: "уйдёт в течение минуты", resendable: false };
  }
}

const GOAL_KEYS = { 1: "1", 2: "2", 3: "3" } as const;

export function goalCounts(summary: ConversionSummary, goal: SummaryGoal): GoalCounts {
  return summary[GOAL_KEYS[goal]];
}

/** Итог по ссылке для списка: сколько отдано сети и есть ли что чинить. */
export interface SummaryLine {
  registrations: number;
  purchases: number;
  failed: number;
  waiting: number;
}

export function summaryLine(summary: ConversionSummary): SummaryLine {
  // Пропущенные — не конверсии сети: аккаунты команды и переходы не из рекламы.
  const counted = (counts: GoalCounts) => counts.sent + counts.pending + counts.failed;
  return {
    registrations: counted(goalCounts(summary, 1)),
    purchases: counted(goalCounts(summary, 2)) + counted(goalCounts(summary, 3)),
    failed: GOALS.reduce((sum, goal) => sum + goalCounts(summary, goal).failed, 0),
    waiting: GOALS.reduce((sum, goal) => sum + goalCounts(summary, goal).pending, 0),
  };
}
