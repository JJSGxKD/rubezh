import type { ReactNode } from "react";
import { PlayersScreen } from "./players/PlayersScreen";

/**
 * Экраны разделов по идентификатору из `SECTIONS` (routes.ts). `id` —
 * объект раздела из адреса: игрок, отчёт; `null` — список.
 */
export const SECTION_SCREENS: Record<string, (id: string | null) => ReactNode> = {
  players: (id) => <PlayersScreen id={id} />,
};
