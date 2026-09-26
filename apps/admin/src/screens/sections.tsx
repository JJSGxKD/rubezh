import type { ReactNode } from "react";
import { DiagnosticsScreen } from "./diagnostics/DiagnosticsScreen";
import { ExportsScreen } from "./exports/ExportsScreen";
import { FunnelScreen } from "./funnel/FunnelScreen";
import { FlagsScreen } from "./flags/FlagsScreen";
import { FxScreen } from "./fx/FxScreen";
import { LinksScreen } from "./links/LinksScreen";
import { PlayersScreen } from "./players/PlayersScreen";
import { ReviewScreen } from "./review/ReviewScreen";
import { AuditScreen } from "./roles/AuditScreen";
import { RolesScreen } from "./roles/RolesScreen";

/**
 * Экраны разделов по идентификатору из `SECTIONS` (routes.ts). `id` —
 * объект раздела из адреса: игрок, отчёт; `null` — список.
 */
export const SECTION_SCREENS: Record<string, (id: string | null) => ReactNode> = {
  players: (id) => <PlayersScreen id={id} />,
  review: () => <ReviewScreen />,
  funnel: () => <FunnelScreen />,
  roles: () => <RolesScreen />,
  audit: () => <AuditScreen />,
  fx: () => <FxScreen />,
  diagnostics: (id) => <DiagnosticsScreen id={id} />,
  exports: () => <ExportsScreen />,
  links: () => <LinksScreen />,
  flags: () => <FlagsScreen />,
};
