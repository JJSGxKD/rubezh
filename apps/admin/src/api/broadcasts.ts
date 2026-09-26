import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Рассылки в бота (`/admin/broadcasts`, docs/29-admin-panel.md §7). Правила
 * формы повторяют сервер, чтобы ошибка была видна до отправки; решает всё
 * равно сервер.
 */

export const MILESTONES = [
  ["entered", "вошёл в бота"],
  ["app_opened", "открыл приложение"],
  ["first_run_started", "начал первый забег"],
  ["first_run_finished", "закончил первый забег"],
  ["runs_2", "сыграл второй забег"],
  ["runs_5", "сыграл пятый забег"],
  ["returned_d1", "вернулся на следующий день"],
  ["returned_d7", "вернулся через неделю"],
  ["first_purchase", "первая покупка"],
] as const;

export type Milestone = (typeof MILESTONES)[number][0];

export const START_KINDS = [
  ["organic", "сам"],
  ["click", "ссылка кампании"],
  ["invite", "приглашение"],
  ["telegram_affiliate", "партнёрка Telegram"],
  ["friend", "ссылка друга"],
  ["unknown", "неизвестно"],
] as const;

export type StartKind = (typeof START_KINDS)[number][0];

const milestoneSchema = z.enum(MILESTONES.map(([id]) => id) as [Milestone, ...Milestone[]]);
const startKindSchema = z.enum(START_KINDS.map(([id]) => id) as [StartKind, ...StartKind[]]);

export const segmentSchema = z.object({
  startKinds: z.array(startKindSchema),
  campaign: z.string().optional(),
  reached: z.array(milestoneSchema),
  notReached: z.array(milestoneSchema),
  registeredWithinDays: z.number().optional(),
  activeWithinDays: z.number().optional(),
  inactiveForDays: z.number().optional(),
  skipRecentDays: z.number(),
});

export type Segment = z.infer<typeof segmentSchema>;

export const EMPTY_SEGMENT: Segment = { startKinds: [], reached: [], notReached: [], skipRecentDays: 3 };

export const BROADCAST_STATUSES = ["draft", "sending", "paused", "done", "cancelled"] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

export const STATUS_LOOK: Record<BroadcastStatus, { text: string; tone: "neutral" | "info" | "warning" | "success" | "danger" }> = {
  draft: { text: "черновик", tone: "neutral" },
  sending: { text: "идёт", tone: "info" },
  paused: { text: "пауза", tone: "warning" },
  done: { text: "отправлена", tone: "success" },
  cancelled: { text: "отменена", tone: "danger" },
};

export const broadcastSchema = z.object({
  broadcastId: z.string(),
  title: z.string(),
  platform: z.string(),
  text: z.string(),
  buttonText: z.string().nullable(),
  buttonUrl: z.string().nullable(),
  linkCode: z.string().nullable(),
  segment: segmentSchema,
  status: z.enum(BROADCAST_STATUSES),
  audience: z.number().nullable(),
  createdBy: z.string(),
  approvedBy: z.string().nullable(),
  startedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export type BroadcastRow = z.infer<typeof broadcastSchema>;

export const statsSchema = z.object({ queued: z.number(), sent: z.number(), blocked: z.number(), failed: z.number(), blockedAfter: z.number() });
export type DeliveryStats = z.infer<typeof statsSchema>;

export const broadcastViewSchema = broadcastSchema.extend({ stats: statsSchema.nullable(), approvalAudience: z.number() });
export type BroadcastView = z.infer<typeof broadcastViewSchema>;

export const sendOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("sent") }),
  z.object({ status: z.literal("blocked") }),
  z.object({ status: z.literal("retry"), afterSec: z.number() }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
]);
export type SendOutcome = z.infer<typeof sendOutcomeSchema>;

export interface BroadcastInput {
  title: string;
  text: string;
  /** пусто — без кнопки */
  buttonText: string;
  segment: Segment;
}

export function fetchBroadcasts(api: AdminApi): Promise<ApiResult<{ broadcasts: BroadcastRow[] }>> {
  return api.request("/broadcasts", { schema: z.object({ broadcasts: z.array(broadcastSchema) }) });
}

export function fetchBroadcast(api: AdminApi, id: string): Promise<ApiResult<BroadcastView>> {
  return api.request(`/broadcasts/${encodeURIComponent(id)}`, { schema: broadcastViewSchema });
}

export function createBroadcast(api: AdminApi, input: BroadcastInput): Promise<ApiResult<BroadcastRow>> {
  return api.request("/broadcasts", { method: "POST", body: { ...bodyOf(input), platform: "telegram" }, schema: broadcastSchema });
}

export function updateBroadcast(api: AdminApi, id: string, input: BroadcastInput): Promise<ApiResult<BroadcastRow>> {
  return api.request(`/broadcasts/${encodeURIComponent(id)}`, { method: "POST", body: bodyOf(input), schema: broadcastSchema });
}

