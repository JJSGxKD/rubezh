import { useEffect, type ReactNode } from "react";
import { Gift, Home, Swords, Trophy, Users } from "lucide-react";
import { ScreenTransition, TabBar, type TabItem } from "../design-system/components";
import { t } from "../i18n";
import { useInstall } from "../state/install";
import {
  activeTab,
  canGoBack,
  currentScreen,
  useNavigation,
  type ScreenId,
} from "../state/navigation";
import { usePlatform } from "../state/platform";
import { useRun } from "../state/run";
import { useShell } from "../state/shell";
import { CompactScreen, FirstRunScreen, OutsideScreen } from "../screens/gates";
import { LobbyScreen, ModeScreen, WeaponScreen } from "../screens/home";
import {
  ArsenalScreen,
  FriendsScreen,
  ProfileScreen,
  RatingScreen,
  ShopScreen,
  TasksScreen,
} from "../screens/stubs";
import { AboutScreen, DiagnosticsScreen, SettingsScreen, TestersScreen } from "../screens/settings";
import { GalleryScreen } from "../screens/gallery";
import { RunScreen } from "../screens/run/RunScreen";

/**
 * Корень оболочки: стек экранов, нижняя панель разделов и связь с кнопками
 * площадки (docs/27-design-system-and-app-shell.md §7).
 *
 * Экраны монтируются и размонтируются, а не прячутся стилем: скрытое дерево
 * продолжает реагировать на изменения стора, и во время забега это ровно тот
 * лишний расход, которого быть не должно (§3.3, правило 3).
 */
export function App(): ReactNode {
  const stack = useNavigation((state) => state.stack);
  const screen = currentScreen(stack);
  const capabilities = useShell((state) => state.capabilities);
  const expanded = usePlatform((state) => state.viewport.expanded);
  const install = useInstall();

  usePlatformButtons(stack, screen);

  if (!capabilities.platformAvailable) return <OutsideScreen botUrl={capabilities.botUrl} />;
  // Компактный режим: забег в нём непригоден, а раздел без забега бессмысленен.
  if (!expanded) {
    return <CompactScreen onExpand={() => useShell.getState().adapter.ui.expand()} />;
  }
  if (!install.accepted) return <FirstRunScreen onAccept={() => install.accept()} />;

  const tab = activeTab(stack);
  // Забег занимает весь экран: панель разделов поверх канвы отнимала бы
  // высоту у мира и попадала под палец.
  const showTabs = tab !== null && screen !== "run" && stack.length === 1;

  return (
    <div className="bg-app flex h-full flex-col">
      <main className="min-h-0 flex-1">
        <ScreenTransition screenKey={screen}>{renderScreen(screen)}</ScreenTransition>
      </main>
      {showTabs ? (
        <TabBar
          items={TABS}
          activeId={tab}
          onSelect={(id) => useNavigation.getState().resetTo(id as ScreenId)}
        />
      ) : null}
    </div>
  );
}

/** Точка на разделе — «здесь скоро появится»: заглушки зовут зайти и посмотреть. */
const TABS: readonly TabItem[] = [
  { id: "lobby", label: t("tab.home"), icon: <Home size={22} /> },
  { id: "arsenal", label: t("tab.arsenal"), icon: <Swords size={22} />, badge: "dot" },
  { id: "shop", label: t("tab.shop"), icon: <Gift size={22} />, badge: "dot" },
  { id: "rating", label: t("tab.rating"), icon: <Trophy size={22} />, badge: "dot" },
  { id: "friends", label: t("tab.friends"), icon: <Users size={22} />, badge: "dot" },
];

function renderScreen(screen: ScreenId): ReactNode {
  switch (screen) {
    case "lobby":
      return <LobbyScreen />;
    case "mode":
      return <ModeScreen />;
    case "weapon":
      return <WeaponScreen />;
    case "run":
      return <RunScreen />;
    case "arsenal":
      return <ArsenalScreen />;
    case "shop":
      return <ShopScreen />;
    case "rating":
      return <RatingScreen />;
    case "friends":
      return <FriendsScreen />;
    case "profile":
      return <ProfileScreen />;
    case "tasks":
      return <TasksScreen />;
    case "settings":
      return <SettingsScreen />;
    case "testers":
      return <TestersScreen />;
    case "diagnostics":
      return <DiagnosticsScreen />;
    case "gallery":
      return <GalleryScreen />;
    default:
      return <AboutScreen />;
  }
}

/**
 * Кнопки площадки. «Назад» видна, когда в стеке больше одного экрана, и
 * вызывает `pop`; во время забега она ставит паузу, а не выходит из забега —
 * иначе один случайный жест обнуляет десять минут игры (§7).
 */
function usePlatformButtons(stack: readonly ScreenId[], screen: ScreenId): void {
  useEffect(() => {
    const ui = useShell.getState().adapter.ui;

    if (screen === "run") {
      ui.setBackButton(() => useRun.getState().pause("manual"));
      return;
    }
    ui.setBackButton(canGoBack(stack) ? () => useNavigation.getState().pop() : null);
  }, [stack, screen]);

  useEffect(() => {
    const ui = useShell.getState().adapter.ui;
    ui.setSettingsButton(() => useNavigation.getState().push("settings"));
    return () => ui.setSettingsButton(null);
  }, []);
}
