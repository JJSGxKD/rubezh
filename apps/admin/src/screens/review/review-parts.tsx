import { BOARD_MARK_LABEL } from "../../api/overview";
import type { ReviewRow } from "../../api/review";
import { Badge } from "../../ui/kit";

/**
 * Светлая метка рядом с игроком: аккаунт под видом «Отдельная доска» (T-0115).
 * Сервер присылает `boardMarked` только держателю права; у остальных поля нет и
 * метки нет — разбор выглядит как раньше.
 */
export function BoardMarkBadge({ run }: { run: ReviewRow }) {
  return run.boardMarked === true ? <Badge>{BOARD_MARK_LABEL}</Badge> : null;
}
