import type { ButtonBar, PlatformUi } from "@bh/shared-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Полоса кнопок Telegram во весь экран (Р107, tasks/T-0148): «Закрыть» и меню
// лежат поверх приложения, в контентной зоне над ним. Оболочка ставит туда
// плашку онлайна, поэтому ей нужны положение и высота полосы, а не сумма
// отступов.

interface Signal<T> {
  (): T;
  sub(listener: () => void): () => void;
  isAvailable(): boolean;
  set(value: T): void;
}

const sdk = vi.hoisted(() => {
  function signal<T>(initial: T): Signal<T> {
    let value = initial;
    const listeners = new Set<() => void>();
    const read = (() => value) as Signal<T>;
    read.sub = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    read.isAvailable = () => true;
    read.set = (next) => {
      value = next;
      for (const listener of [...listeners]) listener();
    };
    return read;
  }
  const action = { ifAvailable: () => ({ ok: false as const }), isAvailable: () => true };
  return {
    signal,
    state: {
      safeAreaInsets: signal({ top: 0, right: 0, bottom: 0, left: 0 }),
      contentSafeAreaInsets: signal({ top: 0, right: 0, bottom: 0, left: 0 }),
      isFullscreen: signal(false),
      isExpanded: signal(true),
      width: signal(390),
      stableHeight: signal(800),
      miniAppActive: signal(true),
    },
    action,
  };
});

vi.mock("@tma.js/sdk", () => ({
  isTMA: () => true,
  init: () => undefined,
  retrieveLaunchParams: () => ({ tgWebAppPlatform: "ios" }),
  viewport: {
    mount: sdk.action,
    safeAreaInsets: sdk.state.safeAreaInsets,
    contentSafeAreaInsets: sdk.state.contentSafeAreaInsets,
    isFullscreen: sdk.state.isFullscreen,
    isExpanded: sdk.state.isExpanded,
    width: sdk.state.width,
    stableHeight: sdk.state.stableHeight,
    requestFullscreen: sdk.action,
    exitFullscreen: sdk.action,
    expand: sdk.action,
  },
  miniApp: { mount: sdk.action, isActive: sdk.state.miniAppActive, setHeaderColor: sdk.action, setBgColor: sdk.action, setBottomBarColor: sdk.action },
  backButton: { mount: sdk.action, show: sdk.action, hide: sdk.action, onClick: sdk.action },
  settingsButton: { mount: sdk.action, show: sdk.action, hide: sdk.action, onClick: sdk.action },
  swipeBehavior: { mount: sdk.action, enableVertical: sdk.action, disableVertical: sdk.action },
  closingBehavior: { mount: sdk.action, enableConfirmation: sdk.action, disableConfirmation: sdk.action },
}));

const { buttonBarOf, createTelegramUi } = await import("../src/ui-telegram");

const zero = { top: 0, right: 0, bottom: 0, left: 0 };

async function ready(): Promise<PlatformUi> {
  const ui = createTelegramUi();
  await ui.ready();
  return ui;
}

beforeEach(() => {
  sdk.state.safeAreaInsets.set(zero);
  sdk.state.contentSafeAreaInsets.set(zero);
  sdk.state.isFullscreen.set(false);
});

describe("полоса кнопок: правило", () => {
  it("во весь экран — от системной зоны вниз на высоту контентной", () => {
    expect(buttonBarOf({ ...zero, top: 47 }, { ...zero, top: 44 }, true)).toEqual({ top: 47, height: 44 });
  });

  it("обычный режим — полосы нет: кнопки Telegram там не поверх приложения", () => {
    expect(buttonBarOf({ ...zero, top: 47 }, { ...zero, top: 44 }, false)).toBeNull();
  });

  it("контентной зоны нет (старый клиент) — полосы нет, а не нулевая", () => {
    expect(buttonBarOf({ ...zero, top: 47 }, zero, true)).toBeNull();
  });

  it("нечисловые и отрицательные отступы не дают полосу и не ломают сумму", () => {
    expect(buttonBarOf({ ...zero, top: Number.NaN }, { ...zero, top: 44 }, true)).toEqual({ top: 0, height: 44 });
    expect(buttonBarOf(zero, { ...zero, top: -5 }, true)).toBeNull();
    expect(buttonBarOf(zero, { ...zero, top: Number.POSITIVE_INFINITY }, true)).toBeNull();
  });
});

describe("полоса кнопок: адаптер Telegram", () => {
  it("во весь экран buttonBar берётся из контентной зоны", async () => {
    sdk.state.safeAreaInsets.set({ ...zero, top: 47 });
    sdk.state.contentSafeAreaInsets.set({ ...zero, top: 44 });
    sdk.state.isFullscreen.set(true);
    const ui = await ready();
    expect(ui.buttonBar).toEqual({ top: 47, height: 44 });
    // Отступы не менялись: по-прежнему сумма двух зон.
    expect(ui.insets.top).toBe(91);
  });

  it("обычный режим — buttonBar равен null", async () => {
    sdk.state.safeAreaInsets.set({ ...zero, top: 47 });
    sdk.state.contentSafeAreaInsets.set({ ...zero, top: 44 });
    const ui = await ready();
    expect(ui.buttonBar).toBeNull();
  });

  it("смена режима даёт событие: вошли в полный экран — полоса, вышли — null", async () => {
    sdk.state.safeAreaInsets.set({ ...zero, top: 47 });
    sdk.state.contentSafeAreaInsets.set({ ...zero, top: 44 });
    const ui = await ready();
    const seen: Array<ButtonBar | null> = [];
    ui.onButtonBarChange?.((bar) => seen.push(bar));

    sdk.state.isFullscreen.set(true);
    sdk.state.isFullscreen.set(false);
    expect(seen).toEqual([{ top: 47, height: 44 }, null]);
  });

  it("смена отступов во весь экран тоже даёт событие, а повтор тех же чисел — нет", async () => {
    sdk.state.isFullscreen.set(true);
    sdk.state.safeAreaInsets.set({ ...zero, top: 47 });
    sdk.state.contentSafeAreaInsets.set({ ...zero, top: 44 });
    const ui = await ready();
    const seen: Array<ButtonBar | null> = [];
    ui.onButtonBarChange?.((bar) => seen.push(bar));

    sdk.state.contentSafeAreaInsets.set({ ...zero, top: 52 });
    sdk.state.contentSafeAreaInsets.set({ ...zero, top: 52 });
    sdk.state.safeAreaInsets.set({ ...zero, top: 47, bottom: 34 });
    expect(seen).toEqual([{ top: 47, height: 52 }]);
  });

  it("объект полосы стабилен, пока она не менялась: на него опирается подписка React", async () => {
    sdk.state.isFullscreen.set(true);
    sdk.state.contentSafeAreaInsets.set({ ...zero, top: 44 });
    const ui = await ready();
    const first = ui.buttonBar;
    sdk.state.contentSafeAreaInsets.set({ ...zero, top: 44, bottom: 10 });
    expect(ui.buttonBar).toBe(first);
  });

  it("отписка работает: после неё событий нет", async () => {
    const ui = await ready();
    const seen: Array<ButtonBar | null> = [];
    const off = ui.onButtonBarChange?.((bar) => seen.push(bar));
    off?.();
    sdk.state.contentSafeAreaInsets.set({ ...zero, top: 44 });
    sdk.state.isFullscreen.set(true);
    expect(seen).toEqual([]);
  });
});
