import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { parseArgs, shotPlan, run, DEFAULT_SIZES, AS_USERS, DEFAULT_BASE } from "../screens/shoot.mjs";
// @ts-expect-error — то же
import { SCENARIOS } from "../screens/scenarios.mjs";
// @ts-expect-error — то же
import { runSteps } from "../screens/steps.mjs";

// Команда нужна живым API и браузеру, поэтому в гейт не входит; здесь —
// всё, что проверяется без браузера: флаги, план снимков, адреса, отказ при
// молчащем клиенте и сообщение о сломавшемся шаге.

const SIX = ["320x568", "390x844", "768x1024", "1440x900", "667x375", "640x360"];

describe("parseArgs", () => {
  it("без аргументов — все сценарии, шесть размеров, owner и браузер по платформе", () => {
    const win = parseArgs([], "win32");
    expect(win.scenarios.map((s: { id: string }) => s.id)).toEqual(["lobby", "gallery", "prerun"]);
    expect(win.sizes.map((s: { width: number; height: number }) => `${s.width}x${s.height}`)).toEqual(SIX);
    expect(win.as).toBe("owner");
    expect(win.browser).toBe("msedge");
    expect(win.base).toBe(DEFAULT_BASE);
    expect(win.out).toBe("var/screens");
    expect(parseArgs([], "linux").browser).toBe("chrome");
    expect(DEFAULT_SIZES).toHaveLength(6);
  });

  it("--sizes 390x844 — один размер", () => {
    expect(parseArgs(["--sizes", "390x844"]).sizes).toEqual([{ width: 390, height: 844 }]);
  });

  it.each(["0x0", "abc", "390", "390x", "x844", "-1x5"])("--sizes %s — ошибка", (bad) => {
    expect(() => parseArgs(["--sizes", bad])).toThrow(/размер/);
  });

  it("--as player подставляет обычного игрока", () => {
    const options = parseArgs(["--as", "player"]);
    expect(options.devUser).toBe("dev-player-shots:Игрок");
    expect(AS_USERS.owner).toBe("dev-shots:Снимки");
    expect(parseArgs([]).devUser).toBe("dev-shots:Снимки");
  });

  it("--as с неизвестным значением — ошибка", () => {
    expect(() => parseArgs(["--as", "admin"])).toThrow(/--as/);
  });

  it("--browser принимает msedge и chrome", () => {
    expect(parseArgs(["--browser", "chrome"]).browser).toBe("chrome");
    expect(() => parseArgs(["--browser", "firefox"])).toThrow(/--browser/);
  });

  it("позиционные аргументы выбирают сценарии, неизвестный — ошибка", () => {
    expect(parseArgs(["prerun"]).scenarios.map((s: { id: string }) => s.id)).toEqual(["prerun"]);
    expect(() => parseArgs(["nope"])).toThrow(/nope/);
  });

  it("--screen tasks — разовый сценарий вместо трёх", () => {
    const options = parseArgs(["--screen", "tasks"]);
    expect(options.scenarios).toEqual([{ id: "tasks", screen: "tasks" }]);
  });

  it("--screen run и неизвестный экран — ошибка", () => {
    expect(() => parseArgs(["--screen", "run"])).toThrow(/run/);
    expect(() => parseArgs(["--screen", "nope"])).toThrow(/nope/);
  });

  it("неизвестный флаг и флаг без значения — ошибка", () => {
    expect(() => parseArgs(["--wat"])).toThrow(/--wat/);
    expect(() => parseArgs(["--out"])).toThrow(/--out/);
  });
});

