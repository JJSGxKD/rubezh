import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { buildReport, exitCode, parseArgs, selectByDiff } from "../fx/check-core.mjs";

// Команда нужна живому dev-серверу и браузеру, поэтому в гейт не входит;
// здесь — чистые части: выбор по диффу, разбор флагов и сборка отчёта.

const SCENES = ["storm", "meteor", "dynamite"];
const SOUNDS = ["spark", "chest"];

function scene(over: Record<string, unknown> = {}) {
  return {
    scene: "storm",
    ground: "map",
    lifeMs: 800,
    lifeNote: null,
    changedShare: { max: 0.123 },
    flashes: { perSecond: 1, warning: null },
    displayObjects: { max: 40 },
    frameTimeP95Ms: 16.6,
    ...over,
  };
}

function sound(over: Record<string, unknown> = {}) {
  return { id: "spark", variant: "0", bus: "sfx", peakDbfs: -3, rmsDbfs: -18, audibleMs: 200, tailMs: 120, marks: [], ...over };
}

describe("выбор по диффу", () => {
  it("рецепты звука — все звуки, сцен нет", () => {
    expect(selectByDiff(["packages/app-shell/src/audio/recipes.ts"])).toEqual({ scenes: false, sounds: true });
    expect(selectByDiff(["packages/app-shell/src/audio/synth.ts"])).toEqual({ scenes: false, sounds: true });
  });
  it("рендер или оружие — все сцены", () => {
    expect(selectByDiff(["packages/core-game/src/game/render/weapon-effects.ts"])).toEqual({ scenes: true, sounds: false });
    expect(selectByDiff(["packages/core-game/src/content/weapons.ts"])).toEqual({ scenes: true, sounds: false });
  });
  it("прочее — ничего", () => {
    expect(selectByDiff(["docs/x.md"])).toEqual({ scenes: false, sounds: false });
  });
});

describe("разбор флагов", () => {
  it("--scenes и --sounds списками", () => {
    const o = parseArgs(["--scenes", "storm,meteor", "--sounds", "spark"], SCENES, SOUNDS);
    expect(o.scenes).toEqual(["storm", "meteor"]);
    expect(o.sounds).toEqual(["spark"]);
  });
  it("без флагов — всё", () => {
    const o = parseArgs([], SCENES, SOUNDS);
    expect(o.scenes).toEqual(SCENES);
    expect(o.sounds).toEqual(SOUNDS);
  });
  it("неизвестная сцена или звук называются в ошибке", () => {
    expect(() => parseArgs(["--scenes", "nope"], SCENES, SOUNDS)).toThrow(/nope/);
    expect(() => parseArgs(["--sounds", "nope"], SCENES, SOUNDS)).toThrow(/nope/);
  });
  it("--changed и --base", () => {
    const o = parseArgs(["--changed", "--base", "origin/main"], SCENES, SOUNDS);
    expect(o.changed).toBe(true);
    expect(o.diffBase).toBe("origin/main");
  });
});

describe("отчёт", () => {
  it("без пометок — «Ошибок нет», код 0", () => {
    const r = { scenes: [scene()], sounds: [sound()], files: ["var/fx/storm-map.png"] };
    const text = buildReport(r, "13.11.2026");
    expect(text).toContain("## Звук и эффекты");
    expect(text).toContain("pnpm fx:check --changed");
    expect(text).toContain("Ошибок нет");
    expect(text).toContain("var/fx/storm-map.png");
    expect(exitCode(r)).toBe(0);
  });
  it("ошибка звука — первой строкой «Ошибки: …», код 1", () => {
    const r = { scenes: [], sounds: [sound({ marks: [{ level: "error", text: "перегруз: 3 отсчёта" }] })], files: [] };
    const text = buildReport(r, "d");
    const first = text.split("\n").find((l: string) => l.startsWith("Ошибк"));
    expect(first).toMatch(/^Ошибки: /);
    expect(text).toContain("перегруз");
    expect(exitCode(r)).toBe(1);
  });
  it("вспышки 4 в секунду — код 1", () => {
    const r = { scenes: [scene({ flashes: { perSecond: 4, warning: "частые вспышки" } })], sounds: [], files: [] };
    expect(exitCode(r)).toBe(1);
    expect(buildReport(r, "d")).toContain("частые вспышки");
  });
  it("таблица эффектов — семь столбцов", () => {
    const text = buildReport({ scenes: [scene()], sounds: [], files: [] }, "d");
    const header = text.split("\n").find((l: string) => l.startsWith("| Сцена"));
    expect(header?.split("|").length).toBe(9);
    expect(text).toMatch(/\|(\s*:?-+:?\s*\|){7}/);
  });
});
