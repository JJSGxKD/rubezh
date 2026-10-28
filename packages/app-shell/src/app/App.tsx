import { Suspense, useEffect, useState, type ReactNode } from "react";
import { BookOpen, ListChecks, Menu, Settings, Store, Swords, Trophy, Users } from "lucide-react";
import { ArmorIcon, ModalHostProvider, ScreenTransition, SideRail, TabBar, WideHeader, type TabItem } from "../design-system/components";
import { chromeFor } from "../design-system/components/wide-rules";
import { AmbientSky } from "./AmbientSky";
import { AppHeader } from "./AppHeader";
import { BalanceValue } from "./BalanceValue";
import { formatCompact, formatNumber, t } from "../i18n";
import { useInstall } from "../state/install";
import {
  activeTab,
  canGoBack,
  currentScreen,
  TAB_ROOTS,
  useNavigation,
  type ScreenId,
} from "../state/navigation";
import { badgeText, useBadges } from "../state/badges";
import { useConnection } from "../state/connection";
import { useMeta } from "../state/meta";
import { usePlatform } from "../state/platform";
import { useProgress } from "../state/progress";
import { useRun } from "../state/run";
import { isVersionAtLeast } from "../state/platform-version";
import { useShell } from "../state/shell";
import { useWallet } from "../state/wallet";
import { useWide } from "../state/wide";
import { uiFeedback } from "../state/ui-feedback";
import { backAction, backKeyAction, useBackStack, type BackStack } from "../state/back-stack";
import { CompactOverlay, FirstRunScreen, OutdatedScreen, OutsideScreen } from "../screens/gates";
import { LobbyScreen } from "../screens/home";
import { playedBefore, skipFirstRunHints } from "../state/first-run";
import {
  AboutScreen,
  ArsenalScreen,
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
  AdsCheckScreen,
  StressScreen,
  TasksScreen,
  TestersScreen,
  WheelScreen,
  PromoCodeScreen,
  TestNoticeScreen,
  RunInterruptedScreen,
  TesterThanksScreen,
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
  const motion = useNavigation((state) => state.motion);
  const screen = currentScreen(stack);
  const capabilities = useShell((state) => state.capabilities);
  const expanded = usePlatform((state) => state.viewport.expanded);
  const install = useInstall();
  const [menuOpen, setMenuOpen] = useState(false);
  const arsenalCount = useBadges((state) => state.arsenal);
  const friendsCount = useBadges((state) => state.friends);
  const tasksCount = useBadges((state) => state.tasks);
  const [modalLayer, setModalLayer] = useState<HTMLElement | null>(null);
  const wide = useWide((state) => state.wide);

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
  // высоту у мира и попадала под палец. С 1024 px вместо нижней панели —
  // боковое меню, а вместо шапки-стекла — шапка в потоке (T-0298).
  const chrome = chromeFor({ wide, inRun: screen === "run", tabRoot: tab !== null, depth: stack.length });
  const showTabs = chrome.nav === "tabs";
  const tabItem = tabs.find((item) => item.id === tab);
  // Настройки, открытые с паузы, ложатся поверх забега, а не вместо него:
  // размонтированный экран забега уничтожил бы движок, и возврат начинал бы
  // забег заново. Забег в этот момент стоит на паузе и скрыт, но жив.
  const runUnderneath = screen !== "run" && stack.includes("run");

  return (
    <ModalHostProvider value={modalLayer}>
    <div className={`bg-app relative flex h-full ${chrome.nav === "rail" ? "flex-row" : "flex-col"}`} data-app-header={chrome.header === "app" ? "" : undefined}>
      {chrome.nav === "rail" ? <RailHost items={tabs} activeId={tab} onMenu={() => setMenuOpen(true)} /> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Шапка — у разделов нижней панели: внутри раздела верх экрана занят
          заголовком и кнопкой «назад». Лежит поверх прокрутки, а не над ней:
          содержимое уходит под её стекло (WP30). На wide — в потоке, с названием
          раздела и кошельком. */}
      {chrome.header === "app" ? <AppHeader onMenu={() => setMenuOpen(true)} /> : null}
      {chrome.header === "wide" ? <WideHeaderHost title={tabItem?.label ?? ""} /> : null}
      {/* isolate: живой фон — нижним слоем внутри `main`, под экранами, но над
          заливкой приложения; частокол встаёт прямо над нижней панелью. */}
      <main className="relative isolate min-h-0 flex-1 overflow-x-clip">
        {/* Живой фон — вне забега: под канвой он только жёг бы батарею. */}
        {screen === "run" ? null : <AmbientSky depth={tab === null ? null : TAB_ROOTS.indexOf(tab)} />}
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
                <ScreenTransition screenKey={screen} motion={motion}>
                  {renderScreen(screen)}
                </ScreenTransition>
              </Suspense>
            </ScreenBoundary>
          </div>
        )}
      </main>
      {/* Компактное окно — плашка поверх живого приложения: забег под ней
          стоит на паузе и дожидается игрока (§5.2). */}
      {expanded ? null : <CompactOverlay onExpand={() => useShell.getState().adapter.ui.expand()} />}
      {showTabs ? (
        <TabBar track="tabs"
          items={tabs}
          activeId={tab}
          onSelect={(id) => useNavigation.getState().resetTo(id as ScreenId)}
        />
      ) : null}
      </div>
      {menuOpen && chrome.nav !== "none" ? (
        <Suspense fallback={null}>
          <MainMenu onClose={() => setMenuOpen(false)} />
        </Suspense>
      ) : null}
      {/* Слой модалок поверх шапки и нижней панели (Р119); пустой, пока окон нет. */}
      <div ref={setModalLayer} data-modal-layer="" className="pointer-events-none absolute inset-0" style={{ zIndex: "var(--z-modal)" }} />
    </div>
    </ModalHostProvider>
  );
}

