import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Партнёры (`/admin/partners`, docs/35-stage4-plan.md WP41, часть 2): кто
 * приводит игроков своими промокодами и что эти игроки принесли. Смотрят под
 * `partners.view`, заводят и правят под `partners.edit`.
 */

const statsSchema = z.object({
  codes: z.number(),
  activeCodes: z.number(),
  redeemed: z.number(),
  bound: z.number(),
  played: z.number(),
  payers: z.number(),
  stars: z.number(),
});
export type PartnerStats = z.infer<typeof statsSchema>;

const partnerSchema = z.object({
  partnerId: z.string(),
  name: z.string(),
  contact: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stats: statsSchema,
});
export type Partner = z.infer<typeof partnerSchema>;

const rulesSchema = z.object({ bindWindowDays: z.number() });

const catalogSchema = z.object({ partners: z.array(partnerSchema), rules: rulesSchema });
export type PartnerCatalog = z.infer<typeof catalogSchema>;

const detailSchema = z.object({
  partner: partnerSchema,
  daily: z.array(z.object({ day: z.string(), count: z.number() })),
  codes: z.array(
    z.object({
      campaignId: z.string(),
      title: z.string(),
      kind: z.enum(["shared", "batch"]),
      codeSample: z.string(),
      redeemed: z.number(),
      maxRedemptions: z.number().nullable(),
      startsAt: z.string(),
      endsAt: z.string().nullable(),
      pausedAt: z.string().nullable(),
      bound: z.number(),
      state: z.string(),
    }),
  ),
  rules: rulesSchema,
});
export type PartnerDetail = z.infer<typeof detailSchema>;

export interface PartnerForm {
  name: string;
  contact: string;
  note: string;
}

export const PARTNER_LIMITS = { nameMin: 2, nameMax: 80, contactMax: 120, noteMax: 500 } as const;

export const partnerFormSchema = z.object({
  name: z.string().trim().min(PARTNER_LIMITS.nameMin, "Как команда зовёт партнёра: «Канал „Игровой угол“»").max(PARTNER_LIMITS.nameMax, `Не длиннее ${String(PARTNER_LIMITS.nameMax)} знаков`),
  contact: z.string().trim().max(PARTNER_LIMITS.contactMax, `Не длиннее ${String(PARTNER_LIMITS.contactMax)} знаков`),
  note: z.string().trim().max(PARTNER_LIMITS.noteMax, `Не длиннее ${String(PARTNER_LIMITS.noteMax)} знаков`),
});

export function emptyPartnerForm(): PartnerForm {
  return { name: "", contact: "", note: "" };
}

export function partnerFormOf(partner: Partner): PartnerForm {
  return { name: partner.name, contact: partner.contact ?? "", note: partner.note ?? "" };
}

function bodyOf(form: PartnerForm): { name: string; contact: string | null; note: string | null } {
  const optional = (value: string) => (value.trim() === "" ? null : value.trim());
  return { name: form.name.trim(), contact: optional(form.contact), note: optional(form.note) };
}

export function fetchPartners(api: AdminApi): Promise<ApiResult<PartnerCatalog>> {
  return api.request("/partners", { schema: catalogSchema });
}

export function fetchPartner(api: AdminApi, partnerId: string): Promise<ApiResult<PartnerDetail>> {
  return api.request(`/partners/${encodeURIComponent(partnerId)}`, { schema: detailSchema });
}

export function createPartner(api: AdminApi, form: PartnerForm): Promise<ApiResult<Partner>> {
  return api.request("/partners", { method: "POST", body: bodyOf(form), schema: partnerSchema });
}

export function updatePartner(api: AdminApi, partnerId: string, form: PartnerForm): Promise<ApiResult<Partner>> {
  return api.request(`/partners/${encodeURIComponent(partnerId)}`, { method: "POST", body: bodyOf(form), schema: partnerSchema });
}

/** Доля от числа словами для таблицы: «12 · 40%»; от нуля — прочерк, а не «NaN%». */
export function share(part: number, whole: number): string {
  return whole === 0 ? "—" : `${String(Math.round((part / whole) * 100))}%`;
}

/** Маршрут мастера промокода с выбранным партнёром: `#/promo-codes/partner:<id>`. */
export const PARTNER_CODE_ROUTE = "partner:";

export function partnerOfRoute(id: string | null): string | null {
  return id !== null && id.startsWith(PARTNER_CODE_ROUTE) ? id.slice(PARTNER_CODE_ROUTE.length) : null;
}
