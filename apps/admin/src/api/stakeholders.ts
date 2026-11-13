import { z } from "zod";
import { can, type SessionView } from "../state/session";
import type { AdminApi, ApiResult } from "./client";

/**
 * Участники проекта и их доли (`/admin/stakeholders`, docs/35-stage4-plan.md Р217, tasks/T-0452).
 * Схема повторяет `StakeholdersView` сервера; лишние поля не ломают разбор, а причина и автор правки
 * необязательны — участнику сервер их не отдаёт.
 */
const standingSchema = z.object({ sharePercent: z.number(), fromMonth: z.string() });

const historyEntrySchema = z.object({
  sharePercent: z.number(),
  fromMonth: z.string(),
  note: z.string().optional(),
  setBy: z.string().optional(),
  setAt: z.string(),
});

const participantSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  hasRole: z.boolean(),
  current: standingSchema.nullable(),
  next: standingSchema.nullable(),
  history: z.array(historyEntrySchema),
});

export const stakeholdersViewSchema = z.object({
  month: z.string(),
  participants: z.array(participantSchema),
  ownerSharePercent: z.number(),
});

export type StakeholdersView = z.infer<typeof stakeholdersViewSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type ShareHistoryEntry = z.infer<typeof historyEntrySchema>;

export interface ShareInput {
  sharePercent: number;
  /** `ГГГГ-ММ` */
  fromMonth: string;
  note: string;
}

export function loadStakeholders(api: AdminApi): Promise<ApiResult<StakeholdersView>> {
  return api.request("/stakeholders", { schema: stakeholdersViewSchema });
}

export function setShare(api: AdminApi, accountId: string, input: ShareInput): Promise<ApiResult<StakeholdersView>> {
  return api.request(`/stakeholders/${encodeURIComponent(accountId)}/share`, { method: "PUT", body: input, schema: stakeholdersViewSchema });
}

/** Кнопка «Изменить долю» — только владельцу: право `stakeholders.manage`. */
export function canManageShares(view: SessionView): boolean {
  return can(view, "stakeholders.manage");
}

/** Можно ли выдать роль «Участник проекта»: ссылка на «Роли» в пустом состоянии. */
export function canAssignRoles(view: SessionView): boolean {
  return can(view, "roles.assign");
}

const MONTH_NAMES = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;

/** `2026-11` → «ноябрь 2026». */
export function monthLabel(month: string): string {
  const [year = "", mm = "1"] = month.split("-");
  return `${MONTH_NAMES[Number(mm) - 1] ?? mm} ${year}`;
}

const MONTH_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;

/** `2026-12` → «декабря 2026»: для оборота «с …». */
export function monthFrom(month: string): string {
  const [year = "", mm = "1"] = month.split("-");
  return `${MONTH_GENITIVE[Number(mm) - 1] ?? mm} ${year}`;
}

/** Месяц окна «Изменить долю»: текущий и 12 следующих. */
export function monthOptions(current: string): { value: string; label: string }[] {
  const [year = 0, mm = 1] = current.split("-").map(Number);
  return Array.from({ length: 13 }, (_, index) => {
    const total = year * 12 + (mm - 1) + index;
    const value = `${String(Math.floor(total / 12))}-${String((total % 12) + 1).padStart(2, "0")}`;
    return { value, label: monthLabel(value) };
  });
}

/** Доля на месяц: последняя запись с месяцем не позже заданного; записей нет — 0. */
export function shareAtMonth(history: readonly Pick<ShareHistoryEntry, "sharePercent" | "fromMonth">[], month: string): number {
  let best: Pick<ShareHistoryEntry, "sharePercent" | "fromMonth"> | null = null;
  for (const entry of history) {
    if (entry.fromMonth <= month && (best === null || entry.fromMonth > best.fromMonth)) best = entry;
  }
  return best?.sharePercent ?? 0;
}

/** Без хвоста float: 100 − 30 − 12,34 даёт 57,66, а не 57,66000000000001. */
const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Что получится, если назначить долю с месяца: остаток владельцу и причина отказа до отправки. Чистая функция
 * по данным экрана — сервер всё равно перепроверит сумму на любой месяц.
 */
export function shareProblem(view: StakeholdersView, accountId: string, percent: number, month: string): { ownerLeft: number; problem: string | null } {
  let total = 0;
  for (const participant of view.participants) {
    total += participant.accountId === accountId ? percent : shareAtMonth(participant.history, month);
  }
  const ownerLeft = round2(100 - total);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return { ownerLeft, problem: "Доля — число от 0 до 100" };
  if (round2(percent) !== percent) return { ownerLeft, problem: "Доля — не больше двух знаков после запятой" };
  if (ownerLeft < 0) return { ownerLeft, problem: `Сумма долей дала бы ${String(round2(total))} % — больше 100 %` };
  return { ownerLeft, problem: null };
}

/** Строка последствий в подтверждении. */
export function consequenceText(name: string, percent: number, month: string): string {
  const label = monthFrom(month);
  return percent === 0 ? `С ${label} ${name} больше не получает долю.` : `С ${label} доля ${name} — ${String(percent).replace(".", ",")} %. Прошлые месяцы не меняются.`;
}