describe("shotPlan", () => {
  const ctx = { base: "http://localhost:5173", devUser: "dev-shots:Снимки" };

  it("даёт имя файла, ширину и высоту", () => {
    const prerun = SCENARIOS.find((s: { id: string }) => s.id === "prerun");
    const plan = shotPlan([prerun], [{ width: 320, height: 568 }], "var/screens", ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ width: 320, height: 568 });
    expect(plan[0].file.replace(/\\/g, "/")).toBe("var/screens/prerun-320x568.png");
    expect(plan[0].scenario.id).toBe("prerun");
  });

  it("считает сценарии на размеры: три на шесть — восемнадцать", () => {
    const options = parseArgs([]);
    expect(shotPlan(options.scenarios, options.sizes, options.out, ctx)).toHaveLength(18);
  });

  it("адрес несёт screen и dev-user, закодированные", () => {
    const plan = shotPlan([{ id: "tasks", screen: "tasks" }], [{ width: 390, height: 844 }], "o", ctx);
    const url = new URL(plan[0].url);
    expect(url.origin).toBe("http://localhost:5173");
    expect(url.searchParams.get("screen")).toBe("tasks");
    expect(url.searchParams.get("dev-user")).toBe("dev-shots:Снимки");
  });

  it("у сценария без экрана в адресе нет screen", () => {
    const plan = shotPlan([{ id: "lobby" }], [{ width: 390, height: 844 }], "o", ctx);
    expect(new URL(plan[0].url).searchParams.has("screen")).toBe(false);
  });

  it("--as player даёт игрока в адресе", () => {
    const options = parseArgs(["--as", "player", "--screen", "shop"]);
    const plan = shotPlan(options.scenarios, options.sizes.slice(0, 1), options.out, options);
    expect(new URL(plan[0].url).searchParams.get("dev-user")).toBe("dev-player-shots:Игрок");
    expect(new URL(plan[0].url).searchParams.get("screen")).toBe("shop");
  });
});

describe("сценарии", () => {
  it("gallery открывается адресом, prerun — кликом по «Играть»", () => {
    const byId = Object.fromEntries(SCENARIOS.map((s: { id: string }) => [s.id, s]));
    expect(byId.gallery.screen).toBe("gallery");
    expect(byId.prerun.steps.length).toBeGreaterThan(0);
  });
});

describe("run", () => {
  const noop = () => undefined;

  it("клиент не отвечает — код 1 и понятное сообщение, браузер не запускается", async () => {
    const lines: string[] = [];
    let launched = false;
    const code = await run(parseArgs([]), {
      fetchClient: async () => {
        throw new Error("ECONNREFUSED");
      },
      createShooter: async () => {
        launched = true;
        return { shoot: async () => [], close: async () => undefined };
      },
      mkdir: async () => undefined,
      log: (line: string) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(launched).toBe(false);
    expect(lines.join("\n")).toContain("Клиент на http://localhost:5173 не отвечает — запустите pnpm dev");
  });

  it("все снимки сделаны — код 0, ошибки консоли печатаются списком, но код не меняют", async () => {
    const lines: string[] = [];
    const shot: string[] = [];
    const code = await run(parseArgs(["lobby", "--sizes", "390x844"]), {
      fetchClient: async () => ({ ok: true }),
      createShooter: async () => ({
        shoot: async (job: { file: string }) => {
          shot.push(job.file);
          return ["Failed to load resource"];
        },
        close: async () => undefined,
      }),
      mkdir: async () => undefined,
      log: (line: string) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(shot).toHaveLength(1);
    expect(lines.join("\n")).toContain("Failed to load resource");
  });

  it("шаг не нашёл элемент — код 1, в сообщении сценарий", async () => {
    const lines: string[] = [];
    const code = await run(parseArgs(["prerun", "--sizes", "390x844"]), {
      fetchClient: async () => ({ ok: true }),
      createShooter: async () => ({
        shoot: async () => {
          throw new Error("сценарий prerun, шаг «нажать Играть»: элемент не найден");
        },
        close: async () => undefined,
      }),
      mkdir: noop,
      log: (line: string) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("prerun");
  });
});

describe("runSteps", () => {
  it("исполняет шаги по порядку", async () => {
    const calls: string[] = [];
    const page = {
      getByText: (text: string) => ({ click: async () => void calls.push(`click:${text}`) }),
      waitForSelector: async (sel: string) => void calls.push(`wait:${sel}`),
    };
    await runSteps(page, { id: "x", steps: [{ click: "Играть" }, { waitText: "Перед забегом" }] });
    expect(calls).toEqual(["click:Играть", "wait:text=Перед забегом"]);
  });

  it("сломавшийся шаг называет сценарий и шаг", async () => {
    const page = {
      getByText: () => ({
        click: async () => {
          throw new Error("timeout");
        },
      }),
      waitForSelector: async () => undefined,
    };
    await expect(runSteps(page, { id: "prerun", steps: [{ click: "Играть" }] })).rejects.toThrow(/prerun.*Играть/);
  });
});
