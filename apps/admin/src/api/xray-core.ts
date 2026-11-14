import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Ядро Xray (`/admin/xray-core`, docs/35-stage4-plan.md Р202, tasks/T-0416,
 * tasks/T-0418): запущенная версия, свежий выпуск XTLS, совместимость обеих с
 * нашим конфигом и запуск обновления. Совместимость и «можно ли нажать» решает
 * сервер, панель их только переводит в слова. Незнакомые коды (`kind`,
 * `blockedBy`) не роняют разбор: новый сервер с новым кодом показывается кодом
 * как есть, а не пустым экраном.
 */

const ROOT = "/xray-core";

const compatibilitySchema = z.union([
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tested") }),
    z.object({ kind: z.literal("untested") }),
    z.object({ kind: z.literal("older") }),
    z.object({ kind: z.literal("blocked"), reason: z.string() }),
    z.object({ kind: z.literal("unknown") }),
  ]),
  // Незнакомый вид совместимости — как есть, без причины.
  z.object({ kind: z.string() }),
]);
export type XrayCompatibility = z.infer<typeof compatibilitySchema>;

const lastRunSchema = z.object({
  status: z.string(),
  /** идёт любой запуск, кроме завершённого */
  active: z.boolean(),
  conclusion: z.string().nullable(),
  url: z.string(),
  createdAt: z.string(),
  title: z.string(),
});
export type XrayLastRun = z.infer<typeof lastRunSchema>;

export const xrayCoreSchema = z.object({
  running: z.object({
    state: z.enum(["ok", "missing", "unreadable"]),
    version: z.string().nullable(),
    startedAt: z.string().nullable(),
    compatibility: compatibilitySchema.nullable(),
  }),
  tested: z.object({ min: z.string(), max: z.string() }),
  latest: z
    .object({
      version: z.string(),
      publishedAt: z.string().nullable(),
      url: z.string(),
      checkedAt: z.string(),
      compatibility: compatibilitySchema,
    })
    .nullable(),
  latestError: z.string().nullable(),
  update: z.object({
    /** задан ли ключ `github.xray-update` */
    configured: z.boolean(),
    /** первая причина закрытой кнопки; код читает `blockedText`, незнакомый — показывается как есть */
    blockedBy: z.string().nullable(),
    lastRun: lastRunSchema.nullable(),
    lastRunError: z.string().nullable(),
    lockedUntil: z.string().nullable(),
  }),
});
export type XrayCoreView = z.infer<typeof xrayCoreSchema>;

export function fetchXrayCore(api: AdminApi): Promise<ApiResult<XrayCoreView>> {
  return api.request(ROOT, { schema: xrayCoreSchema });
}

/** «Проверить сейчас»: мимо кэша выпуска, чаще раза в минуту сервер откажет. */
export function refreshXrayCore(api: AdminApi): Promise<ApiResult<XrayCoreView>> {
  return api.request(`${ROOT}/refresh`, { method: "POST", schema: xrayCoreSchema, timeoutMs: 15_000 });
}

/** Запуск обновления: версия — подтверждение, сервер запустит только ту, что у него в кэше. */
export function updateXrayCore(api: AdminApi, version: string): Promise<ApiResult<XrayCoreView>> {
  return api.request(`${ROOT}/update`, { method: "POST", body: { version }, schema: xrayCoreSchema, timeoutMs: 20_000 });
}
