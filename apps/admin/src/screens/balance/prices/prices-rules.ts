import { z } from "zod";
import type { ChangeRequest, ChangeTarget, RequestStatus } from "../../../api/change-requests";

/**
 * Правила вкладки «Цены и награды» (docs/19-content-admin.md §6, tasks/T-0309):
 * кто что может с заявкой, форма заявки и её проверка тем же правилом, что на
 * сервере, «было → стало» словами. Чистые функции без React — разбор в тестах.
 */

export const PRICES_TAB = { id: "prices", title: "Цены и награды" } as const;

/** Виды заявок: цена товара и число награды (tasks/T-0310). */
export const KIND_SKU = "sku_price";
export const KIND_REWARD = "reward_setting";

export function isPricesTab(value: string | undefined): value is typeof PRICES_TAB.id {
  return value === PRICES_TAB.id;
}

/** Вкладки баланса и «Цены и награды» следом: таблицы баланса о ней не знают. */
export function withPricesTab<T extends { id: string; title: string }>(tabs: readonly T[]): (T | typeof PRICES_TAB)[] {
  return [...tabs, PRICES_TAB];
}

const HOUR_MS = 3_600_000;
const REASON_MAX = 200;
const STARS_MAX = 10_000;

/** Что можно сделать с заявкой этому человеку сейчас; срок смотрится по часам, не дожидаясь пометки сервера. */
export function requestActions(request: Pick<ChangeRequest, "status" | "author" | "expiresAt">, meId: string, now: Date): { approve: boolean; reject: boolean; withdraw: boolean } {
  const open = request.status === "pending" && now.getTime() < Date.parse(request.expiresAt);
  const own = request.author === meId;
  // Решает другой участник; свою заявку автор только отзывает — так же держит сервер.
  return { approve: open && !own, reject: open && !own, withdraw: open && own };
}

const STATUS_TITLES: Record<RequestStatus, string> = {
  pending: "Ждёт подтверждения",
  approved: "Подтверждена",
  rejected: "Отклонена",
  expired: "Истекла",
  superseded: "Заменена новой",
};

/** Статус словами: отклонённая самим автором — «Отозвана». */
export function requestStatusTitle(request: Pick<ChangeRequest, "status" | "author" | "decidedBy">): string {
  if (request.status === "rejected" && request.decidedBy === request.author) return "Отозвана";
  return STATUS_TITLES[request.status];
}

/** Сколько заявке жить: дни, пока их больше суток, потом часы. */
export function timeLeft(request: Pick<ChangeRequest, "expiresAt">, now: Date): string {
  const ms = Date.parse(request.expiresAt) - now.getTime();
  if (ms <= 0) return "истекла";
  const hours = Math.floor(ms / HOUR_MS);
  if (hours >= 24) return `ещё ${String(Math.floor(hours / 24))} дн`;
  if (hours >= 1) return `ещё ${String(hours)} ч`;
  return "меньше часа";
}

/** Значения правимых полей товара — как их отдаёт сервер. */
const skuValuesSchema = z.object({
  stars: z.number(),
  baseRub: z.string(),
  contents: z.object({ gems: z.number() }),
  badge: z.enum(["hit"]).nullable(),
  sort: z.number(),
});
export type SkuValues = z.infer<typeof skuValuesSchema>;

export function skuValuesOf(value: unknown): SkuValues | null {
  const parsed = skuValuesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const show = (value: unknown): string => (value === undefined || value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value));
const badgeText = (badge: unknown): string => (badge === "hit" ? "«Хит»" : "нет");

/** «Было → стало» по полю на строку; порядок — как на сервере. */
export function describeChange(kind: string, before: unknown, after: unknown): string[] {
  const was = record(before);
  const now = record(after);
  if (kind === KIND_REWARD) return [`${show(was.value)} → ${show(now.value)}`];
  if (kind !== KIND_SKU) return Object.keys(now).map((key) => `${key} ${show(was[key])} → ${show(now[key])}`);
  const lines: string[] = [];
  if ("stars" in now) lines.push(`цена ${show(was.stars)} → ${show(now.stars)} ⭐`);
  if ("baseRub" in now) lines.push(`цена ${show(was.baseRub)} → ${show(now.baseRub)} ₽`);
  if ("contents" in now) lines.push(`самоцветов ${show(record(was.contents).gems)} → ${show(record(now.contents).gems)}`);
  if ("badge" in now) lines.push(`значок ${badgeText(was.badge)} → ${badgeText(now.badge)}`);
  if ("sort" in now) lines.push(`порядок ${show(was.sort)} → ${show(now.sort)}`);
  return lines;
}

/** Форма заявки: поля строками — как их вводит человек; значок — `hit` или пусто. */
export interface ProposalDraft {
  stars: string;
  baseRub: string;
  gems: string;
  badge: string;
  sort: string;
  reason: string;
}

export function emptyProposal(target: ChangeTarget): ProposalDraft {
  const current = skuValuesOf(target.current);
  if (current === null) return { stars: "", baseRub: "", gems: "", badge: "", sort: "", reason: "" };
  return { stars: String(current.stars), baseRub: current.baseRub, gems: String(current.contents.gems), badge: current.badge ?? "", sort: String(current.sort), reason: "" };
}

