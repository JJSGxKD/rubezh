import { z } from "zod";
import { formatNumber } from "../format";
import type { AdminApi, ApiResult } from "./client";
import type { Period } from "./funnel";

/**
 * Кабинет партнёра (`/admin/cabinet`, docs/35-stage4-plan.md Р136, tasks/T-0217, T-0218): партнёр видит свои
 * ссылки и промокоды и сам заводит новые в пределах лимита. Без `partnerId` — его собственный кабинет, с ним —
 * «глазами партнёра» для команды (`partners.view`), только чтение: сервер отвечает отказом на любое создание.
 * Игроков, их имён и ID в ответах нет. Воронка (T-0219) — те же вехи, что у команды, но группы меньше порога сервер
 * не присылает вовсе: панель показывает строку о пороге, а чисел у неё нет.
 */

/** Что за ссылка; сервер знает тот же список (`partners/partner-cabinet.ts` → `CABINET_LINK_SOURCES`). */
export const LINK_SOURCES = ["channel", "post", "stream", "chat", "other"] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

export const SOURCE_TITLES: Record<LinkSource, string> = { channel: "Канал", post: "Пост", stream: "Стрим", chat: "Чат", other: "Другое" };

export const CABINET_LIMITS = { nameMin: 2, nameMax: 80, noteMax: 120, codeMin: 4, codeMax: 48 } as const;

/** Тексты состояний кабинета — рядом с подписями: словарь подсказок панели правят отдельно. */
export const CABINET_TEXTS = {
  noLinks: "Ссылок пока нет — заведите первую для своего канала",
  noPromos: "Промокодов пока нет — их заводит команда; после этого вы сможете сделать копию с новым словом",
  ceiling: "Это потолок кабинета — напишите команде, если нужно больше",
  notPartner: "Кабинет открывается партнёрам. Чтобы посмотреть кабинет конкретного партнёра, откройте его карточку в разделе «Партнёры» и нажмите «Кабинет глазами партнёра».",
  linkCreated: "Ссылка готова — скопируйте адрес",
  batchNote: "Пачка одноразовых кодов — копировать её нельзя",
  needTelegramId: "Сначала укажите Telegram ID партнёра — кнопка «Изменить»",
} as const;

/**
 * Подписи кнопок в строках таблиц кабинета. Кнопка в карточке на телефоне стоит рядом с текстом и отнимает у него
 * ширину: на 320 px длинная подпись оставляла названию и коду по три-четыре знака в строке, поэтому подпись короткая,
 * а полное название действия — в `aria-label`.
 */
export const CABINET_ROW_ACTIONS = {
  copyAddress: "Копировать",
  copyPromo: "Копия",
  copyPromoFull: "Сделать копию с новым словом",
} as const;

/** Окна карточки партнёра: открыть и закрыть кабинет, посмотреть его глазами партнёра. */
export const CABINET_DIALOG = {
  openTitle: (name: string) => `Открыть кабинет партнёру «${name}»?`,
  closeTitle: (name: string) => `Закрыть кабинет партнёра «${name}»?`,
  openNote: "Партнёру выдаётся роль «Партнёр»: он войдёт в панель по Telegram и увидит только свои ссылки и промокоды. Партнёр должен хотя бы раз открыть игру.",
  closeNote: "Роль «Партнёр» снимается, сессии панели партнёра закрываются. Ссылки и промокоды остаются как есть; кабинет можно открыть снова.",
  viewDescription: "Так видит кабинет сам партнёр. Только просмотр: ссылки и копии здесь не заводятся.",
} as const;

/** Плашка просмотра: кто чей кабинет смотрит. */
export function viewBanner(partnerName: string): string {
  return `Просмотр кабинета партнёра «${partnerName}»`;
}

const partnerSchema = z.object({ partnerId: z.string(), name: z.string(), status: z.string(), sharePercent: z.string().nullable(), payoutCurrency: z.string().nullable() });
const overviewSchema = z.object({ partner: partnerSchema });
export type CabinetOverview = z.infer<typeof overviewSchema>;

const linkSchema = z.object({
  code: z.string(),
  url: z.string().nullable(),
  campaign: z.string(),
  source: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  clicks: z.number(),
  launches: z.number(),
});
export type CabinetLink = z.infer<typeof linkSchema>;

const limitSchema = z.object({ used: z.number(), max: z.number() });
const linksSchema = z.object({ links: z.array(linkSchema), limit: limitSchema, viewOnly: z.boolean() });
export type CabinetLinks = z.infer<typeof linksSchema>;

