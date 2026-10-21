import type { DueConversion } from "../conversions.repository.js";
import type { PostbackEvent } from "../postback-events.js";

/**
 * Назначения постбэков (tasks/T-0069, docs/35-stage4-plan.md Р86, Р96): куда
 * уходят события игры. Каждое назначение — адаптер: по конверсии он готовит
 * запрос или говорит, что отправка ждёт, невозможна или не прошла проверку.
 * Отправку, повторы, таймаут и запись в журнал делает сервис, поэтому новое
 * назначение не правит ни проход, ни `send`.
 */

export const DESTINATION_KINDS = ["adsgram", "s2s", "partner"] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

/** Назначение по значению из базы; чего нет в списке — ошибка: код этого релиза такой строки не отправит. */
export function destinationOf(value: string): DestinationKind {
  for (const kind of DESTINATION_KINDS) {
    if (kind === value) return kind;
  }
  throw new Error(`Неизвестное назначение постбэка: ${value}`);
}

/**
 * Причина пропуска, когда назначения нет в реестре или оно не принимает
 * событие. Название осталось от времён одной сети — тексты панели его знают.
 */
export const UNKNOWN_DESTINATION_REASON = "unknown_network";

/** Что назначение решило про одну отправку. */
export type Prepared =
  /**
   * Запрос готов. `logUrl` — тот же адрес без секретов: только он попадает в
   * лог. Срок ожидания ответа ставит сервис; свой `signal` в `init` можно
   * передать — он сработает вместе со сроком.
   */
  | { kind: "request"; url: URL; init?: RequestInit; logUrl: string }
  /** Ждёт настройки (нет токена): попытка не тратится, проверить снова через `recheckMin` минут. */
  | { kind: "wait"; reason: string; recheckMin: number }
  /** Отправить нельзя совсем; `reason` — до 32 знаков, его видно в журнале. */
  | { kind: "skip"; reason: string }
  /** Не прошло проверку; `retry` — повторить по расписанию, иначе сразу «не отправлена». `message` не содержит секретов. */
  | { kind: "fail"; message: string; retry: boolean };

export interface PostbackDestination {
  readonly kind: DestinationKind;
  /** События, которые назначение вообще умеет принимать. */
  readonly accepts: readonly PostbackEvent[];
  /** Секреты читаются здесь, в момент отправки: заданный в панели работает со следующего прохода. */
  prepare(conversion: DueConversion): Promise<Prepared>;
}

export const POSTBACK_DESTINATIONS = Symbol("POSTBACK_DESTINATIONS");