const WHOLE = /^\d{1,9}$/;
const SIGNED_WHOLE = /^-?\d{1,9}$/;
const RUB = /^\d+(\.\d{1,2})?$/;

/** Что в форме не по правилам каталога — те же слова, что у отказа сервера. */
function fieldProblem(draft: ProposalDraft): string | null {
  const stars = draft.stars.trim();
  if (!WHOLE.test(stars) || Number(stars) < 1 || Number(stars) > STARS_MAX) return "Цена в звёздах: целое число от 1 до 10 000";
  if (!RUB.test(draft.baseRub.trim())) return "Цена в рублях: число с копейками, например 86 или 86.50";
  const gems = draft.gems.trim();
  if (!WHOLE.test(gems) || Number(gems) < 1) return "Самоцветов в наборе: целое число больше нуля";
  if (!SIGNED_WHOLE.test(draft.sort.trim())) return "Порядок на витрине: целое число";
  return null;
}

/** Только изменённые поля, в формате сервера: «было» он берёт сам. Невалидное поле не идёт — о нём скажет `proposalProblem`. */
export function proposalAfter(draft: ProposalDraft, target: ChangeTarget): Record<string, unknown> {
  const current = skuValuesOf(target.current);
  if (current === null || fieldProblem(draft) !== null) return {};
  const after: Record<string, unknown> = {};
  if (Number(draft.stars.trim()) !== current.stars) after.stars = Number(draft.stars.trim());
  if (draft.baseRub.trim() !== current.baseRub) after.baseRub = draft.baseRub.trim();
  if (Number(draft.gems.trim()) !== current.contents.gems) after.contents = { gems: Number(draft.gems.trim()) };
  if (draft.badge !== (current.badge ?? "")) after.badge = draft.badge === "hit" ? "hit" : null;
  if (Number(draft.sort.trim()) !== current.sort) after.sort = Number(draft.sort.trim());
  return after;
}

/** Почему форму нельзя отправить; `null` — можно. Порядок: поля, изменения, причина. */
export function proposalProblem(draft: ProposalDraft, target: ChangeTarget): string | null {
  const field = fieldProblem(draft);
  if (field !== null) return field;
  if (Object.keys(proposalAfter(draft, target)).length === 0) return "Ничего не изменено: поменяйте хотя бы одно поле";
  const reason = draft.reason.trim();
  if (reason === "") return "Укажите причину: по ней второй участник решит, подтверждать ли";
  if (reason.length > REASON_MAX) return `Причина не длиннее ${String(REASON_MAX)} знаков`;
  return null;
}

/** «Было» для предпросмотра: значения тех же полей, что в заявке. */
export function beforeOf(target: ChangeTarget, after: Record<string, unknown>): Record<string, unknown> {
  const current = record(target.current);
  return Object.fromEntries(Object.keys(after).map((key) => [key, current[key]]));
}

/** Значение награды в цели: число или строка (лестницы); как его отдаёт сервер. */
export function rewardValueOf(value: unknown): number | string | null {
  const raw = record(value).value;
  return typeof raw === "number" || typeof raw === "string" ? raw : null;
}

/** Форма заявки на награду: значение строкой — как его вводит человек. */
export interface RewardDraft {
  value: string;
  reason: string;
}

export function emptyRewardDraft(target: ChangeTarget): RewardDraft {
  const current = rewardValueOf(target.current);
  return { value: current === null ? "" : String(current), reason: "" };
}

/** Значение в формате сервера: число, если награда числом, иначе строка; `null` — не разобралось. */
function rewardTyped(draft: RewardDraft, target: ChangeTarget): number | string | null {
  const current = rewardValueOf(target.current);
  const text = draft.value.trim();
  if (typeof current === "number") return WHOLE.test(text) ? Number(text) : null;
  return text === "" ? null : text;
}

/** В заявку идёт только `value`; «было» сервер берёт сам. Невалидное значение не идёт — о нём скажет `rewardProblem`. */
export function rewardAfter(draft: RewardDraft, target: ChangeTarget): Record<string, unknown> {
  const value = rewardTyped(draft, target);
  return value === null ? {} : { value };
}

/** Почему форму нельзя отправить; `null` — можно. Пределы и формат лестниц проверяет сервер и отвечает словами. */
export function rewardProblem(draft: RewardDraft, target: ChangeTarget): string | null {
  const current = rewardValueOf(target.current);
  if (current === null) return "Значение награды не разобралось — обновите страницу";
  const value = rewardTyped(draft, target);
  if (value === null) return typeof current === "number" ? "Значение — целое число" : "Значение не заполнено: формат — в подсказке к награде";
  if (value === current) return "Ничего не изменено: поменяйте значение";
  const reason = draft.reason.trim();
  if (reason === "") return "Укажите причину: по ней второй участник решит, подтверждать ли";
  if (reason.length > REASON_MAX) return `Причина не длиннее ${String(REASON_MAX)} знаков`;
  return null;
}