const rewardSchema = z.object({ coins: z.number(), gems: z.number(), shard_common: z.number(), shard_uncommon: z.number() });
const promoSchema = z.object({
  campaignId: z.string(),
  kind: z.enum(["shared", "batch"]),
  code: z.string(),
  reward: rewardSchema,
  redeemed: z.number(),
  maxRedemptions: z.number().nullable(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  state: z.string(),
  copy: z.boolean(),
});
export type CabinetPromo = z.infer<typeof promoSchema>;

const promosSchema = z.object({ promos: z.array(promoSchema), copies: limitSchema, viewOnly: z.boolean() });
export type CabinetPromos = z.infer<typeof promosSchema>;

/** Чей кабинет: `null` — свой, строка — кабинет партнёра глазами команды. */
const scope = (partnerId: string | null) => ({ query: { partnerId: partnerId ?? undefined } });

export function fetchCabinet(api: AdminApi, partnerId: string | null): Promise<ApiResult<CabinetOverview>> {
  return api.request("/cabinet", { ...scope(partnerId), schema: overviewSchema });
}

export function fetchCabinetLinks(api: AdminApi, partnerId: string | null): Promise<ApiResult<CabinetLinks>> {
  return api.request("/cabinet/links", { ...scope(partnerId), schema: linksSchema });
}

export function fetchCabinetPromos(api: AdminApi, partnerId: string | null): Promise<ApiResult<CabinetPromos>> {
  return api.request("/cabinet/promos", { ...scope(partnerId), schema: promosSchema });
}

export interface NewLinkForm {
  campaign: string;
  source: LinkSource;
  note: string;
}

export function emptyLinkForm(): NewLinkForm {
  return { campaign: "", source: "channel", note: "" };
}

/** Проверка формы ссылки до запроса: ровно то, что видно без сервера; остальное — его ответом. */
export function linkFormProblems(form: NewLinkForm): { campaign?: string; note?: string } {
  const problems: { campaign?: string; note?: string } = {};
  const name = form.campaign.trim();
  if (name.length < CABINET_LIMITS.nameMin || name.length > CABINET_LIMITS.nameMax) {
    problems.campaign = `Название — от ${String(CABINET_LIMITS.nameMin)} до ${String(CABINET_LIMITS.nameMax)} знаков, например «Мой канал»`;
  }
  if (form.note.trim().length > CABINET_LIMITS.noteMax) problems.note = `Не длиннее ${String(CABINET_LIMITS.noteMax)} знаков`;
  return problems;
}

export function createCabinetLink(api: AdminApi, form: NewLinkForm): Promise<ApiResult<CabinetLink>> {
  const note = form.note.trim();
  return api.request("/cabinet/links", { method: "POST", body: { campaign: form.campaign.trim(), source: form.source, note: note === "" ? null : note }, schema: linkSchema });
}

/** Слово копии: проверка длины до запроса; буквы, цифры и занятость проверяет сервер и отвечает словами. */
export function codeProblem(raw: string): string | null {
  const code = raw.trim();
  if (code.length < CABINET_LIMITS.codeMin) return `Не короче ${String(CABINET_LIMITS.codeMin)} знаков — короткий код угадывают перебором`;
  if (code.length > CABINET_LIMITS.codeMax) return `Не длиннее ${String(CABINET_LIMITS.codeMax)} знаков`;
  return null;
}

export function copyCabinetPromo(api: AdminApi, campaignId: string, code: string): Promise<ApiResult<CabinetPromo>> {
  return api.request(`/cabinet/promos/${encodeURIComponent(campaignId)}/copy`, { method: "POST", body: { code: code.trim() }, schema: promoSchema });
}

/** Можно ли копировать: общий код, который ещё не кончился по сроку, и лимит копий не выбран. */
export function copyBlockedReason(promo: CabinetPromo, copies: { used: number; max: number }): string | null {
  if (promo.kind === "batch") return CABINET_TEXTS.batchNote;
  if (promo.state === "expired") return "Срок кода вышел — копию не сделать";
  if (copies.used >= copies.max) return CABINET_TEXTS.ceiling;
  return null;
}

/**
 * Пояснение под кнопкой копии в строке. Потолок копий одинаков у всех строк, и в каждой карточке на телефоне он
 * занимал по четыре строки подряд: его показывают один раз над таблицей, а в строке остаётся только то, что
 * относится к ней самой — пачка или вышедший срок.
 */
export function copyRowHint(promo: CabinetPromo, copies: { used: number; max: number }): string | null {
  const reason = copyBlockedReason(promo, copies);
  return reason === CABINET_TEXTS.ceiling ? null : reason;
}

/** Погашено из лимита: «12 из 300» или «12», если лимита нет. */
export function redeemedText(promo: Pick<CabinetPromo, "redeemed" | "maxRedemptions">): string {
  return promo.maxRedemptions === null ? String(promo.redeemed) : `${String(promo.redeemed)} из ${String(promo.maxRedemptions)}`;
}

/** Состояние кабинета в карточке партнёра — ответ `GET /admin/partners/:id` и `POST …/cabinet`. */
export const cabinetStateSchema = z.object({ accountId: z.string().nullable(), open: z.boolean() });
export type CabinetState = z.infer<typeof cabinetStateSchema>;

export function setCabinetOpen(api: AdminApi, partnerId: string, open: boolean): Promise<ApiResult<CabinetState>> {
  return api.request(`/partners/${encodeURIComponent(partnerId)}/cabinet`, { method: "POST", body: { open }, schema: cabinetStateSchema });
}

/** Вехи группы игроков партнёра: те же, что в отчёте «Воронка» команды. */
const funnelCountsSchema = z.object({
  accounts: z.number(),
  entered: z.number(),
  appOpened: z.number(),
  firstRunStarted: z.number(),
  firstRunFinished: z.number(),
  runs2: z.number(),
  runs5: z.number(),
  returnedD1: z.number(),
  returnedD7: z.number(),
  firstPurchase: z.number(),
});

/**
 * Воронка кабинета. `counts: null` — игроков в срезе меньше порога, чисел сервер не прислал. Вид источника, которого
 * панель не знает, — ошибка разбора: молча пустая таблица спрятала бы игроков.
 */
export const cabinetFunnelSchema = z.object({
  from: z.string(),
  to: z.string(),
  minGroup: z.number(),
  clicks: z.number(),
  tooFew: z.boolean(),
  total: funnelCountsSchema.nullable(),
  sources: z.array(z.object({ via: z.enum(["link", "code"]), ref: z.string().nullable(), name: z.string().nullable(), source: z.string().nullable(), note: z.string().nullable(), counts: funnelCountsSchema.nullable() })),
  platforms: z.array(z.object({ platform: z.string(), counts: funnelCountsSchema.nullable() })),
  days: z.array(z.object({ day: z.string(), counts: funnelCountsSchema })),
  hiddenDays: z.number(),
});
export type CabinetFunnel = z.infer<typeof cabinetFunnelSchema>;
export type CabinetFunnelSlice = CabinetFunnel["sources"][number];

export function fetchCabinetFunnel(api: AdminApi, partnerId: string | null, period: Period): Promise<ApiResult<CabinetFunnel>> {
  return api.request("/cabinet/funnel", { query: { partnerId: partnerId ?? undefined, from: period.from, to: period.to }, schema: cabinetFunnelSchema });
}

/** Тексты вкладки «Воронка»: пустое состояние и подсказка рядом, а строки о пороге — функциями от числа из настроек. */
export const CABINET_FUNNEL_TEXTS = {
  empty: "Пока никто не пришёл по вашим ссылкам",
  help: "Что делают игроки, которые пришли по вашим ссылкам и кодам: сколько зашли, сыграли первый забег, вернулись на следующий и на седьмой день, купили. Считается по дню, когда игрок пришёл к вам. Имён и номеров игроков здесь нет — только числа, а там, где игроков мало, чисел нет совсем: так никого нельзя узнать.",
  sources: "Ссылки и коды, по которым пришли игроки. Строка «меньше N игроков» — игроков по ней пока слишком мало, чтобы показывать числа.",
  platforms: "Те же игроки по тому, где они играют.",
  days: "Сколько игроков пришло в каждый день и как далеко они дошли.",
  daysHidden: (count: number) => `Скрыто дней, где игроков меньше порога: ${String(count)}`,
} as const;

/** Строка среза, где игроков меньше порога. */
export function hiddenRowText(minGroup: number): string {
  return `меньше ${String(minGroup)} игроков — не показываем`;
}

/** Итог меньше порога: воронки ещё нет. */
export function tooFewText(minGroup: number): string {
  return `Пока меньше ${String(minGroup)} игроков: воронка появится, когда их станет больше`;
}

/** Строка над воронкой: «Переходов за 30 дней: 1 240»; период со своими датами — «за выбранный период». */
export function clicksLine(clicks: number, days: number | null): string {
  return `Переходов за ${days === null ? "выбранный период" : `${String(days)} дней`}: ${formatNumber(clicks)}`;
}

/**
 * Название среза словами партнёра: ссылка — «канал · Игровой угол» (вид и заметка, без заметки — название), код — «код ·
 * СЛОВО». Удалённое называется честно.
 */
export function funnelSourceTitle(slice: Pick<CabinetFunnelSlice, "via" | "ref" | "name" | "source" | "note">): string {
  if (slice.via === "code") return slice.name === null ? "код (его больше нет)" : `код · ${slice.name}`;
  const label = slice.note ?? slice.name ?? slice.ref ?? "";
  if (slice.source === null) return `ссылка · ${label}`.replace(/ · $/, "");
  const kind = (SOURCE_TITLES as Partial<Record<string, string>>)[slice.source];
  return `${(kind ?? slice.source).toLowerCase()} · ${label}`.replace(/ · $/, "");
}
