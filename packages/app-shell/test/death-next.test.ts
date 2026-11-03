import { describe, expect, it } from "vitest";
import { RUBEZH_AT_SEC } from "@bh/shared-types";
import "../src/i18n/run";
import "../src/i18n/account";
import { formatDuration, t } from "../src/i18n";
import { unlockLabel, type LevelUnlock } from "../src/state/level-unlocks";
import { goalText, levelGoalInput, MAX_GOALS, pickNextGoals, RUBEZH_CLOSE, type NextGoal, type NextGoalsInput } from "../src/screens/run/death-next";

// Что дальше после смерти (tasks/T-0109): до трёх ближайших целей — до
// рекорда, до уровня, задание на подходе, ближайшее открытие. Вся логика —
// чистые функции; компонент только рисует.

const STORM: LevelUnlock = { kind: "weapon", id: "storm" };

function input(patch: Partial<NextGoalsInput> = {}): NextGoalsInput {
  // Победа над стражем гасит цель «рубеж»: цели рекорда, заданий и уровня проверяются сами по себе, рубеж — в своём describe.
  return { isNewRecord: false, survivalSec: 0, bestSec: null, level: null, tasks: [], nextUnlock: null, rubezh: { reached: true, clearedSec: 1, guardHpPercent: null }, ...patch };
}

const task = (id: string, period: string, value: number, target: number, patch: { kind?: string; done?: boolean } = {}) => ({
  id,
  period,
  kind: patch.kind ?? "runs",
  value,
  target,
  done: patch.done ?? false,
});

const kinds = (goals: NextGoal[]): string[] => goals.map((goal) => goal.kind);

describe("цель «рекорд»", () => {
  it("новый рекорд — цели нет, даже если в данных рекорд больше забега", () => {
    expect(pickNextGoals(input({ isNewRecord: true, survivalSec: 330, bestSec: 600 }))).toEqual([]);
  });

  it("рекорд 600, забег 330 — до рекорда 270", () => {
    expect(pickNextGoals(input({ survivalSec: 330, bestSec: 600 }))).toEqual([{ kind: "record", closeness: 0.55, gapSec: 270, bestSec: 600 }]);
  });

  it("забег короче половины рекорда — цели нет", () => {
    expect(pickNextGoals(input({ survivalSec: 200, bestSec: 600 }))).toEqual([]);
  });

  it("рекорд неизвестен или забег его не короче — цели нет", () => {
    expect(pickNextGoals(input({ survivalSec: 330, bestSec: null }))).toEqual([]);
    expect(pickNextGoals(input({ survivalSec: 600, bestSec: 600 }))).toEqual([]);
    expect(pickNextGoals(input({ survivalSec: 100, bestSec: 0 }))).toEqual([]);
  });
});

describe("цель «уровень»", () => {
  it("доля 0.8 — цель с остатком опыта и следующим уровнем", () => {
    const [goal] = pickNextGoals(input({ level: { level: 3, fraction: 0.8, xpLeft: 120 } }));
    expect(goal).toEqual({ kind: "level", closeness: 0.8, level: 4, xpLeft: 120, unlocks: [] });
  });

  it("доля 0.3 или награды нет — цели нет", () => {
    expect(pickNextGoals(input({ level: { level: 3, fraction: 0.3, xpLeft: 700 } }))).toEqual([]);
    expect(pickNextGoals(input({ level: null }))).toEqual([]);
  });
});

describe("цель «задание»", () => {
  it("4 из 5 ежедневного — цель", () => {
    expect(pickNextGoals(input({ tasks: [task("d1", "daily", 4, 5)] }))).toEqual([{ kind: "task", closeness: 0.8, period: "daily", value: 4, target: 5 }]);
  });

  it("2 из 5, выполненное, подписка на канал и достижение — не цель", () => {
    expect(pickNextGoals(input({ tasks: [task("d1", "daily", 2, 5)] }))).toEqual([]);
    expect(pickNextGoals(input({ tasks: [task("d1", "daily", 5, 5, { done: true })] }))).toEqual([]);
    expect(pickNextGoals(input({ tasks: [task("d1", "daily", 4, 5, { kind: "channel" })] }))).toEqual([]);
    expect(pickNextGoals(input({ tasks: [task("a1", "achievement", 4, 5)] }))).toEqual([]);
  });

  it("нулевая цель задания пропускается и не роняет подсчёт", () => {
    expect(pickNextGoals(input({ tasks: [task("d1", "daily", 0, 0)] }))).toEqual([]);
  });

  it("подходят виды цели из забега", () => {
    for (const kind of ["runs", "kills", "survive_sec", "best_survival_sec", "run_level"]) {
      expect(kinds(pickNextGoals(input({ tasks: [task("t", "weekly", 4, 5, { kind })] })))).toEqual(["task"]);
    }
  });

  it("два подходящих — одно, с большей долей", () => {
    const goals = pickNextGoals(input({ tasks: [task("d1", "daily", 3, 5), task("w1", "weekly", 9, 10)] }));
    expect(goals).toEqual([{ kind: "task", closeness: 0.9, period: "weekly", value: 9, target: 10 }]);
  });

  it("равная доля — ежедневное раньше недельного, затем меньший id", () => {
    const daily = pickNextGoals(input({ tasks: [task("w1", "weekly", 4, 5), task("d9", "daily", 4, 5)] }));
    expect(daily).toEqual([{ kind: "task", closeness: 0.8, period: "daily", value: 4, target: 5 }]);
    const sameDay = pickNextGoals(input({ tasks: [task("d2", "daily", 8, 10), task("d1", "daily", 4, 5)] }));
    expect(sameDay).toEqual([{ kind: "task", closeness: 0.8, period: "daily", value: 4, target: 5 }]);
  });
});

