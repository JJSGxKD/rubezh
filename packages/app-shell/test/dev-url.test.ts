import { afterEach, describe, expect, it, vi } from "vitest";
import { readDevUrl } from "../src/state/dev-url";
import { SCREEN_IDS } from "../src/state/navigation";

// Параметры адреса открывают экран и входят под именем разработчика, поэтому
// действуют только на локальном dev-сервере: через туннель и в сборке —
// никогда.

afterEach(() => vi.restoreAllMocks());

describe("readDevUrl", () => {
  it("открывает экран из адреса на localhost в dev", () => {
    expect(readDevUrl("http://localhost:5173/?screen=shop", true)).toEqual({ screen: "shop", devUser: null, fx: null, ground: "map" });
  });

  it("принимает 127.0.0.1", () => {
    expect(readDevUrl("http://127.0.0.1:5173/?screen=tasks", true).screen).toBe("tasks");
  });

  it("в сборке параметры не действуют", () => {
    expect(readDevUrl("http://localhost:5173/?screen=shop&dev-user=a:B", false)).toEqual({ screen: null, devUser: null, fx: null, ground: "map" });
  });

  it("через туннель параметры не действуют", () => {
    expect(readDevUrl("https://dev-tg.example/?screen=shop&dev-user=a:B", true)).toEqual({ screen: null, devUser: null, fx: null, ground: "map" });
  });

  it("хост, лишь начинающийся с localhost, не считается локальным", () => {
    expect(readDevUrl("https://localhost.evil.example/?screen=shop", true)).toEqual({ screen: null, devUser: null, fx: null, ground: "map" });
  });

  it("забег и стресс-тест адресом не открываются", () => {
    expect(readDevUrl("http://localhost:5173/?screen=run", true).screen).toBeNull();
    expect(readDevUrl("http://localhost:5173/?screen=stress", true).screen).toBeNull();
  });

  it("неизвестный экран пропускается с предупреждением", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readDevUrl("http://localhost:5173/?screen=nope", true).screen).toBeNull();
    expect(warn).toHaveBeenCalledWith("неизвестный экран в адресе: nope");
  });

  it("любой другой экран из списка открывается", () => {
    for (const id of SCREEN_IDS.filter((x) => x !== "run" && x !== "stress")) {
      expect(readDevUrl(`http://localhost:5173/?screen=${id}`, true).screen).toBe(id);
    }
  });

  it("берёт имя разработчика как есть", () => {
    const url = `http://localhost:5173/?dev-user=${encodeURIComponent("dev-player-a:Игрок")}`;
    expect(readDevUrl(url, true).devUser).toBe("dev-player-a:Игрок");
  });

  it("пустое имя разработчика — null", () => {
    expect(readDevUrl("http://localhost:5173/?dev-user=", true).devUser).toBeNull();
  });

  it("имя длиннее 64 символов — null", () => {
    expect(readDevUrl(`http://localhost:5173/?dev-user=${"a".repeat(65)}`, true).devUser).toBeNull();
    expect(readDevUrl(`http://localhost:5173/?dev-user=${"a".repeat(64)}`, true).devUser).toBe("a".repeat(64));
  });

  it("битый адрес не бросает", () => {
    expect(readDevUrl("не адрес", true)).toEqual({ screen: null, devUser: null, fx: null, ground: "map" });
  });

  it("сцена эффекта: по умолчанию на земле карты", () => {
    expect(readDevUrl("http://localhost:5173/?fx=storm", true)).toMatchObject({ fx: "storm", ground: "map" });
  });

  it("ground=light даёт светлую землю, прочее — карту", () => {
    expect(readDevUrl("http://localhost:5173/?fx=storm&ground=light", true).ground).toBe("light");
    expect(readDevUrl("http://localhost:5173/?fx=storm&ground=zzz", true).ground).toBe("map");
  });

  it("неизвестная сцена — null с предупреждением", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readDevUrl("http://localhost:5173/?fx=nope", true).fx).toBeNull();
    expect(warn).toHaveBeenCalledWith("неизвестная сцена эффекта: nope");
  });

  it("в сборке и через туннель сцена не действует", () => {
    expect(readDevUrl("http://localhost:5173/?fx=storm", false).fx).toBeNull();
    expect(readDevUrl("https://dev-tg.example/?fx=storm", true).fx).toBeNull();
  });
});
