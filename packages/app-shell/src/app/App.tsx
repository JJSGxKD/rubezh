import { Suspense, useEffect, useState, type ReactNode } from "react";
import { ListChecks, Store, Swords, Trophy, Users } from "lucide-react";
import { ArmorIcon, ScreenTransition, TabBar, type TabItem } from "../design-system/components";
import { AppHeader } from "./AppHeader";
import { t } from "../i18n";
import { useInstall } from "../state/install";
import {
  activeTab,
  canGoBack,
  currentScreen,
  useNavigation,
  type ScreenId,
} from "../state/navigation";
import { badgeText, useBadges } from "../state/badges";
import { useMeta } from "../state/meta";
import { usePlatform } from "../state/platform";
import { useRun } from "../state/run";
import { isVersionAtLeast } from "../state/platform-version";
import { useShell } from "../state/shell";
import { CompactOverlay, FirstRunScreen, OutdatedScreen, OutsideScreen } from "../screens/gates";
import { LobbyScreen, ModeScreen } from "../screens/home";
import { playedBefore, skipFirstRunHints } from "../state/first-run";
import {
  AboutScreen,
  ArsenalScreen,
  BoostsScreen,
  DailyScreen,
  DiagnosticsScreen,
  FriendsScreen,
  GalleryScreen,
  FeedbackScreen,
  GuideScreen,
  HistoryScreen,
  LevelScreen,
  MainMenu,
  NotificationsScreen,
  ChangelogScreen,
  ProfileScreen,
  RatingScreen,
  RunScreen,
  ScreenBoundary,
  ScreenFallback,
  SettingsScreen,
  ShopScreen,
  SoundLabScreen,
  StressScreen,
  TasksScreen,
  TestersScreen,
  WeaponScreen,
  WheelScreen,
  PromoCodeScreen,
  TestNoticeScreen,
} from "./lazy-screens";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const arsenalCount = useBadges((state) => state.arsenal);
  const friendsCount = useBadges((state) => state.friends);
  const tasksCount = useBadges((state) => state.tasks);

  usePlatformButtons(stack, screen);

  if (!capabilities.platformAvailable) return <OutsideScreen botUrl={capabilities.botUrl} />;
  // Версия клиента проверяется после самой площадки: вне её версии нет, и
  // спрашивать не у кого.
  if (outdated(capabilities.minPlatformVersion)) return <OutdatedScreen version={clientVersion()} />;
  if (!install.accepted) return <FirstRunScreen onAccept={() => void acceptAndPlay()} />;

  const tab = activeTab(stack);
  // Знак — только с полезной нагрузкой (Р50): новые предметы, подарки к
  // выдаче и заявки друзей, награды заданий к забору.
  const badges: Partial<Record<string, string | undefined>> = { arsenal: badgeText(arsenalCount), friends: badgeText(friendsCount), tasks: badgeText(tasksCount) };
  const tabs = TABS.map((item) => {
    const badge = badges[item.id];
    return badge === undefined ? item : { ...item, badge };
  });
  // Забег занимает весь экран: панель разделов поверх канвы отнимала бы
  // высоту у мира и попадала под палец.
  const showTabs = tab !== null && screen !== "run" && stack.length === 1;
  // Настройки, открытые с паузы, ложатся поверх забега, а не вместо него:
  // размонтированный экран забега уничтожил бы движок, и возврат начинал бы
  // забег заново. Забег в этот момент стоит на паузе и скрыт, но жив.
  const runUnderneath = screen !== "run" && stack.includes("run");

  return (
    <div className="bg-app relative flex h-full flex-col" data-app-header={showTabs ? "" : undefined}>
      {/* Шапка — у разделов нижней панели: внутри раздела верх экрана занят
          заголовком и кнопкой «назад». Лежит поверх прокрутки, а не над ней:
          содержимое уходит под её стекло (WP30). */}
      {showTabs ? <AppHeader onMenu={() => setMenuOpen(true)} /> : null}
      <main className="relative min-h-0 flex-1">
        {screen === "run" || runUnderneath ? (
          <div
            aria-hidden={runUnderneath}
            className={runUnderneath ? "invisible absolute inset-0" : "h-full"}
          >
            <ScreenBoundary key="run">
              <Suspense fallback={<ScreenFallback />}>
                <ScreenTransition screenKey="run">
                  <RunScreen />
                </ScreenTransition>
              </Suspense>
            </ScreenBoundary>
          </div>
        ) : null}
        {screen === "run" ? null : (
          <div className={runUnderneath ? "bg-app absolute inset-0" : "h-full"}>
            <ScreenBoundary key={screen}>
              <Suspense fallback={<ScreenFallback />}>
                <ScreenTransition screenKey={screen}>{renderScreen(screen)}</ScreenTransition>
              </Suspense>
            </ScreenBoundary>
          </div>
        )}
      </main>
      {/* Компактное окно — плашка поверх живого приложения: забег под ней
          стоит на паузе и дожидается игрока (§5.2). */}
      {expanded ? null : <CompactOverlay onExpand={() => useShell.getState().adapter.ui.expand()} />}
      {showTabs ? (
        <TabBar
          items={tabs}
          activeId={tab}
          onSelect={(id) => useNavigation.getState().resetTo(id as ScreenId)}
        />
      ) : null}
      {menuOpen && showTabs ? (
        <Suspense fallback={null}>
          <MainMenu onClose={() => setMenuOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * Порядок разделов — как в мобильных играх жанра: главная с кнопкой «Играть»
 * ближе к центру, под большим пальцем. Знак на разделе — только с
 * полезной нагрузкой, числом: награды к выдаче, новые предметы, подарки
 * (`35-stage4-plan.md`, Р50). Точек «зайди посмотреть» нет: знак, который
 * горит всегда, перестают замечать.
 */
const TABS: readonly TabItem[] = [
  // Значки говорят, что внутри: магазин — витрина, а не подарок; арсенал —
  // снаряжение, а не бой; бой — на главной, откуда в него и уходят.
  { id: "shop", label: t("tab.shop"), icon: <Store size={22} /> },
  { id: "arsenal", label: t("tab.arsenal"), icon: <ArmorIcon size={22} /> },
  { id: "lobby", label: t("tab.home"), icon: <Swords size={22} /> },
  { id: "tasks", label: t("tab.tasks"), icon: <ListChecks size={22} /> },
  { id: "rating", label: t("tab.rating"), icon: <Trophy size={22} /> },
  { id: "friends", label: t("tab.friends"), icon: <Users size={22} /> },
];

function renderScreen(screen: ScreenId): ReactNode {
  switch (screen) {
    case "lobby":
      return <LobbyScreen />;
    case "mode":
      return <ModeScreen />;
    case "weapon":
      return <WeaponScreen />;
    case "boosts":
      return <BoostsScreen />;
    case "run":
      return <RunScreen />;
    case "feedback":
      return <FeedbackScreen />;
    case "stress":
      return <StressScreen />;
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
    case "level":
      return <LevelScreen />;
    case "history":
      return <HistoryScreen />;
    case "notifications":
      return <NotificationsScreen />;
    case "changelog":
      return <ChangelogScreen />;
    case "tasks":
      return <TasksScreen />;
    case "daily":
      return <DailyScreen />;
    case "wheel":
      return <WheelScreen />;
    case "promoCode":
      return <PromoCodeScreen />;
    case "testNotice":
      return <TestNoticeScreen />;
    case "settings":
      return <SettingsScreen />;
    case "testers":
      return <TestersScreen />;
    case "diagnostics":
      return <DiagnosticsScreen />;
    case "gallery":
      return <GalleryScreen />;
    case "guide":
      return <GuideScreen />;
    case "soundLab":
      return <SoundLabScreen />;
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

/**
 * Согласие на первом запуске и сразу первый забег.
 *
 * Новичок, которого высадили в лобби, видит витрину из карточек и не видит
 * игры: интерес держится на первом бою, а не на меню. Поэтому после согласия
 * забег начинается сам — на «Лёгкой», со стартовым оружием и подсказками
 * первого забега. Выйти из него можно тем же способом, что из любого другого.
 */
async function acceptAndPlay(): Promise<void> {
  useInstall.getState().accept();
  // Согласие — на устройстве, а аккаунт мог уже играть на другом: тогда
  // учебного забега нет, игрок остаётся в лобби (state/first-run.ts).
  if (await playedBefore()) {
    skipFirstRunHints();
    return;
  }
  // Первый забег — на «Лёгкой»: она и задумана как баланс без поправок.
  useMeta.getState().rememberDifficulty("easy");
  useRun.getState().intend({ kind: "new" });
  useNavigation.getState().push("run");
}

/** Клиент площадки старше минимума, объявленного сборкой. */
function outdated(minimum: string | undefined): boolean {
  if (minimum === undefined) return false;
  return !isVersionAtLeast(clientVersion(), minimum);
}

function clientVersion(): string | null {
  return useShell.getState().adapter.clientInfo().version;
}