describe("цель «открытие» и слияние с уровнем", () => {
  const nextUnlock = (level: number) => ({ level, unlocks: [STORM] });

  it("уровень прошёл порог, открытие ровно на следующем — одна цель с открытием", () => {
    const goals = pickNextGoals(input({ level: { level: 3, fraction: 0.8, xpLeft: 120 }, nextUnlock: nextUnlock(4) }));
    expect(goals).toEqual([{ kind: "level", closeness: 0.8, level: 4, xpLeft: 120, unlocks: [STORM] }]);
  });

  it("открытие через уровень — две цели", () => {
    const goals = pickNextGoals(input({ level: { level: 3, fraction: 0.8, xpLeft: 120 }, nextUnlock: nextUnlock(5) }));
    expect(kinds(goals)).toEqual(["level", "unlock"]);
    expect(goals[1]).toMatchObject({ kind: "unlock", level: 5, unlocks: [STORM] });
  });

  it("уровень порог не прошёл, а открытие есть — отдельная цель", () => {
    const goals = pickNextGoals(input({ level: { level: 3, fraction: 0.1, xpLeft: 900 }, nextUnlock: nextUnlock(4) }));
    expect(goals).toEqual([{ kind: "unlock", closeness: 0.3, level: 4, unlocks: [STORM] }]);
  });
});

describe("порядок и предел", () => {
  it("пять подходящих — три, по убыванию близости", () => {
    const goals = pickNextGoals(
      input({
        survivalSec: 570,
        bestSec: 600,
        level: { level: 3, fraction: 0.9, xpLeft: 50 },
        tasks: [task("d1", "daily", 4, 5)],
        nextUnlock: { level: 6, unlocks: [STORM] },
      }),
    );
    expect(MAX_GOALS).toBe(3);
    expect(goals).toHaveLength(3);
    expect(kinds(goals)).toEqual(["record", "level", "task"]);
    expect(goals.map((goal) => goal.closeness)).toEqual([0.95, 0.9, 0.8]);
  });

  it("равная близость — рекорд, задание, уровень, открытие", () => {
    const goals = pickNextGoals(
      input({
        survivalSec: 300,
        bestSec: 600,
        level: { level: 3, fraction: 0.5, xpLeft: 300 },
        tasks: [task("d1", "daily", 5, 10)],
      }),
    );
    expect(kinds(goals)).toEqual(["record", "task", "level"]);
  });

  it("пустой вход — пустой список", () => {
    expect(pickNextGoals(input())).toEqual([]);
  });
});

