import { create } from "zustand";
import { track } from "./shell";

/**
 * Навигация — стек экранов, а не URL-роутер
 * (docs/27-design-system-and-app-shell.md §7). Адресной строки в Mini App нет,
 * история браузера во WebView ведёт себя непредсказуемо, а глубокие ссылки
 * приходят через `startParam` и разбираются в экран на старте.
 *
 * Массив id нужен, чтобы проверить строку из адреса (state/dev-url.ts).
 */
export const SCREEN_IDS = [
  "lobby",
  "run",
  "stress",
  "arsenal",
  "shop",
  "rating",
  "friends",
  "profile",
  "level",
  "history",
  "notifications",
  "changelog",
  "tasks",
  "daily",
  "wheel",
  "settings",
  "testers",
  "diagnostics",
  "gallery",
  "guide",
  "feedback",
  "soundLab",
  "adsCheck",
  "about",
  "testNotice",
  "testerThanks",
  "runInterrupted",
  "promoCode",
] as const;
export type ScreenId = (typeof SCREEN_IDS)[number];

/** Корни разделов нижней панели: переключение вкладки сбрасывает стек. */
export const TAB_ROOTS = ["shop", "arsenal", "lobby", "tasks", "rating", "friends"] as const;
export type TabId = (typeof TAB_ROOTS)[number];

/**
 * Экраны-заглушки: их заходы считаются отдельно — это замер интереса (§6).
 * Сейчас заглушек нет; признак в `screen_viewed` остаётся для следующих.
 */
const STUB_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([]);

/**
 * Куда сдвигается мир при смене экрана (design/art/direction-v2.md §4.4):
 * вглубь и на вкладку правее — новый экран въезжает справа, назад и левее —
 * слева, остальное (замена экрана, первый показ) — просто проявляется.
 * Переход рассказывает, где игрок оказался, а не только что он сменился.
 */
export type ScreenMotion = "forward" | "back" | "rise";

export function screenMotion(prev: readonly ScreenId[], next: readonly ScreenId[]): ScreenMotion {
  if (next.length > prev.length) return "forward";
  if (next.length < prev.length) return "back";
  const from = prev[0];
  const to = next[0];
  if (prev.length === 1 && from !== undefined && to !== undefined && from !== to && isTab(from) && isTab(to)) {
    return TAB_ROOTS.indexOf(to) > TAB_ROOTS.indexOf(from) ? "forward" : "back";
  }
  return "rise";
}

export interface NavigationStore {
  stack: ScreenId[];
  /** как сдвинулся мир последним переходом — для `ScreenTransition` */
  motion: ScreenMotion;
  push(screen: ScreenId): void;
  pop(): void;
  replace(screen: ScreenId): void;
  resetTo(screen: ScreenId): void;
}

export const useNavigation = create<NavigationStore>((set, get) => ({
  stack: ["lobby"],
  motion: "rise",

  push(screen): void {
    if (current(get().stack) === screen) return;
    set({ stack: [...get().stack, screen], motion: "forward" });
    reportScreen(screen);
  },

  pop(): void {
    const stack = get().stack;
    // В корне стека возвращаться некуда: кнопка «назад» в этот момент спрятана,
    // но событие может прийти и от жеста площадки.
    if (stack.length <= 1) return;
    const next = stack.slice(0, -1);
    set({ stack: next, motion: "back" });
    reportScreen(current(next));
  },

  replace(screen): void {
    const stack = get().stack;
    set({ stack: [...stack.slice(0, -1), screen], motion: "rise" });
    reportScreen(screen);
  },

  resetTo(screen): void {
    set({ stack: [screen], motion: screenMotion(get().stack, [screen]) });
    reportScreen(screen);
  },
}));

export function currentScreen(stack: readonly ScreenId[]): ScreenId {
  return current(stack);
}

export function canGoBack(stack: readonly ScreenId[]): boolean {
  return stack.length > 1;
}

/** Какая вкладка подсвечена: корень стека, если он вообще вкладка. */
export function activeTab(stack: readonly ScreenId[]): TabId | null {
  const root = stack[0];
  return isTab(root) ? root : null;
}

function isTab(screen: ScreenId): screen is TabId {
  return (TAB_ROOTS as readonly ScreenId[]).includes(screen);
}

function current(stack: readonly ScreenId[]): ScreenId {
  return stack[stack.length - 1] ?? "lobby";
}

/**
 * Заглушки — это замер, а не пустое место: к этапам 4–5 у нас будут не мнения
 * о том, какой раздел интересен тестерам, а данные (§6).
 */
function reportScreen(screen: ScreenId): void {
  track("screen_viewed", { screen, stub: STUB_SCREENS.has(screen) });
}