export function estimateAudience(api: AdminApi, segment: Segment): Promise<ApiResult<{ audience: number }>> {
  return api.request("/broadcasts/estimate", { method: "POST", body: { platform: "telegram", segment }, schema: z.object({ audience: z.number() }) });
}

export function testBroadcast(api: AdminApi, id: string): Promise<ApiResult<SendOutcome>> {
  return api.request(`/broadcasts/${encodeURIComponent(id)}/test`, { method: "POST", schema: sendOutcomeSchema });
}

export function startBroadcast(api: AdminApi, id: string): Promise<ApiResult<{ audience: number }>> {
  return api.request(`/broadcasts/${encodeURIComponent(id)}/start`, { method: "POST", schema: z.object({ audience: z.number() }) });
}

export type BroadcastAction = "approve" | "pause" | "resume" | "cancel";

export function actOnBroadcast(api: AdminApi, id: string, action: BroadcastAction): Promise<ApiResult<BroadcastRow>> {
  return api.request(`/broadcasts/${encodeURIComponent(id)}/${action}`, { method: "POST", schema: broadcastSchema });
}

function bodyOf(input: BroadcastInput) {
  const buttonText = input.buttonText.trim();
  return { title: input.title.trim(), text: input.text.trim(), buttonText: buttonText === "" ? null : buttonText, segment: input.segment };
}

const DAYS_MAX = 3650;

/** Что не так с формой; `null` — можно сохранять. */
export function broadcastProblem(input: BroadcastInput): string | null {
  const title = input.title.trim();
  const text = input.text.trim();
  if (title === "" || title.length > 120) return "Название — от 1 до 120 знаков";
  if (text === "" || text.length > 4096) return "Текст — от 1 до 4096 знаков: больше Telegram не пропустит";
  if (input.buttonText.trim().length > 64) return "Надпись на кнопке — до 64 знаков";
  return segmentProblem(input.segment);
}

export function segmentProblem(segment: Segment): string | null {
  if (segment.reached.some((milestone) => segment.notReached.includes(milestone))) return "Веха не может быть и пройдена, и не пройдена";
  for (const days of [segment.registeredWithinDays, segment.activeWithinDays, segment.inactiveForDays]) {
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > DAYS_MAX)) return `Дни — целое число от 1 до ${DAYS_MAX}`;
  }
  if (!Number.isInteger(segment.skipRecentDays) || segment.skipRecentDays < 0 || segment.skipRecentDays > 90) return "«Не писать получавшим» — от 0 до 90 дней";
  if (segment.activeWithinDays !== undefined && segment.inactiveForDays !== undefined && segment.inactiveForDays >= segment.activeWithinDays) {
    return "«Заходил за N дней» и «не заходил M дней» не пересекаются";
  }
  if (segment.campaign !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(segment.campaign)) return "Кампания — латиница в нижнем регистре, цифры, дефис";
  return null;
}

const MILESTONE_NAMES = new Map<string, string>(MILESTONES);
const START_NAMES = new Map<string, string>(START_KINDS);

/** Аудитория словами — по строке на условие; пусто — «все, кому можно писать». */
export function segmentSummary(segment: Segment): string[] {
  const lines: string[] = [];
  if (segment.reached.length > 0) lines.push(`прошли: ${segment.reached.map((id) => MILESTONE_NAMES.get(id) ?? id).join(", ")}`);
  if (segment.notReached.length > 0) lines.push(`не прошли: ${segment.notReached.map((id) => MILESTONE_NAMES.get(id) ?? id).join(", ")}`);
  if (segment.startKinds.length > 0) lines.push(`пришли: ${segment.startKinds.map((id) => START_NAMES.get(id) ?? id).join(", ")}`);
  if (segment.campaign !== undefined) lines.push(`кампания первого касания: ${segment.campaign}`);
  if (segment.registeredWithinDays !== undefined) lines.push(`зарегистрировались за ${segment.registeredWithinDays} дн.`);
  if (segment.activeWithinDays !== undefined) lines.push(`заходили за ${segment.activeWithinDays} дн.`);
  if (segment.inactiveForDays !== undefined) lines.push(`не заходят ${segment.inactiveForDays} дн. и дольше`);
  if (segment.skipRecentDays > 0) lines.push(`без получавших рассылку за ${segment.skipRecentDays} дн.`);
  return lines.length === 0 ? ["все, кому можно писать"] : lines;
}

/** Исход теста себе — что делать человеку дальше. */
export function outcomeText(outcome: SendOutcome): string {
  switch (outcome.status) {
    case "sent":
      return "Отправлено — проверьте чат с ботом";
    case "blocked":
      return "Бот не может вам написать — откройте чат с ботом и нажмите «Старт»";
    case "retry":
      return `Telegram просит подождать ${outcome.afterSec} с`;
    case "failed":
      return `Не отправлено: код ${outcome.reason}`;
  }
}

/** Доля доставленных от набранных, целыми процентами; без аудитории — `null`. */
export function deliveredShare(stats: DeliveryStats): number | null {
  const total = stats.queued + stats.sent + stats.blocked + stats.failed;
  return total === 0 ? null : Math.round((stats.sent / total) * 100);
}
