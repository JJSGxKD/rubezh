import { beforeEach, describe, expect, it } from "vitest";
import {
  activeTab,
  canGoBack,
  currentScreen,
  useNavigation,
} from "../src/state/navigation";

// Стек экранов и его связь с кнопкой «назад»
// (docs/27-design-system-and-app-shell.md §7, §9).

describe("стек экранов", () => {
  beforeEach(() => {
    useNavigation.setState({ stack: ["lobby"] });
  });

  it("в корне возвращаться некуда — кнопка «назад» скрыта", () => {
    expect(canGoBack(useNavigation.getState().stack)).toBe(false);
    useNavigation.getState().pop();
    expect(useNavigation.getState().stack).toEqual(["lobby"]);
  });

  it("кладёт экран сверху и снимает обратно", () => {
    const navigation = useNavigation.getState();
    navigation.push("mode");
    navigation.push("weapon");

    expect(currentScreen(useNavigation.getState().stack)).toBe("weapon");
    expect(canGoBack(useNavigation.getState().stack)).toBe(true);

    useNavigation.getState().pop();
    expect(currentScreen(useNavigation.getState().stack)).toBe("mode");
  });

  it("не кладёт тот же экран дважды: двойной тап не должен множить стек", () => {
    useNavigation.getState().push("settings");
    useNavigation.getState().push("settings");

    expect(useNavigation.getState().stack).toEqual(["lobby", "settings"]);
  });

  it("заменяет верхний экран, не удлиняя стек", () => {
    useNavigation.getState().push("weapon");
    useNavigation.getState().replace("run");

    expect(useNavigation.getState().stack).toEqual(["lobby", "run"]);
  });

  it("переключение вкладки сбрасывает стек к её корню", () => {
    useNavigation.getState().push("mode");
    useNavigation.getState().resetTo("shop");

    expect(useNavigation.getState().stack).toEqual(["shop"]);
    expect(canGoBack(useNavigation.getState().stack)).toBe(false);
  });

  it("подсвечивает вкладку по корню стека, а не по верхнему экрану", () => {
    useNavigation.getState().resetTo("arsenal");
    useNavigation.getState().push("settings");

    expect(activeTab(useNavigation.getState().stack)).toBe("arsenal");
    expect(currentScreen(useNavigation.getState().stack)).toBe("settings");
  });

  it("не подсвечивает вкладку, когда корень — не раздел нижней панели", () => {
    useNavigation.getState().resetTo("settings");
    expect(activeTab(useNavigation.getState().stack)).toBeNull();
  });
});