/**
 * Боковое меню на wide (T-0298): данные игрока — из сторов, как в шапке
 * телефона; само меню (`SideRail`) о сторах не знает.
 */
function RailHost(props: { items: readonly TabItem[]; activeId: string | null; onMenu(): void }): ReactNode {
  const user = useShell((state) => state.adapter.displayUser);
  const level = useProgress((state) => state.progress?.level ?? state.runLevel);
  const xpShare = useProgress((state) => {
    const progress = state.progress;
    if (progress === null || progress.xpForNext === null) return progress === null ? 0 : 1;
    return progress.xpForNext === 0 ? 1 : Math.min(1, progress.xpIntoLevel / progress.xpForNext);
  });
  const push = (screen: ScreenId) => () => useNavigation.getState().push(screen);
  return (
    <SideRail
      track="rail"
      items={props.items}
      activeId={props.activeId}
      player={{ name: user?.displayName ?? t("profile.guest"), avatarUrl: user?.avatarUrl, level, xpShare }}
      onSelect={(id) => useNavigation.getState().resetTo(id as ScreenId)}
      onProfile={push("profile")}
      bottom={[
        // Меню на wide — пунктом внизу: уведомления, история, «Что нового» и
        // промокод живут только в нём, а шапки с кнопкой меню на wide нет.
        { id: "menu", label: t("menu.title"), icon: <Menu size={20} />, onSelect: props.onMenu },
        { id: "guide", label: t("guide.title"), icon: <BookOpen size={20} />, onSelect: push("guide") },
        { id: "settings", label: t("settings.title"), icon: <Settings size={20} />, onSelect: push("settings") },
      ]}
    />
  );
}

/** Шапка раздела на wide: название слева, кошелёк и колокольчик справа — те же переходы, что в шапке телефона. */
function WideHeaderHost(props: { title: string }): ReactNode {
  const balances = useWallet((state) => state.balances);
  const unread = useBadges((state) => state.notifications);
  const withAccount = useShell((state) => state.capabilities.auth !== undefined);
  const offline = useConnection((state) => state.status === "offline");
  return (
    <WideHeader
      title={props.title}
      offline={offline}
      coinsLabel={`${t("currency.coins")}: ${formatNumber(balances?.coins ?? 0)}`}
      gemsLabel={`${t("currency.premium")}: ${formatNumber(balances?.gems ?? 0)}`}
      coins={(bump) => <BalanceValue id="coins" value={balances?.coins ?? null} format={formatCompact} bump={bump} />}
      gems={(bump) => <BalanceValue id="gems" value={balances?.gems ?? null} format={formatCompact} bump={bump} />}
      onCoins={() => {
        uiFeedback("tap");
        useNavigation.getState().push("history");
      }}
      onGems={() => {
        uiFeedback("tap");
        useNavigation.getState().resetTo("shop");
      }}
      bell={
        withAccount
          ? {
              unread,
              label: unread > 0 ? t("notifications.bell.unread", { count: unread }) : t("notifications.bell"),
              onOpen: () => useNavigation.getState().push("notifications"),
            }
          : null
      }
    />
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
    case "testerThanks":
      return <TesterThanksScreen />;
    case "runInterrupted":
      return <RunInterruptedScreen />;
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
    case "adsCheck":
      return <AdsCheckScreen />;
    default:
      return <AboutScreen />;
  }
}

/**
 * Кнопки площадки. «Назад» и Esc — по стеку (`state/back-stack.ts`): открытая
 * модалка закрывается; иначе на экране раздела — `pop`, если есть куда
 * вернуться, а во время забега — пауза, а не выход из забега: иначе один
 * случайный жест обнуляет десять минут игры (§7).
 */
function usePlatformButtons(stack: readonly ScreenId[], screen: ScreenId): void {
  useEffect(() => {
    useBackStack.getState().setBase(
      screen === "run"
        ? { action: () => useRun.getState().pause("manual"), keyboard: false }
        : { action: canGoBack(stack) ? () => useNavigation.getState().pop() : null, keyboard: true },
    );
  }, [stack, screen]);

  // Кнопка площадки — за верхним слоем стека: открытая модалка закрывается
  // ею, а не уводит экран из-под себя.
  useEffect(() => {
    const ui = useShell.getState().adapter.ui;
    let shown: (() => void) | null | undefined;
    const apply = (state: BackStack): void => {
      const action = backAction(state);
      if (action === shown) return;
      shown = action;
      ui.setBackButton(action);
    };
    apply(useBackStack.getState());
    const unsubscribe = useBackStack.subscribe(apply);
    return () => {
      unsubscribe();
      ui.setBackButton(null);
    };
  }, []);

  // Esc на ПК — тот же стек. Внутри Telegram Desktop он не должен уйти
  // клиенту и закрыть приложение, когда у приложения есть что закрыть.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      const action = backKeyAction(event, useBackStack.getState(), typing);
      if (action === null) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
