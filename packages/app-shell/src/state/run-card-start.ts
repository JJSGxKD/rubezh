/**
 * Пара `run` в стартовом параметре Mini App: `run-<id забега>`
 * (tasks/T-0297, docs/24-attribution-and-sharing.md). По ней открывается
 * карточка рейтингового забега — ссылкой на неё можно поделиться. Отдельный
 * файл без React и словарей: навигация читает его в первой загрузке.
 */
const START_PREFIX = "run-";
/** Ключ забега — как у сервера (`runIdParamSchema`): от 8 до 64 знаков из алфавита стартового параметра Telegram. */
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function runCardStartParam(runId: string): string {
  return `${START_PREFIX}${runId}`;
}

/** Разбор: ключ забега из пары `run`; чужая пара и мусор — `null`, экран по ним не открывается. */
export function parseRunCardStart(param: string | null | undefined): string | null {
  if (param === null || param === undefined || !param.startsWith(START_PREFIX)) return null;
  const id = param.slice(START_PREFIX.length);
  return RUN_ID.test(id) ? id : null;
}
