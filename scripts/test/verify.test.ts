import { describe, expect, it } from "vitest";
import {
  affectedUnits,
  buildReport,
  exitCodeOf,
  formatDuration,
  lintCandidates,
  onlyScriptsChanged,
  planSteps,
  runPlan,
  summarizeFailure,
  withDependents,
  // @ts-expect-error — утилита на чистом JS, типов у неё нет и не нужно
} from "../verify/lib.mjs";

// pnpm verify (T-0474, Р224, B): отчёт проверки для PR пишет скрипт, а не агент.
// Здесь — чистая часть: затронутые пакеты, план шагов, сборка отчёта, код выхода.

const DIRS = [
  "packages/core-game",
  "packages/app-shell",
  "packages/shared-types",
  "backend/api",
  "apps/admin",
  "apps/web-telegram",
];

type Step = { id: string; label: string; status: "ok" | "fail" | "skip"; detail?: string; ms?: number | null; problems?: string[] };

const ok = (id: string, label: string, ms: number | null = 1000): Step => ({ id, label, status: "ok", ms });
const skip = (id: string, label: string, detail: string): Step => ({ id, label, status: "skip", detail, ms: null });

describe("affectedUnits: какие пакеты затронул дифф", () => {
  it("файл пакета относит к ближайшему пакету", () => {
    const r = affectedUnits(["packages/core-game/src/index.ts", "packages/core-game/test/a.test.ts"], DIRS);
    expect(r.all).toBe(false);
    expect(r.units).toEqual(["packages/core-game"]);
  });

  it("несколько пакетов — отсортированный список без повторов", () => {
    const r = affectedUnits(["packages/app-shell/src/a.tsx", "backend/api/src/b.ts", "packages/app-shell/src/c.tsx"], DIRS);
    expect(r.units).toEqual(["backend/api", "packages/app-shell"]);
  });

  it("корневой конфиг задевает всё", () => {
    for (const file of ["package.json", "pnpm-lock.yaml", "tsconfig.base.json", "vitest.config.ts", "eslint.config.js"]) {
      expect(affectedUnits([file], DIRS).all, file).toBe(true);
    }
  });

  it("package.json пакета — это пакет, а не корень", () => {
    const r = affectedUnits(["packages/core-game/package.json"], DIRS);
    expect(r.all).toBe(false);
    expect(r.units).toEqual(["packages/core-game"]);
  });

  it("скрипты репозитория — отдельный блок «scripts»", () => {
    const r = affectedUnits(["scripts/verify/lib.mjs", "scripts/test/verify.test.ts"], DIRS);
    expect(r.all).toBe(false);
    expect(r.units).toEqual(["scripts"]);
  });

  it("документы, задачи, скиллы и markdown пакета ничего не затрагивают", () => {
    const r = affectedUnits(
      ["docs/17-testing-strategy.md", "tasks/T-0474-x.md", ".claude/skills/pre-pr/SKILL.md", "CLAUDE.md", "packages/core-game/README.md"],
      DIRS,
    );
    expect(r.all).toBe(false);
    expect(r.units).toEqual([]);
  });

  it("пустой дифф — пустой результат", () => {
    expect(affectedUnits([], DIRS)).toEqual({ all: false, units: [] });
  });

  it("слэши Windows приводятся к прямым", () => {
    expect(affectedUnits(["packages\\core-game\\src\\a.ts"], DIRS).units).toEqual(["packages/core-game"]);
  });

  it("вложенный пакет побеждает внешний по длине префикса", () => {
    const r = affectedUnits(["apps/admin/src/a.ts"], [...DIRS, "apps"]);
    expect(r.units).toEqual(["apps/admin"]);
  });
});

describe("withDependents: затронутые вместе с теми, кто от них зависит", () => {
  const graph = {
    "packages/shared-types": [],
    "packages/core-game": ["packages/shared-types"],
    "packages/app-shell": ["packages/core-game", "packages/shared-types"],
    "apps/web-telegram": ["packages/app-shell"],
    "backend/api": ["packages/shared-types"],
  };

  it("нижний пакет тянет всех потребителей по цепочке", () => {
    expect(withDependents(["packages/core-game"], graph)).toEqual(["apps/web-telegram", "packages/app-shell", "packages/core-game"]);
  });

  it("листовой пакет остаётся один", () => {
    expect(withDependents(["apps/web-telegram"], graph)).toEqual(["apps/web-telegram"]);
  });

  it("блок «scripts» зависимостей не имеет и в графе не нужен", () => {
    expect(withDependents(["scripts"], graph)).toEqual(["scripts"]);
  });

  it("цикл в графе не зацикливает обход", () => {
    expect(withDependents(["a"], { a: ["b"], b: ["a"] })).toEqual(["a", "b"]);
  });
});

