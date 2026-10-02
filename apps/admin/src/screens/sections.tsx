import type { ReactNode } from "react";
import { AdsScreen } from "./ads/AdsScreen";
import { BroadcastsScreen } from "./broadcasts/BroadcastsScreen";
import { ChangelogScreen } from "./changelog/ChangelogScreen";
import { TasksScreen } from "./tasks/TasksScreen";
import { DiagnosticsScreen } from "./diagnostics/DiagnosticsScreen";
import { ExportsScreen } from "./exports/ExportsScreen";
import { FunnelScreen } from "./funnel/FunnelScreen";
import { FlagsScreen } from "./flags/FlagsScreen";
import { FxScreen } from "./fx/FxScreen";
import { LinksScreen } from "./links/LinksScreen";
import { OverviewScreen } from "./overview/OverviewScreen";
import { PartnersScreen } from "./partners/PartnersScreen";
import { PlayersScreen } from "./players/PlayersScreen";
import { PromoCodesScreen } from "./promo-codes/PromoCodesScreen";
import { PromosScreen } from "./promos/PromosScreen";
import { ReviewScreen } from "./review/ReviewScreen";
import { AuditScreen } from "./roles/AuditScreen";
import { RolesScreen } from "./roles/RolesScreen";
import { SecretsScreen } from "./secrets/SecretsScreen";
import { SettingsScreen } from "./settings/SettingsScreen";

/**
 * Экраны разделов по идентификатору из `SECTIONS` (routes.ts). `id` —
 * объект раздела из адреса: игрок, отчёт; `null` — список.
 */
export const SECTION_SCREENS: Record<string, (id: string | null) => ReactNode> = {
  overview: () => <OverviewScreen />,
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
  settings: (id) => <SettingsScreen focus={id} />,
  secrets: () => <SecretsScreen />,
  broadcasts: (id) => <BroadcastsScreen id={id} />,
  changelog: () => <ChangelogScreen />,
  tasks: () => <TasksScreen />,
  ads: () => <AdsScreen />,
  promos: () => <PromosScreen />,
  "promo-codes": (id) => <PromoCodesScreen id={id} />,
  partners: (id) => <PartnersScreen id={id} />,
};
