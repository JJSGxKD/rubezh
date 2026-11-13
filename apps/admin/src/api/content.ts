import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Версии и черновики контента игры (`/admin/content`, docs/19-content-admin.md
 * §3, tasks/T-0303): читать — `content.view`, править — `content.edit`.
 *
 * Снимок приходит как `unknown`: форму его разделов проверяет экран баланса
 * своей схемой (`screens/balance/balance-snapshot.ts`) — этому клиенту нужны
 * только версии, черновики и итог правки.
 */

const ADMIN_CONTENT = "/content";

const dateText = z.string().min(1);

export const versionSummarySchema = z.object({
  versionNo: z.number().int(),
  contentHash: z.string(),
  schemaVersion: z.number().int(),
  source: z.string(),
  createdBy: z.string().nullable(),
  createdAt: dateText,
  publishedAt: dateText.nullable(),
});
export type VersionSummary = z.infer<typeof versionSummarySchema>;

const versionSchema = versionSummarySchema.extend({
  snapshot: z.unknown(),
  names: z.record(z.string(), z.string()),
});
export type ContentVersion = z.infer<typeof versionSchema>;

export const draftSummarySchema = z.object({
  draftId: z.string(),
  baseVersionNo: z.number().int(),
  title: z.string(),
  /** идентификатор аккаунта: имени в ответе сервера нет */
  author: z.string(),
  updatedAt: dateText,
  archivedAt: dateText.nullable(),
});
export type DraftSummary = z.infer<typeof draftSummarySchema>;

const draftViewSchema = draftSummarySchema.extend({ snapshotHash: z.string() });

const draftDetailSchema = draftViewSchema.extend({
  snapshot: z.unknown(),
  lastCheck: z.object({ checkId: z.string(), status: z.string(), snapshotHash: z.string(), createdAt: dateText }).nullable(),
});
export type DraftDetail = z.infer<typeof draftDetailSchema>;

const patchResultSchema = z.object({
  draftId: z.string(),
  path: z.string(),
  from: z.unknown(),
  to: z.unknown(),
  /** `false` — значение то же, сервер ничего не записал */
  changed: z.boolean(),
  snapshotHash: z.string(),
  updatedAt: dateText,
});
export type PatchResult = z.infer<typeof patchResultSchema>;

/** Одна правка черновика против версии-основы. `null` в `from` — поля в основе не было. */
export interface DraftChange {
  path: string;
  from: unknown;
  to: unknown;
}

const diffSchema = z.object({
  baseVersionNo: z.number().int(),
  changes: z.array(z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })),
  /** отличий больше предела сервера: перечислены первые */
  truncated: z.boolean(),
});
export type DraftDiff = z.infer<typeof diffSchema>;

export function fetchVersions(api: AdminApi): Promise<ApiResult<VersionSummary[]>> {
  return api.request(`${ADMIN_CONTENT}/versions`, { schema: z.array(versionSummarySchema) });
}

export function fetchVersion(api: AdminApi, versionNo: number): Promise<ApiResult<ContentVersion>> {
  return api.request(`${ADMIN_CONTENT}/versions/${String(versionNo)}`, { schema: versionSchema });
}

/** Последняя заведённая версия: от неё создаются черновики. Что в игре сейчас, говорят указатели (`fetchCurrent`). */
export function latestVersion(versions: readonly VersionSummary[]): VersionSummary | null {
  let latest: VersionSummary | null = null;
  for (const version of versions) {
    if (latest === null || version.versionNo > latest.versionNo) latest = version;
  }
  return latest;
}

/** Открытые черновики; архивные панели не нужны. */
export function fetchDrafts(api: AdminApi): Promise<ApiResult<DraftSummary[]>> {
  return api.request(`${ADMIN_CONTENT}/drafts`, { schema: z.array(draftSummarySchema) });
}

/** Черновик — копия снимка последней версии; номер основы сервер берёт сам. */
export function createDraft(api: AdminApi, title: string): Promise<ApiResult<z.infer<typeof draftViewSchema>>> {
  return api.request(`${ADMIN_CONTENT}/drafts`, { method: "POST", body: { title: title.trim() }, schema: draftViewSchema });
}

export function fetchDraft(api: AdminApi, draftId: string): Promise<ApiResult<DraftDetail>> {
  return api.request(`${ADMIN_CONTENT}/drafts/${encodeURIComponent(draftId)}`, { schema: draftDetailSchema });
}

/**
 * Правка по пути: сразу, без кнопки «сохранить». Не та форма — 422, и в
 * клиенте это отказ формы (`rejected`) с текстом сервера: черновик не изменился.
 */
export function patchDraft(api: AdminApi, draftId: string, path: string, value: unknown): Promise<ApiResult<PatchResult>> {
  return api.request(`${ADMIN_CONTENT}/drafts/${encodeURIComponent(draftId)}`, { method: "PATCH", body: { path, value }, schema: patchResultSchema });
}

export function fetchDiff(api: AdminApi, draftId: string): Promise<ApiResult<DraftDiff>> {
  return api.request(`${ADMIN_CONTENT}/drafts/${encodeURIComponent(draftId)}/diff`, { schema: diffSchema });
}

