import { describe, expect, it } from "vitest";
import { createNoopPlatformUi } from "../src/platform-ui-noop";

/**
 * Контрактный тест возможностей интерфейса площадки
 * (docs/17-testing-strategy.md §5): одинаковый набор у любого адаптера,
 * включая заглушки MAX и VK — они используют ровно эту реализацию.
 *
 * Проверяется не поведение конкретной площадки, а то, что оболочке есть на что
 * опереться: свойства читаются, подписки отписываются, обещания не бросают.
 */
describe("контракт возможностей площадки", () => {
  it("готовится без площадки и не бросает", async () => {
    await expect(createNoopPlatformUi().ready()).resolves.toBeUndefined();
  });

  it("честно сообщает, что не умеет полноэкранный режим", async () => {
    const ui = createNoopPlatformUi();

    expect(ui.supportsFullscreen).toBe(false);
    expect(ui.defaultScreenMode).toBe("normal");
    // Запрошенный режим и фактический — разные вещи: переключатель в
    // настройках читает фактический и остаётся выключенным.
    await expect(ui.setScreenMode("fullscreen")).resolves.toBe("normal");
  });

  it("отдаёт нулевые отступы и развёрнутый вьюпорт, а не выдуманные числа", () => {
    const ui = createNoopPlatformUi();

    expect(ui.insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(ui.viewport.expanded).toBe(true);
    expect(ui.isActive).toBe(true);
  });

  it("возвращает отписку из каждой подписки — иначе экраны текут при переходах", () => {
    const ui = createNoopPlatformUi();
    const subscriptions = [
      ui.onInsetsChange(() => undefined),
      ui.onViewportChange(() => undefined),
      ui.onScreenModeChange(() => undefined),
      ui.onActiveChange(() => undefined),
    ];

    for (const unsubscribe of subscriptions) {
      expect(typeof unsubscribe).toBe("function");
      expect(() => unsubscribe()).not.toThrow();
    }
  });

  it("переживает команды, которых площадка не умеет", () => {
    const ui = createNoopPlatformUi();

    expect(() => {
      ui.expand();
      ui.setBackButton(() => undefined);
      ui.setBackButton(null);
      ui.setSettingsButton(null);
      ui.setVerticalSwipesEnabled(false);
      ui.setClosingConfirmation(true);
      ui.applyThemeColors({ header: "#000", background: "#000", bottomBar: "#000" });
    }).not.toThrow();
  });
});
