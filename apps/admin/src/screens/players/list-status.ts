import type { PlayerListItem } from "../../api/player-list";

export interface StatusBadge {
  tone: "danger" | "warning";
  text: string;
}

/**
 * Бейджи столбца «Статус». Пусто — у игрока нет ни блокировки, ни ограничений:
 * экран тогда не рисует ничего, и карточка на телефоне не показывает подпись
 * без значения.
 */
export function statusBadges(player: Pick<PlayerListItem, "banned" | "restrictions">, kindTitle: (kind: string) => string): StatusBadge[] {
  const limited = player.restrictions.filter((kind) => kind !== "all");
  return [
    ...(player.banned === null ? [] : [{ tone: "danger" as const, text: "заблокирован" }]),
    ...(limited.length === 0 ? [] : [{ tone: "warning" as const, text: `закрыто: ${limited.map(kindTitle).join(", ")}` }]),
  ];
}
