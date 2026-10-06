import { z } from "zod";
import type { AdminApi, ApiResult } from "./client";

/**
 * Ключи интеграций (`/admin/secrets`, docs/35-stage4-plan.md Р84, WP46):
 * токены внешних сервисов. Значение сервер не отдаёт никогда — только
 * последние знаки, откуда ключ и кто его менял.
 */

export const secretSchema = z.object({
  key: z.string(),
  service: z.string(),
  title: z.string(),
  hint: z.string(),
  cabinetUrl: z.string().nullable(),
  example: z.string(),
  pattern: z.string(),
  checkable: z.boolean(),
  /** куда вставить ключ, который создаёт сервер; `null` — ключ берут в кабинете сервиса */
  generated: z.string().nullable(),
  source: z.enum(["base", "env", "none"]),
  fingerprint: z.string().nullable(),
  envSet: z.boolean(),
  unreadable: z.boolean(),
  updatedBy: z.string().nullable(),
  updatedByName: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export type SecretRow = z.infer<typeof secretSchema>;

const overviewSchema = z.object({ enabled: z.boolean(), secrets: z.array(secretSchema) });
export type SecretsOverview = z.infer<typeof overviewSchema>;

const checkSchema = z.object({ ok: z.boolean(), message: z.string() });

/** Созданный ключ: что вставить в кабинет — один раз; `absolute: false` — начало адреса дописать самому. */
const generatedSchema = z.object({ secret: secretSchema, reveal: z.string(), absolute: z.boolean() });
export type GeneratedSecret = z.infer<typeof generatedSchema>;
export type SecretCheck = z.infer<typeof checkSchema>;

export function fetchSecrets(api: AdminApi): Promise<ApiResult<SecretsOverview>> {
  return api.request("/secrets", { schema: overviewSchema });
}

export function saveSecret(api: AdminApi, key: string, value: string): Promise<ApiResult<SecretRow>> {
  return api.request(`/secrets/${encodeURIComponent(key)}`, { method: "POST", body: { value: value.trim() }, schema: secretSchema });
}

/** Новый ключ, который создаёт сервер, — прежний перестаёт работать сразу. */
export function generateSecret(api: AdminApi, key: string): Promise<ApiResult<GeneratedSecret>> {
  return api.request(`/secrets/${encodeURIComponent(key)}/generate`, { method: "POST", schema: generatedSchema });
}

export function resetSecret(api: AdminApi, key: string): Promise<ApiResult<SecretRow>> {
  return api.request(`/secrets/${encodeURIComponent(key)}/reset`, { method: "POST", schema: secretSchema });
}

/** Проверка связи: без `value` — действующим ключом, с ним — ключом из формы, ещё не сохранённым. */
export function checkSecret(api: AdminApi, key: string, value: string | null): Promise<ApiResult<SecretCheck>> {
  return api.request(`/secrets/${encodeURIComponent(key)}/check`, { method: "POST", body: value === null ? {} : { value: value.trim() }, schema: checkSchema, timeoutMs: 20_000 });
}

/** Тот же предел, что на сервере: без пробелов и служебных знаков. */
const SECRET_TEXT = /^[\x21-\x7e]{1,512}$/;

/** Что не так с ключом; `null` — можно сохранять. Сервер проверит то же самое. */
export function secretProblem(row: Pick<SecretRow, "pattern" | "example" | "title">, value: string): string | null {
  const text = value.trim();
  if (text === "") return "Вставьте ключ";
  if (!SECRET_TEXT.test(text)) return "Ключ — без пробелов и переносов строки, до 512 знаков";
  return new RegExp(row.pattern).test(text) ? null : `${row.title} выглядит как «${row.example}»`;
}

/** Ключи по сервисам в порядке каталога. */
export function groupSecrets(rows: readonly SecretRow[]): { service: string; rows: SecretRow[] }[] {
  const groups: { service: string; rows: SecretRow[] }[] = [];
  for (const row of rows) {
    const found = groups.find((item) => item.service === row.service);
    if (found === undefined) groups.push({ service: row.service, rows: [row] });
    else found.rows.push(row);
  }
  return groups;
}

/** Состояние ключа словами — для значка и строки под ним. */
export function secretState(row: SecretRow): { tone: "info" | "neutral" | "danger"; label: string; detail: string } {
  if (row.unreadable) {
    return {
      tone: "danger",
      label: "Не расшифровывается",
      detail: row.envSet
        ? "Ключ из панели зашифрован другим ключом шифрования — сейчас работает ключ из окружения. Задайте ключ заново."
        : "Ключ из панели зашифрован другим ключом шифрования, а в окружении ключа нет — сервис работает без ключа. Задайте ключ заново.",
    };
  }
  if (row.generated !== null) {
    return row.source === "base"
      ? { tone: "info", label: "Создан", detail: `Новый адрес заменит этот сразу — вставьте его: ${row.generated}.` }
      : { tone: "neutral", label: "Не создан", detail: `Создайте адрес и вставьте его: ${row.generated}.` };
  }
  if (row.source === "base") {
    return { tone: "info", label: "Из панели", detail: row.envSet ? "В окружении сервера тоже есть ключ — «Сбросить» вернёт его." : "В окружении сервера ключа нет — после сброса сервис останется без ключа." };
  }
  if (row.source === "env") return { tone: "neutral", label: "Из окружения", detail: "Задан в .env сервера. Ключ из панели будет сильнее окружения." };
  return { tone: "neutral", label: "Не задан", detail: "Ни в панели, ни в окружении сервера ключа нет." };
}
