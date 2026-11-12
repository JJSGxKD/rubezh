/**
 * Задания, о выполнении которых сообщает клиент площадки (docs/35-stage4-plan.md
 * Р187, T-0375): «Добавьте игру на главный экран» и «Поделитесь историей с
 * игрой». Сервер проверить такое действие не может — о нём знает только
 * клиент, и он присылает сигнал отдельным запросом.
 *
 * Срок закреплён за видом: главный экран добавляют однажды (достижение), историей
 * делятся раз в неделю. Без Nest и Prisma — правила читает и схема каталога.
 */
export const CLIENT_KINDS = {
  /** игру добавили на главный экран: событие площадки «добавлено» */
  home_screen: { period: "achievement" },
  /** открыт редактор истории с нашей картинкой и ссылкой: вышла ли история, площадка не сообщает */
  story_share: { period: "weekly" },
} as const;

export type ClientKind = keyof typeof CLIENT_KINDS;

export function isClientKind(kind: string): kind is ClientKind {
  return Object.hasOwn(CLIENT_KINDS, kind);
}

/** Лимит маршрута сигнала: на игрока, в час. */
export const SIGNAL_LIMIT = { scope: "tasks_signal", limit: 20, windowSec: 3600 } as const;