describe("lintCandidates: что отдаём eslint", () => {
  it("только существующие ts и tsx; удалённые и прочее отсеяны", () => {
    const files = ["a.ts", "b.tsx", "c.mjs", "d.md", "gone.ts", ".claude/workflows/pipeline.ts"];
    expect(lintCandidates(files, (f: string) => f !== "gone.ts")).toEqual(["a.ts", "b.tsx"]);
  });
});

type PlanStep = {
  id: string;
  label: string;
  commands: Array<{ args: string[] }>;
  skipReason: string | null;
  timeoutMs: number;
};

describe("planSteps: что и как запускать", () => {
  const base = { files: [] as string[], dirs: DIRS, graph: {}, db: false, env: {}, exists: () => true };
  const byId = (plan: PlanStep[], id: string): PlanStep => {
    const step = plan.find((s) => s.id === id);
    if (step === undefined) throw new Error(`нет шага ${id}`);
    return step;
  };

  it("только документы: код не проверяется, docs:check и зоны идут", () => {
    const plan: PlanStep[] = planSteps({ ...base, files: ["docs/a.md", "CLAUDE.md"] });
    expect(byId(plan, "typecheck").skipReason).not.toBeNull();
    expect(byId(plan, "lint").skipReason).not.toBeNull();
    expect(byId(plan, "tests").skipReason).not.toBeNull();
    expect(byId(plan, "build").skipReason).not.toBeNull();
    expect(byId(plan, "zones").skipReason).toBeNull();
    expect(byId(plan, "docs").skipReason).toBeNull();
  });

  it("правка core-game: typecheck из корня, тесты затронутых и зависимых пакетов, сборка оболочки", () => {
    const graph = { "packages/core-game": [], "packages/app-shell": ["packages/core-game"] };
    const plan: PlanStep[] = planSteps({ ...base, graph, files: ["packages/core-game/src/a.ts"] });
    expect(byId(plan, "typecheck").commands[0]?.args).toEqual(["typecheck"]);
    const tests = byId(plan, "tests");
    expect(tests.label).toBe("тесты core-game, app-shell");
    expect(tests.commands[0]?.args).toEqual(["exec", "vitest", "run", "--passWithNoTests", "packages/app-shell/", "packages/core-game/"]);
    expect(byId(plan, "build").skipReason).toBeNull();
    expect(byId(plan, "build").commands.map((c) => c.args[0])).toEqual(["build", "budget"]);
  });

  it("правка только бэкенда: сборка и бюджет не затронуты", () => {
    const plan: PlanStep[] = planSteps({ ...base, files: ["backend/api/src/a.ts"] });
    expect(byId(plan, "build").skipReason).toMatch(/не затронуты/);
    expect(byId(plan, "tests").label).toBe("тесты api");
  });

  it("корневой конфиг: тесты без фильтра, сборка идёт", () => {
    const plan: PlanStep[] = planSteps({ ...base, files: ["package.json"] });
    const tests = byId(plan, "tests");
    expect(tests.label).toBe("тесты всех пакетов");
    expect(tests.commands[0]?.args).toEqual(["exec", "vitest", "run"]);
    expect(byId(plan, "build").skipReason).toBeNull();
  });

  it("lint печатает число файлов и режет команду на пачки", () => {
    const files = Array.from({ length: 95 }, (_, i) => `packages/core-game/src/f${String(i)}.ts`);
    const lint = byId(planSteps({ ...base, files }), "lint");
    expect(lint.label).toBe("lint (95 файлов)");
    expect(lint.commands).toHaveLength(3);
    expect(lint.commands[0]?.args.slice(0, 3)).toEqual(["exec", "eslint", "--no-warn-ignored"]);
  });

  it("lint без ts-файлов пропускается", () => {
    const lint = byId(planSteps({ ...base, files: ["scripts/verify/lib.mjs"] }), "lint");
    expect(lint.skipReason).toMatch(/нет/);
  });

  it("интеграция: без флага --db — «проверит CI»", () => {
    const plan: PlanStep[] = planSteps({ ...base, files: ["backend/api/src/a.ts"] });
    expect(byId(plan, "db").skipReason).toBe("не запускались — проверит CI");
  });

  it("интеграция: флаг есть, а адрес базы не на rubezh_test — отказ, dev-базу не трогаем", () => {
    for (const url of [undefined, "postgresql://u:p@localhost:5432/bullet_heaven", "postgresql://u:p@localhost/other"]) {
      const env = url === undefined ? {} : { TEST_DATABASE_URL: url };
      const db = byId(planSteps({ ...base, db: true, env, files: ["backend/api/src/a.ts"] }), "db");
      expect(db.skipReason, String(url)).toMatch(/rubezh_test/);
      expect(db.commands).toEqual([]);
    }
  });

  it("интеграция: флаг и адрес на rubezh_test — прогон backend/api, а обычные тесты бэкенда не дублируются", () => {
    const env = { TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/rubezh_test?schema=t0474" };
    const plan: PlanStep[] = planSteps({ ...base, db: true, env, files: ["backend/api/src/a.ts", "packages/core-game/src/b.ts"] });
    expect(byId(plan, "db").skipReason).toBeNull();
    expect(byId(plan, "db").commands[0]?.args).toEqual(["exec", "vitest", "run", "backend/api/"]);
    expect(byId(plan, "tests").commands[0]?.args).not.toContain("backend/api/");
  });

  it("интеграция: бэкенд не затронут — шаг пропущен даже с флагом", () => {
    const env = { TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/rubezh_test" };
    const db = byId(planSteps({ ...base, db: true, env, files: ["packages/core-game/src/b.ts"] }), "db");
    expect(db.skipReason).toMatch(/не затронут/);
  });

  it("у каждого запускаемого шага есть таймаут", () => {
    const plan: PlanStep[] = planSteps({ ...base, files: ["package.json"] });
    for (const step of plan.filter((s) => s.skipReason === null)) {
      expect(step.timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe("runPlan: исполнение плана с подставным запуском", () => {
  const plan = [
    { id: "typecheck", label: "typecheck", skipReason: null, timeoutMs: 1000, commands: [{ cmd: "pnpm", args: ["typecheck"] }] },
    { id: "build", label: "build + budget", skipReason: null, timeoutMs: 1000, commands: [{ cmd: "pnpm", args: ["build"] }, { cmd: "pnpm", args: ["budget"] }] },
    { id: "docs", label: "docs:check", skipReason: "не затронуты", timeoutMs: 1000, commands: [] },
  ];

  it("пропущенный шаг становится ⏭ с причиной и без времени", () => {
    const results: Step[] = runPlan(plan, () => ({ code: 0, output: "", ms: 5, timedOut: false }));
    expect(results[2]).toMatchObject({ status: "skip", detail: "не затронуты", ms: null });
  });

  it("время шага — сумма времени его команд", () => {
    const results: Step[] = runPlan(plan, () => ({ code: 0, output: "", ms: 700, timedOut: false }));
    expect(results[0]).toMatchObject({ status: "ok", ms: 700 });
    expect(results[1]).toMatchObject({ status: "ok", ms: 1400 });
  });

  it("первая упавшая команда останавливает шаг: budget после упавшего build не идёт", () => {
    const seen: string[] = [];
    const results: Step[] = runPlan(plan, (c: { args: string[] }) => {
      seen.push(c.args[0] ?? "");
      return { code: c.args[0] === "build" ? 1 : 0, output: "error: boom", ms: 10, timedOut: false };
    });
    expect(seen).toEqual(["typecheck", "build"]);
    expect(results[1]).toMatchObject({ status: "fail" });
  });

  it("таймаут — красный шаг с пометкой", () => {
    const results: Step[] = runPlan(plan, () => ({ code: null, output: "", ms: 1000, timedOut: true }));
    expect(results[0]).toMatchObject({ status: "fail" });
    expect(results[0]?.detail).toMatch(/таймаут/);
  });
});

describe("summarizeFailure: что показать из вывода упавшего шага", () => {
  it("vitest: число упавших и их имена, цвета терминала срезаны", () => {
    const out = [
      "\u001b[31m FAIL \u001b[39m packages/core-game/test/art-atlas.test.ts > атлас > кадры не пустые",
      " FAIL  packages/core-game/test/b.test.ts > b > c",
      "AssertionError: expected 1 to be 2",
      " Tests  2 failed | 10 passed (12)",
    ].join("\n");
    const r = summarizeFailure("tests", out);
    expect(r.detail).toBe("2 упали");
    expect(r.problems).toEqual([
      "packages/core-game/test/art-atlas.test.ts > атлас > кадры не пустые",
      "packages/core-game/test/b.test.ts > b > c",
    ]);
  });

  it("склонение числа упавших: 1 упал, 2 упали, 5 упало", () => {
    expect(summarizeFailure("tests", " Tests  1 failed | 3 passed").detail).toBe("1 упал");
    expect(summarizeFailure("tests", " Tests  5 failed | 3 passed").detail).toBe("5 упало");
    expect(summarizeFailure("tests", " Tests  21 failed | 3 passed").detail).toBe("21 упал");
  });

  it("vitest без разбираемой сводки: просто «упали», хвост вывода — в проблемах", () => {
    const r = summarizeFailure("tests", "Error: cannot find module x\nstack");
    expect(r.detail).toBe("упали");
    expect(r.problems.join(" ")).toContain("cannot find module x");
  });

  it("typecheck: строки с кодами TS", () => {
    const out = "a.ts(3,1): error TS2322: Type 'string' is not assignable.\nнекий шум\nb.ts(1,1): error TS2304: Cannot find name.";
    const r = summarizeFailure("typecheck", out);
    expect(r.detail).toBe("2 ошибки");
    expect(r.problems).toEqual(["a.ts(3,1): error TS2322: Type 'string' is not assignable.", "b.ts(1,1): error TS2304: Cannot find name."]);
  });

  it("lint: файл и первое сообщение", () => {
    const out = "/repo/packages/a/src/x.ts\n  12:3  error  Unexpected any  @typescript-eslint/no-explicit-any\n\n✖ 1 problem";
    const r = summarizeFailure("lint", out);
    expect(r.problems).toEqual(["/repo/packages/a/src/x.ts:12:3 Unexpected any  @typescript-eslint/no-explicit-any"]);
  });

  it("остальные шаги: строки с «ошибка» или error, иначе хвост вывода", () => {
    expect(summarizeFailure("zones", "ошибка  PR меняет файлы вне зон\n  a.ts").problems).toEqual(["ошибка  PR меняет файлы вне зон"]);
    expect(summarizeFailure("docs", "строка 1\nстрока 2").problems).toEqual(["строка 1", "строка 2"]);
  });

  it("список проблем ограничен: лишние сворачиваются в «и ещё N»", () => {
    const out = Array.from({ length: 9 }, (_, i) => ` FAIL  t${String(i)}.test.ts > x`).join("\n");
    const r = summarizeFailure("tests", out);
    expect(r.problems).toHaveLength(6);
    expect(r.problems.at(-1)).toBe("…и ещё 4");
  });
});

describe("formatDuration", () => {
  it("секунды, минуты и подсекундные значения", () => {
    expect(formatDuration(400)).toBe("< 1 с");
    expect(formatDuration(9_400)).toBe("9 с");
    expect(formatDuration(72_000)).toBe("1 м 12 с");
    expect(formatDuration(160_000)).toBe("2 м 40 с");
    expect(formatDuration(120_000)).toBe("2 м 0 с");
  });
});

describe("buildReport: Markdown-блок для описания PR", () => {
  const when = new Date(Date.UTC(2026, 10, 13, 14, 2, 31));
  const header = { head: "7ff1fbe8a1b2c3d4", dirty: false, when, platform: "win32" };

  it("шапка: голова в 8 знаков, дата и время UTC, платформа", () => {
    const report: string = buildReport({ ...header, results: [ok("typecheck", "typecheck")] });
    expect(report).toContain("## Проверено (pnpm verify)");
    expect(report).toContain("Голова: 7ff1fbe8 · 13.11.2026 14:02 UTC · Windows");
    expect(report).not.toContain("7ff1fbe8a");
  });

  it("платформы: Linux и macOS", () => {
    expect(buildReport({ ...header, platform: "linux", results: [] })).toContain("· Linux");
    expect(buildReport({ ...header, platform: "darwin", results: [] })).toContain("· macOS");
  });

  it("незакоммиченные правки помечаются в шапке — отчёт не про голову", () => {
    expect(buildReport({ ...header, dirty: true, results: [] })).toContain("есть незакоммиченные правки");
    expect(buildReport({ ...header, dirty: false, results: [] })).not.toContain("незакоммиченные");
  });

  it("таблица: ✅, ❌ с пояснением, ⏭ с причиной и прочерк вместо времени", () => {
    const report: string = buildReport({
      ...header,
      results: [
        ok("typecheck", "typecheck", 72_000),
        { id: "tests", label: "тесты core-game, app-shell", status: "fail", detail: "2 упали", ms: 160_000, problems: ["packages/core-game/test/art-atlas.test.ts > x"] },
        skip("build", "build + budget", "не затронуты"),
      ],
    });
    expect(report).toContain("| Шаг | Итог | Время |");
    expect(report).toContain("|---|---|---|");
    expect(report).toContain("| typecheck | ✅ | 1 м 12 с |");
    expect(report).toContain("| тесты core-game, app-shell | ❌ 2 упали | 2 м 40 с |");
    expect(report).toContain("| build + budget | ⏭ не затронуты | — |");
  });

  it("раздел «Упало» — с проблемами упавших шагов; без падений его нет", () => {
    const failed: Step = { id: "tests", label: "тесты core-game", status: "fail", detail: "1 упал", ms: 1000, problems: ["a.test.ts > b"] };
    const withFail: string = buildReport({ ...header, results: [failed] });
    expect(withFail).toContain("Упало:");
    expect(withFail).toContain("a.test.ts > b");
    expect(buildReport({ ...header, results: [ok("typecheck", "typecheck")] })).not.toContain("Упало:");
  });

  it("❌ без пояснения — просто ❌", () => {
    const report: string = buildReport({ ...header, results: [{ id: "zones", label: "зоны задачи", status: "fail", ms: 1000, problems: [] }] });
    expect(report).toContain("| зоны задачи | ❌ | 1 с |");
  });

  it("вывод ничем не обрамлён и не содержит ограждения кода", () => {
    const report: string = buildReport({ ...header, results: [ok("typecheck", "typecheck")] });
    expect(report).not.toContain("```");
    expect(report.startsWith("## Проверено (pnpm verify)")).toBe(true);
  });
});

describe("exitCodeOf: код выхода", () => {
  it("0, когда всё ✅ или ⏭", () => {
    expect(exitCodeOf([ok("a", "a"), skip("b", "b", "x")])).toBe(0);
    expect(exitCodeOf([])).toBe(0);
  });

  it("1, если хоть один шаг красный", () => {
    expect(exitCodeOf([ok("a", "a"), { id: "b", label: "b", status: "fail", ms: 1 }])).toBe(1);
  });
});

describe("onlyScriptsChanged: правка только раздела scripts корневого package.json", () => {
  const before = JSON.stringify({ name: "x", scripts: { a: "1" }, devDependencies: { vitest: "5.0.0" } });

  it("новый скрипт зависимостей не задевает", () => {
    const after = JSON.stringify({ name: "x", scripts: { a: "1", verify: "2" }, devDependencies: { vitest: "5.0.0" } });
    expect(onlyScriptsChanged(before, after)).toBe(true);
  });

  it("смена зависимости или версии движка — задевает всё", () => {
    const deps = JSON.stringify({ name: "x", scripts: { a: "1" }, devDependencies: { vitest: "5.1.0" } });
    const engines = JSON.stringify({ name: "x", scripts: { a: "1" }, devDependencies: { vitest: "5.0.0" }, engines: { node: "24" } });
    expect(onlyScriptsChanged(before, deps)).toBe(false);
    expect(onlyScriptsChanged(before, engines)).toBe(false);
  });

  it("нечитаемый JSON или отсутствие прежней версии — осторожно: задевает всё", () => {
    expect(onlyScriptsChanged("{", before)).toBe(false);
    expect(onlyScriptsChanged(before, "")).toBe(false);
    expect(onlyScriptsChanged(null, before)).toBe(false);
  });
});
