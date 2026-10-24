import { beforeEach, describe, expect, it } from "vitest";
import {
  activeTab,
  canGoBack,
  currentScreen,
  screenMotion,
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
    navigation.push("settings");
    navigation.push("stress");

    expect(currentScreen(useNavigation.getState().stack)).toBe("stress");
    expect(canGoBack(useNavigation.getState().stack)).toBe(true);

    useNavigation.getState().pop();
    expect(currentScreen(useNavigation.getState().stack)).toBe("settings");
  });

  it("не кладёт тот же экран дважды: двойной тап не должен множить стек", () => {
    useNavigation.getState().push("settings");
    useNavigation.getState().push("settings");

    expect(useNavigation.getState().stack).toEqual(["lobby", "settings"]);
  });

  it("заменяет верхний экран, не удлиняя стек", () => {
    useNavigation.getState().push("stress");
    useNavigation.getState().replace("run");

    expect(useNavigation.getState().stack).toEqual(["lobby", "run"]);
  });

  it("переключение вкладки сбрасывает стек к её корню", () => {
    useNavigation.getState().push("settings");
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

describe("сдвиг мира при переходе", () => {
  beforeEach(() => {
    useNavigation.setState({ stack: ["lobby"], motion: "rise" });
  });

  it("вглубь — справа, назад — слева", () => {
    const navigation = useNavigation.getState();
    navigation.push("settings");
    expect(useNavigation.getState().motion).toBe("forward");
    navigation.pop();
    expect(useNavigation.getState().motion).toBe("back");
  });

  it("вкладка правее по панели — справа, левее — слева", () => {
    const navigation = useNavigation.getState();
    navigation.resetTo("tasks");
    expect(useNavigation.getState().motion).toBe("forward");
    navigation.resetTo("shop");
    expect(useNavigation.getState().motion).toBe("back");
  });

  it("замена экрана и выход из глубины на вкладку — проявление", () => {
    const navigation = useNavigation.getState();
    navigation.replace("daily");
    expect(useNavigation.getState().motion).toBe("rise");
    expect(screenMotion(["lobby", "settings"], ["arsenal"])).toBe("back");
    expect(screenMotion(["lobby"], ["lobby"])).toBe("rise");
    expect(screenMotion(["profile"], ["lobby"])).toBe("rise");
  });
});
