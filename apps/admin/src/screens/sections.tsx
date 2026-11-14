/// <reference types="vite/client" />
import { lazy, Suspense, type ReactNode } from "react";
import { AdsScreen } from "./ads/AdsScreen";
import { BalanceScreen } from "./balance/BalanceScreen";
import { BroadcastsScreen } from "./broadcasts/BroadcastsScreen";
import { CabinetScreen } from "./cabinet/CabinetScreen";
import { ChangelogScreen } from "./changelog/ChangelogScreen";
import { CspReportsScreen } from "./csp-reports/CspReportsScreen";
import { TasksSection } from "./tasks/CustomerReport";
import { DiagnosticsScreen } from "./diagnostics/DiagnosticsScreen";
import { ExportsScreen } from "./exports/ExportsScreen";
import { FunnelScreen } from "./funnel/FunnelScreen";
import { UiClicksScreen } from "./funnel/UiClicks";
import { FlagsScreen } from "./flags/FlagsScreen";
import { FxScreen } from "./fx/FxScreen";
import { HomeSlidesScreen } from "./home/HomeSlidesScreen";
import { LinksScreen } from "./links/LinksScreen";
import { NamesScreen } from "./names/NamesScreen";
import { OnlineScreen } from "./online";
import { OverviewScreen } from "./overview/OverviewScreen";
import { PartnersScreen } from "./partners/PartnersScreen";
import { PassScreen } from "./pass/PassScreen";
import { PaymentsScreen } from "./payments/PaymentsScreen";
import { PlayersScreen } from "./players/PlayersScreen";
import { PromoCodesScreen } from "./promo-codes/PromoCodesScreen";
import { PromosScreen } from "./promos/PromosScreen";
import { ProxiesScreen } from "./proxies/ProxiesScreen";
import { RatingScreen } from "./rating/RatingScreen";
import { RequestsScreen } from "./requests/RequestsScreen";
import { ReviewScreen } from "./review/ReviewScreen";
import { AuditScreen } from "./roles/AuditScreen";
import { RolesScreen } from "./roles/RolesScreen";
import { SecretsScreen } from "./secrets/SecretsScreen";
import { SettingsScreen } from "./settings/SettingsScreen";
import { LedgerScreen } from "./ledger/LedgerScreen";
import { MyProjectScreen } from "./my-project/MyProjectScreen";
import { StakeholdersScreen } from "./stakeholders/StakeholdersScreen";
import { Loading } from "../ui/kit";

// Витрины компонентов — только при разработке: в сборке условие ложно, и модуль в неё не попадает.
const DevStands = import.meta.env.DEV ? lazy(() => import("../promo-editor/DevStands")) : null;
const devScreens: Record<string, (id: string | null) => ReactNode> =
  DevStands === null ? {} : { dev: (id) => <Suspense fallback={<Loading />}><DevStands id={id} /></Suspense> };

/**
 * Экраны разделов по идентификатору из `SECTIONS` (routes.ts). `id` —
 * объект раздела из адреса: игрок, отчёт; `null` — список.
 */
export const SECTION_SCREENS: Record<string, (id: string | null, tab?: string) => ReactNode> = {
  overview: () => <OverviewScreen />,
  online: () => <OnlineScreen />,
  players: (id) => <PlayersScreen id={id} />,
  payments: (id) => <PaymentsScreen id={id} />,
  review: () => <ReviewScreen />,
  names: () => <NamesScreen />,
  funnel: (id) => <FunnelScreen focus={id} />,
  "ui-clicks": () => <UiClicksScreen />,
  roles: () => <RolesScreen />,
  audit: () => <AuditScreen />,
  fx: () => <FxScreen />,
  "my-project": () => <MyProjectScreen />,
  ledger: (id) => <LedgerScreen id={id} />,
  stakeholders: () => <StakeholdersScreen />,
  diagnostics: (id) => <DiagnosticsScreen id={id} />,
  csp: () => <CspReportsScreen />,
  requests: () => <RequestsScreen />,
  proxies: () => <ProxiesScreen />,
  exports: () => <ExportsScreen />,
  links: (id) => <LinksScreen id={id} />,
  flags: () => <FlagsScreen />,
  settings: (id) => <SettingsScreen focus={id} />,
  secrets: () => <SecretsScreen />,
  broadcasts: (id) => <BroadcastsScreen id={id} />,
  changelog: () => <ChangelogScreen />,
  home: () => <HomeSlidesScreen />,
  tasks: () => <TasksSection />,
  pass: () => <PassScreen />,
  balance: (id, tab) => <BalanceScreen id={id} tab={tab} />,
  rating: (id, tab) => <RatingScreen id={id} tab={tab} />,
  ads: () => <AdsScreen />,
  promos: () => <PromosScreen />,
  "promo-codes": (id) => <PromoCodesScreen id={id} />,
  partners: (id) => <PartnersScreen id={id} />,
  // Собственный кабинет партнёра; команда смотрит кабинет глазами партнёра из его карточки, а не по адресу.
  cabinet: () => <CabinetScreen partnerId={null} />,
  ...devScreens,
};
