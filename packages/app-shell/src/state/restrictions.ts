import { z } from "zod/mini";
import { create } from "zustand";
import { apiRequest, type ApiRequest, type ApiResult } from "./api-request";
import { useShell } from "./shell";

/**
 * Свои ограничения игрока (docs/35-stage4-plan.md WP44): что закрыто, до
 * какого числа и почему — для плашки там, где игрок упёрся, и для списка в
 * профиле. Молчаливые сервер сюда не присылает (О40): там игрок видит
 * нейтральное «недоступно», как при сбое.
 *
 * Список один на всю оболочку: экран, которому отказали, перечитывает его, и
 * плашка встаёт на место ошибки. Модуль грузится с первым экраном, которому
 * он нужен, — первой загрузке он ни к чему.
 */

const restrictionSchema = z.object({
  kind: z.string(),
  title: z.string(),
  endsAt: z.nullable(z.string()),
  /** срок словами от сервера — тем же кодом, что текст отказа и предпросмотр в панели */
  until: z.string(),
  reason: z.string(),
});

export type PlayerRestriction = z.infer<typeof restrictionSchema>;

const listSchema = z.object({ restrictions: z.array(restrictionSchema) });

/** Код отказа сервера: действие закрыто ограничением, о котором игроку сообщили. */
export const RESTRICTED_CODE = "account_restricted";

/**
 * Сколько список считается свежим. Экраны открывают один за другим, а
 * ограничение меняется редко: чаще спрашивать незачем, а отказ сервера
 * перечитывает список сразу.
 */
export const RESTRICTIONS_FRESH_MS = 60_000;

interface RestrictionsState {
  list: PlayerRestriction[];
  loadedAt: number | null;
}

export const useRestrictions = create<RestrictionsState>()(() => ({ list: [], loadedAt: null }));

export interface RestrictionsApi {
  mine(): Promise<ApiResult<{ restrictions: PlayerRestriction[] }>>;
}

/** `request` подменяется в тестах: сеть и сессия им не нужны. */
export function createRestrictionsApi(request: ApiRequest = apiRequest): RestrictionsApi {
  return { mine: () => request("/api/v1/me/restrictions", listSchema, { method: "GET" }) };
}

let pending: Promise<void> | null = null;

/**
 * Перечитать список: `force` — после отказа сервера, иначе — только
 * устаревший. Не ответил сервер — остаётся прежний: плашка, которую игрок
 * уже видел, не пропадает из-за моргнувшей сети.
 */
export function loadRestrictions(force = false, api?: RestrictionsApi, now = Date.now()): Promise<void> {
  if (api === undefined && useShell.getState().capabilities.auth === undefined) return Promise.resolve();
  const { loadedAt } = useRestrictions.getState();
  if (!force && loadedAt !== null && now - loadedAt < RESTRICTIONS_FRESH_MS) return Promise.resolve();
  pending ??= (api ?? createRestrictionsApi())
    .mine()
    .then((response) => {
      if (response.ok) useRestrictions.setState({ list: response.data.restrictions, loadedAt: now });
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Блокировка целиком закрывает и всё остальное — как и на сервере. */
const BAN_KIND = "all";

/**
 * Действующие из `kinds` и блокировка; `null` — все (список в профиле).
 * Вышедший после загрузки срок плашку уже не держит.
 */
export function activeOf(list: readonly PlayerRestriction[], kinds: readonly string[] | null, now: number): PlayerRestriction[] {
  return list.filter((row) => (kinds === null || kinds.includes(row.kind) || row.kind === BAN_KIND) && (row.endsAt === null || Date.parse(row.endsAt) > now));
}

/** Закрыто ли что-то из `kinds` — экран заранее гасит кнопку, а не ждёт отказа. */
export function useRestricted(kinds: readonly string[]): boolean {
  return useRestrictions((state) => activeOf(state.list, kinds, Date.now()).length > 0);
}

/**
 * Отказ из-за ограничения? Список перечитывается, и вместо «не получилось»
 * игрок видит плашку: что закрыто, до какого числа и почему. `lifted` —
 * пока шёл запрос, ограничение сняли или срок вышел: стоит просто повторить.
 * `null` — отказ не из-за ограничения.
 */
export async function restrictionRefusal(result: ApiResult<unknown>, kinds: readonly string[], api?: RestrictionsApi): Promise<"restricted" | "lifted" | null> {
  if (result.ok || result.code !== RESTRICTED_CODE) return null;
  return await recheckRestriction(kinds, api);
}

/** Сервер сказал «закрыто» не ошибкой, а исходом (выдача рекламы): перечитать список и проверить. */
export async function recheckRestriction(kinds: readonly string[], api?: RestrictionsApi): Promise<"restricted" | "lifted"> {
  await loadRestrictions(true, api);
  return activeOf(useRestrictions.getState().list, kinds, Date.now()).length > 0 ? "restricted" : "lifted";
}