/** Статусы проверки: `queued` — ещё считается, остальные — конец (tasks/T-0303). */
export const checkStatusSchema = z.enum(["queued", "done", "failed", "timeout"]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

const checkViewSchema = z.object({
  checkId: z.string(),
  draftId: z.string(),
  /** хэш снимка, который проверяли: сменился хэш черновика — прогон устарел */
  snapshotHash: z.string(),
  status: checkStatusSchema,
  /** итог воркера как есть: форму разбирает экран проверки (`screens/balance/check`) */
  report: z.unknown(),
  createdAt: dateText,
});
export type CheckView = z.infer<typeof checkViewSchema>;

const startedCheckSchema = z.object({ check: checkViewSchema, reused: z.boolean() });
export type StartedCheck = z.infer<typeof startedCheckSchema>;

/** Поставить проверку черновика: тот же снимок, что уже считали, отдаёт прошлый итог. */
export function startCheck(api: AdminApi, draftId: string): Promise<ApiResult<StartedCheck>> {
  return api.request(`${ADMIN_CONTENT}/drafts/${encodeURIComponent(draftId)}/check`, { method: "POST", body: {}, schema: startedCheckSchema });
}

export function fetchCheck(api: AdminApi, checkId: string): Promise<ApiResult<CheckView>> {
  return api.request(`${ADMIN_CONTENT}/checks/${encodeURIComponent(checkId)}`, { schema: checkViewSchema });
}

// ---------------------------------------------------------------------------
// Публикация, откат и «Взять из кода» (tasks/T-0306; право content.publish)
// ---------------------------------------------------------------------------

/** Аудитория версии: «Команде» — аккаунты с ролью, смотрят глазами до игроков; «Всем» — все. */
export type Audience = "team" | "all";

const pointerSchema = z.object({
  versionNo: z.number().int(),
  /** идентификатор аккаунта; `null` — версию поставил выкат */
  setBy: z.string().nullable(),
  setAt: dateText,
});
export type Pointer = z.infer<typeof pointerSchema>;

/** Какая версия в игре. Нет `team` — команда играет версией «всем»; нет `all` — ничего не публиковалось. */
const currentPointersSchema = z.object({ team: pointerSchema.nullable(), all: pointerSchema.nullable() });
export type CurrentPointers = z.infer<typeof currentPointersSchema>;

const publicationPreviewSchema = z.object({
  audience: z.enum(["team", "all"]),
  /** версия, которая у аудитории в игре; `null` — играют встроенным контентом */
  liveVersionNo: z.number().int().nullable(),
  alreadyLive: z.boolean(),
  onTeam: z.boolean(),
  ready: z.boolean(),
  reason: z.string().nullable(),
  changes: z.array(z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })),
  truncated: z.boolean(),
});
export type PublicationPreview = z.infer<typeof publicationPreviewSchema>;

const publishResultSchema = z.object({
  audience: z.enum(["team", "all"]),
  versionNo: z.number().int(),
  contentHash: z.string(),
  created: z.boolean(),
  changed: z.boolean(),
  previousVersionNo: z.number().int().nullable(),
});
export type PublishResult = z.infer<typeof publishResultSchema>;

const rollbackResultSchema = z.object({
  audience: z.enum(["team", "all"]),
  versionNo: z.number().int(),
  previousVersionNo: z.number().int().nullable(),
  changed: z.boolean(),
});
export type RollbackResult = z.infer<typeof rollbackResultSchema>;

const mergeResultSchema = z.object({
  baseVersionNo: z.number().int(),
  fromVersionNo: z.number().int(),
  added: z.number().int(),
  changed: z.boolean(),
  snapshotHash: z.string(),
});
export type MergeResult = z.infer<typeof mergeResultSchema>;

export function fetchCurrent(api: AdminApi): Promise<ApiResult<CurrentPointers>> {
  return api.request(`${ADMIN_CONTENT}/current`, { schema: currentPointersSchema });
}

/** Готовность черновика к публикации и правки против версии, которая в игре у аудитории. */
export function fetchPublication(api: AdminApi, draftId: string, audience: Audience): Promise<ApiResult<PublicationPreview>> {
  return api.request(`${ADMIN_CONTENT}/drafts/${encodeURIComponent(draftId)}/publication`, { query: { audience }, schema: publicationPreviewSchema });
}

/** Опубликовать черновик. Нет свежей зелёной проверки — 409 `content_check_required` с причиной в тексте. */
export function publishDraft(api: AdminApi, draftId: string, audience: Audience): Promise<ApiResult<PublishResult>> {
  return api.request(`${ADMIN_CONTENT}/drafts/${encodeURIComponent(draftId)}/publish`, { method: "POST", body: { audience }, schema: publishResultSchema });
}

/** Откат: указатель аудитории на версию, что уже бывала в игре. Новой версии не заводит. */
export function rollbackTo(api: AdminApi, audience: Audience, versionNo: number): Promise<ApiResult<RollbackResult>> {
  return api.request(`${ADMIN_CONTENT}/rollback`, { method: "POST", body: { audience, versionNo }, schema: rollbackResultSchema });
}

/** «Взять из кода»: новые понятия и поля версии из кода дописываются в черновик, значения черновика не меняются. */
export function mergeFromCode(api: AdminApi, draftId: string, versionNo: number): Promise<ApiResult<MergeResult>> {
  return api.request(`${ADMIN_CONTENT}/drafts/${encodeURIComponent(draftId)}/merge-code`, { method: "POST", body: { versionNo }, schema: mergeResultSchema });
}
