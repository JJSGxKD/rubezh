import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Кабинет партнёра (`/admin/cabinet`, docs/35-stage4-plan.md Р136, tasks/T-0217, T-0218): партнёр видит свои
 * ссылки и промокоды и сам заводит новые в пределах лимита. Без `partnerId` — его собственный кабинет, с ним —
 * «глазами партнёра» для команды (`partners.view`), только чтение: сервер отвечает отказом на любое создание.
 * Игроков, их имён и ID в ответах нет.
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
