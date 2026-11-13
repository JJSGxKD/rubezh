import { LedgerCursorInvalidError } from "./ledger-errors.js";

/**
 * Курсор страницы журнала — пара `(at, entry_id)` последней показанной проводки: время одно у многих проводок
 * (платежи одной секунды), и без второго ключа страница теряла бы или повторяла их на границе. Снаружи курсор —
 * непрозрачная строка из знаков base64url, клиент её не разбирает.
 */

export interface JournalCursor {
  at: Date;
  entryId: string;
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
const MAX_CURSOR_LENGTH = 256;

export function encodeCursor(cursor: JournalCursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.entryId}`, "utf8").toString("base64url");
}

/** Чужая, испорченная или устаревшая строка — `LedgerCursorInvalidError`, а не страница с мусорным условием. */
export function decodeCursor(text: string): JournalCursor {
  if (text.length === 0 || text.length > MAX_CURSOR_LENGTH) throw new LedgerCursorInvalidError();
  const match = CURSOR_RE.exec(Buffer.from(text, "base64url").toString("utf8"));
  const stamp = match?.[1];
  const entryId = match?.[2];
  if (stamp === undefined || entryId === undefined) throw new LedgerCursorInvalidError();
  const at = new Date(stamp);
  if (Number.isNaN(at.getTime())) throw new LedgerCursorInvalidError();
  return { at, entryId };
}