describe("цель «рубеж»", () => {
  // Другие цели проверяются без рубежа: победа в умолчании `input` его гасит, здесь умолчание снято.
  const open = (patch: Partial<NextGoalsInput>): NextGoalsInput => input({ rubezh: undefined, ...patch });
  const stopped = (guardHpPercent: number | null) => ({ reached: true, clearedSec: null, guardHpPercent });

  it("580 из 600 — «До рубежа 20 с», близость доли отметки", () => {
    expect(RUBEZH_AT_SEC).toBe(600);
    const goals = pickNextGoals(open({ survivalSec: 580 }));
    expect(goals).toEqual([{ kind: "rubezh", stage: "approach", closeness: 580 / 600, leftSec: 20 }]);
    expect(goalText(goals[0] as NextGoal)).toBe("До рубежа 20 с");
  });

  it("200 из 600 — цели нет: до рубежа далеко", () => {
    expect(pickNextGoals(open({ survivalSec: 200 }))).toEqual([]);
  });

  it("порог — половина отметки: ровно половина ещё цель, чуть меньше — нет", () => {
    expect(RUBEZH_CLOSE).toBe(0.5);
    expect(kinds(pickNextGoals(open({ survivalSec: RUBEZH_AT_SEC * RUBEZH_CLOSE })))).toEqual(["rubezh"]);
    expect(pickNextGoals(open({ survivalSec: RUBEZH_AT_SEC * RUBEZH_CLOSE - 1 }))).toEqual([]);
  });

  it("секунды до рубежа округляются вверх: «0 с» не показываем, пока страж не пришёл", () => {
    const goal = pickNextGoals(open({ survivalSec: 599.4 }))[0];
    expect(goal).toMatchObject({ kind: "rubezh", stage: "approach", leftSec: 1 });
  });

  it("страж жив с 12% — близость 0,94 и «осталось 12%»", () => {
    const goals = pickNextGoals(open({ survivalSec: 700, rubezh: stopped(12) }));
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ kind: "rubezh", stage: "guard", guardHpPercent: 12 });
    expect(goals[0]?.closeness).toBeCloseTo(0.94, 10);
    expect(goalText(goals[0] as NextGoal)).toBe("Страж почти пал: осталось 12%");
  });

  it("страж нетронут — близость 0,5: сам приход стража уже половина пути", () => {
    expect(pickNextGoals(open({ survivalSec: 650, rubezh: stopped(100) }))[0]?.closeness).toBe(0.5);
  });

  it("страж жив, остаток неизвестен — цели нет, а не «осталось null%»", () => {
    expect(pickNextGoals(open({ survivalSec: 700, rubezh: stopped(null) }))).toEqual([]);
  });

  it("победа — цели «рубеж» нет", () => {
    expect(pickNextGoals(open({ survivalSec: 800, rubezh: { reached: true, clearedSec: 700, guardHpPercent: null } }))).toEqual([]);
    expect(pickNextGoals(open({ survivalSec: 580, rubezh: { reached: true, clearedSec: 575, guardHpPercent: null } }))).toEqual([]);
  });

  it("не дошёл до стража, а секунд забега уже больше отметки — цели нет", () => {
    expect(pickNextGoals(open({ survivalSec: 640, rubezh: { reached: false, clearedSec: null, guardHpPercent: null } }))).toEqual([]);
  });

  it("при равной близости: рекорд, рубеж, задание, уровень", () => {
    const goals = pickNextGoals(
      input({
        survivalSec: 300,
        bestSec: 600,
        rubezh: stopped(100),
        level: { level: 3, fraction: 0.5, xpLeft: 300 },
        tasks: [task("d1", "daily", 5, 10)],
      }),
    );
    // Все четыре цели на 0,5; предел показа — три, уровень не помещается.
    expect(kinds(goals)).toEqual(["record", "rubezh", "task"]);
  });

  it("близкий рубеж вытесняет из трёх целей самую дальнюю", () => {
    const goals = pickNextGoals(
      open({
        survivalSec: 590,
        bestSec: 700,
        level: { level: 3, fraction: 0.45, xpLeft: 300 },
        tasks: [task("d1", "daily", 6, 10)],
        nextUnlock: { level: 6, unlocks: [STORM] },
      }),
    );
    expect(kinds(goals)).toEqual(["rubezh", "record", "task"]);
  });
});

describe("подписи целей", () => {
  it("рекорд", () => {
    expect(goalText({ kind: "record", closeness: 0.55, gapSec: 270, bestSec: 600 })).toBe(`До рекорда ещё ${formatDuration(270)} (рекорд ${formatDuration(600)})`);
  });

  it("задание недели и дня", () => {
    expect(goalText({ kind: "task", closeness: 0.8, period: "weekly", value: 4, target: 5 })).toBe("Задание недели почти выполнено\u00a0— 4\u00a0из\u00a05");
    expect(goalText({ kind: "task", closeness: 0.8, period: "daily", value: 4, target: 5 })).toBe("Задание дня почти выполнено\u00a0— 4\u00a0из\u00a05");
  });

  it("уровень без открытий и с ними", () => {
    expect(goalText({ kind: "level", closeness: 0.8, level: 4, xpLeft: 120, unlocks: [] })).toBe("До 4-го уровня — 120 опыта");
    expect(goalText({ kind: "level", closeness: 0.8, level: 4, xpLeft: 120, unlocks: [STORM] })).toBe(`До 4-го уровня — 120 опыта, откроется: ${unlockLabel(STORM)}`);
  });

  it("открытие", () => {
    expect(goalText({ kind: "unlock", closeness: 0.3, level: 4, unlocks: [STORM] })).toBe(`Откроется на 4-м уровне: оружие «${t("weapon.storm.name")}»`);
  });
});

describe("уровень из награды", () => {
  const progress: { level: number; xp: number; xpIntoLevel: number; xpForNext: number | null; nextReward: null } = {
    level: 3, xp: 0, xpIntoLevel: 400, xpForNext: 500, nextReward: null,
  };
  const granted = (patch: Partial<{ levelBefore: number; levelAfter: number; xp: number; progress: typeof progress }> = {}) => ({
    status: "granted" as const,
    coins: 10,
    coinsCapped: false,
    xp: 50,
    levelBefore: 3,
    levelAfter: 3,
    progress,
    ...patch,
  });

  it("награда выдана — доля и остаток из полосы уровня", () => {
    expect(levelGoalInput(granted())).toEqual({ level: 3, fraction: 0.8, xpLeft: 100 });
  });

  it("высший уровень, награда считается или её нет — null", () => {
    expect(levelGoalInput(granted({ progress: { ...progress, xpForNext: null } }))).toBeNull();
    expect(levelGoalInput({ status: "pending" })).toBeNull();
    expect(levelGoalInput({ status: "none", reason: "guest" })).toBeNull();
    expect(levelGoalInput(undefined)).toBeNull();
  });
});
