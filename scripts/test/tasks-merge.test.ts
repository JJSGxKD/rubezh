import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { SELF_CHECK_MIN_ITEMS, checkProblems, mergeArgs, mergeProblems, selfCheckProblems, teamSummary } from "../tasks/merge.mjs";

// Команда `pnpm task merge` (T-0349, Р176): чистая проверка, можно ли вливать PR
// задачи самому потоку. Сеть и git сюда не приходят — всё подаётся готовым.

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);

type Json = Record<string, unknown>;

function devTask(patch: Json = {}): Json {
  return {
    id: "T-0500",
    status: "ready",
    owner: "",
    effort: "medium",
    runner: "any",
    merge: "self",
    zones: ["docs/x.md"],
    shared: [],
    ...patch,
  };
}

function branchTask(patch: Json = {}): Json {
  return { ...devTask(), status: "done", owner: "claude-1 / sonnet-5.5 / medium", ...patch };
}

function run(name: string, conclusion: string, extra: Json = {}): Json {
  return { __typename: "CheckRun", name, workflowName: "CI", status: "COMPLETED", conclusion, startedAt: "2026-10-28T10:00:00Z", ...extra };
}

function pr(patch: Json = {}): Json {
  return {
    headRefName: "task/T-0500",
    state: "OPEN",
    isDraft: false,
    labels: [{ name: "release: patch" }, { name: "на ревью" }],
    statusCheckRollup: [run("check", "SUCCESS"), run("gate", "SUCCESS"), run("board", "SUCCESS")],
    ...patch,
  };
}

const CHECKLIST = Array.from({ length: SELF_CHECK_MIN_ITEMS }, (_, index) => `- [x] пункт ${String(index + 1)}`);

function selfCheck(patch: { name?: string; head?: string; items?: string[]; first?: string } = {}): Json {
  const lines = [patch.first ?? `**${patch.name ?? "claude-1"}:** самопроверка по review-pr`, `head: ${patch.head ?? HEAD}`, "", ...(patch.items ?? CHECKLIST)];
  return { body: lines.join("\n"), createdAt: "2026-10-28T11:00:00Z" };
}

function problems(patch: Json = {}): string[] {
  return mergeProblems({ task: devTask(), branchTask: branchTask(), pr: pr(), mergeable: "MERGEABLE", comments: [selfCheck()], headSha: HEAD, ...patch });
}

describe("mergeProblems: всё сходится", () => {
  it("пометка в dev, PR на ревью, проверки зелёные, самопроверка на голове — причин нет", () => {
    expect(problems()).toEqual([]);
  });

  it("красный board не помеха", () => {
    const rollup = [run("check", "SUCCESS"), run("gate", "SUCCESS"), run("board", "FAILURE")];
    expect(problems({ pr: pr({ statusCheckRollup: rollup }) })).toEqual([]);
  });

  it("SKIPPED и NEUTRAL у прочих проверок не помеха", () => {
    const rollup = [run("check", "SUCCESS"), run("gate", "SUCCESS"), run("docker", "SKIPPED"), run("lint", "NEUTRAL")];
    expect(problems({ pr: pr({ statusCheckRollup: rollup }) })).toEqual([]);
  });
});

describe("mergeProblems: пометка читается из dev", () => {
  it("merge: lead в dev при merge: self в ветке — отказ с пояснением «из dev»", () => {
    const result = problems({ task: devTask({ merge: "lead" }), branchTask: branchTask({ merge: "self" }) });
    expect(result.some((problem) => problem.includes("пометка") && problem.includes("из origin/dev"))).toBe(true);
  });

  it("в dev поля merge нет — это lead", () => {
    const task = devTask();
    delete task.merge;
    expect(problems({ task }).some((problem) => problem.includes("из origin/dev"))).toBe(true);
  });

  it("задачи нет в dev — отказ", () => {
    expect(problems({ task: null }).some((problem) => problem.includes("нет в origin/dev"))).toBe(true);
  });

  it("запретные зоны в dev — отказ, даже если пометка стоит", () => {
    const result = problems({ task: devTask({ zones: ["backend/api/prisma/schema.prisma"] }), branchTask: branchTask({ zones: ["backend/api/prisma/schema.prisma"] }) });
    expect(result.some((problem) => problem.includes("backend/api/prisma/schema.prisma"))).toBe(true);
  });

  it("effort: extra в dev — отказ", () => {
    const result = problems({ task: devTask({ effort: "extra" }), branchTask: branchTask({ effort: "extra" }) });
    expect(result.some((problem) => problem.includes("effort: extra"))).toBe(true);
  });

  it("поток расширил зоны в своей ветке — отказ, поле названо", () => {
    const result = problems({ branchTask: branchTask({ zones: ["docs/x.md", "infra/prod.yml"] }) });
    expect(result.some((problem) => problem.includes("zones") && problem.includes("отличается от origin/dev"))).toBe(true);
  });

  it("вынужденный файл, дописанный в shared ветки, не мешает", () => {
    expect(problems({ branchTask: branchTask({ shared: ["docs/y.md"] }) })).toEqual([]);
  });

  it("запретный путь, дописанный в shared ветки, — отказ с причиной Р176", () => {
    const result = problems({ branchTask: branchTask({ shared: ["backend/api/prisma/schema.prisma"] }) });
    expect(result.some((problem) => problem.includes("Р176") && problem.includes("backend/api/prisma/schema.prisma"))).toBe(true);
  });

  it("поток поменял effort, runner или merge в ветке — отказ", () => {
    for (const patch of [{ effort: "low" }, { runner: "local" }, { merge: "lead" }]) {
      const field = Object.keys(patch)[0];
      const result = problems({ branchTask: branchTask(patch) });
      expect(result.some((problem) => problem.includes(field) && problem.includes("отличается от origin/dev")), field).toBe(true);
    }
  });

  it("порядок зон не важен", () => {
    const task = devTask({ zones: ["docs/a.md", "docs/b.md"] });
    expect(problems({ task, branchTask: branchTask({ zones: ["docs/b.md", "docs/a.md"] }) })).toEqual([]);
  });
});

describe("mergeProblems: файл задачи в ветке", () => {
  it("файла нет — отказ", () => {
    expect(problems({ branchTask: null }).some((problem) => problem.includes("нет файла задачи"))).toBe(true);
  });

  it("status: in-progress в ветке — отказ", () => {
    const result = problems({ branchTask: branchTask({ status: "in-progress" }) });
    expect(result.some((problem) => problem.includes("status: done") && problem.includes("in-progress"))).toBe(true);
  });
});

describe("mergeProblems: PR и метка статуса", () => {
  it("черновик — отказ", () => {
    expect(problems({ pr: pr({ isDraft: true }) }).some((problem) => problem.includes("черновик"))).toBe(true);
  });

  it("PR не открыт — отказ", () => {
    expect(problems({ pr: pr({ state: "MERGED" }) }).some((problem) => problem.includes("не открыт"))).toBe(true);
  });

  it("ветка не task/T-NNNN — отказ", () => {
    expect(problems({ pr: pr({ headRefName: "feature/x" }) }).some((problem) => problem.includes("task/T-NNNN"))).toBe(true);
  });

  it("метка «в работе» вместо «на ревью» — отказ", () => {
    const labels = [{ name: "release: patch" }, { name: "в работе" }];
    expect(problems({ pr: pr({ labels }) }).some((problem) => problem.includes("«в работе»") && problem.includes("«на ревью»"))).toBe(true);
  });

  it("«доработка» и «ждёт владельца» — отказ", () => {
    for (const name of ["доработка", "ждёт владельца"]) {
      expect(problems({ pr: pr({ labels: [{ name }] }) }).length, name).toBeGreaterThan(0);
    }
  });

  it("две метки статуса — отказ", () => {
    const labels = [{ name: "на ревью" }, { name: "в работе" }];
    expect(problems({ pr: pr({ labels }) }).some((problem) => problem.includes("несколько"))).toBe(true);
  });

  it("метки статуса нет вовсе — отказ", () => {
    expect(problems({ pr: pr({ labels: [{ name: "release: patch" }] }) }).some((problem) => problem.includes("нет метки статуса"))).toBe(true);
  });
});

describe("mergeProblems: проверки CI", () => {
  const withRollup = (rollup: Json[]): string[] => problems({ pr: pr({ statusCheckRollup: rollup }) });

  it("gate красный — отказ с названием проверки", () => {
    const result = withRollup([run("check", "SUCCESS"), run("gate", "FAILURE")]);
    expect(result.some((problem) => problem.includes("gate"))).toBe(true);
  });

  it("gate идёт — отказ", () => {
    const result = withRollup([run("check", "SUCCESS"), run("gate", "", { status: "IN_PROGRESS" })]);
    expect(result.some((problem) => problem.includes("gate") && problem.includes("не завершена"))).toBe(true);
  });

  it("любая другая проверка красная или идёт — отказ", () => {
    expect(withRollup([run("check", "SUCCESS"), run("gate", "SUCCESS"), run("docker", "FAILURE")]).some((problem) => problem.includes("docker"))).toBe(true);
    expect(withRollup([run("check", "SUCCESS"), run("gate", "SUCCESS"), run("docker", "", { status: "QUEUED" })]).some((problem) => problem.includes("docker"))).toBe(true);
  });

  it("CANCELLED, TIMED_OUT, ACTION_REQUIRED — отказ", () => {
    for (const conclusion of ["CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
      expect(withRollup([run("check", "SUCCESS"), run("gate", conclusion)]).length, conclusion).toBeGreaterThan(0);
    }
  });

  it("упавший StatusContext — отказ, успешный — нет", () => {
    const status = (state: string): Json => ({ __typename: "StatusContext", context: "ci/legacy", state });
    expect(withRollup([run("check", "SUCCESS"), run("gate", "SUCCESS"), status("FAILURE")]).some((problem) => problem.includes("ci/legacy"))).toBe(true);
    expect(withRollup([run("check", "SUCCESS"), run("gate", "SUCCESS"), status("PENDING")]).some((problem) => problem.includes("ci/legacy"))).toBe(true);
    expect(withRollup([run("check", "SUCCESS"), run("gate", "SUCCESS"), status("SUCCESS")])).toEqual([]);
  });

  it("проверок gate и check ещё нет — отказ: пустой список не зелёный", () => {
    expect(withRollup([]).length).toBeGreaterThanOrEqual(2);
    expect(withRollup([run("check", "SUCCESS")]).some((problem) => problem.includes("gate"))).toBe(true);
    expect(withRollup([run("gate", "SUCCESS")]).some((problem) => problem.includes("check"))).toBe(true);
  });

  it("отменённый прежний прогон не мешает, если новее есть зелёный той же проверки", () => {
    const old = run("check", "CANCELLED", { startedAt: "2026-10-28T10:00:00Z" });
    const fresh = run("check", "SUCCESS", { startedAt: "2026-10-28T10:05:00Z" });
    expect(withRollup([old, run("gate", "SUCCESS"), fresh])).toEqual([]);
    expect(withRollup([fresh, run("gate", "SUCCESS"), old])).toEqual([]);
  });

  it("красный прогон новее зелёного — отказ", () => {
    const old = run("gate", "SUCCESS", { startedAt: "2026-10-28T10:00:00Z" });
    const fresh = run("gate", "FAILURE", { startedAt: "2026-10-28T10:05:00Z" });
    expect(withRollup([run("check", "SUCCESS"), old, fresh]).some((problem) => problem.includes("gate"))).toBe(true);
  });

  it("список проверок не пришёл — отказ", () => {
    expect(problems({ pr: pr({ statusCheckRollup: undefined }) }).length).toBeGreaterThan(0);
  });

  it("checkProblems: пустые причины на зелёном", () => {
    expect(checkProblems([run("check", "SUCCESS"), run("gate", "SUCCESS")])).toEqual([]);
  });
});

describe("mergeProblems: конфликты", () => {
  it("CONFLICTING — отказ с подсказкой влить dev", () => {
    expect(problems({ mergeable: "CONFLICTING" }).some((problem) => problem.includes("конфликт") && problem.includes("dev"))).toBe(true);
  });

  it("UNKNOWN — отказ: GitHub ещё не посчитал", () => {
    expect(problems({ mergeable: "UNKNOWN" }).some((problem) => problem.includes("не посчитал"))).toBe(true);
  });

  it("значения нет — отказ", () => {
    expect(problems({ mergeable: undefined }).length).toBeGreaterThan(0);
  });
});

describe("mergeProblems: самопроверка", () => {
  it("комментария нет — отказ с форматом", () => {
    const result = problems({ comments: [] });
    expect(result.some((problem) => problem.includes("самопроверка по review-pr") && problem.includes("head:"))).toBe(true);
  });

  it("чужой комментарий без подписи — не самопроверка", () => {
    expect(problems({ comments: [{ body: "LGTM" }] }).some((problem) => problem.includes("самопроверк"))).toBe(true);
  });

  it("в списке есть «- [ ]» — отказ", () => {
    const items = [...CHECKLIST, "- [ ] документы обновлены"];
    expect(problems({ comments: [selfCheck({ items })] }).some((problem) => problem.includes("не отмечен"))).toBe(true);
  });

  it("отмечено меньше пунктов приёмки — отказ", () => {
    const items = CHECKLIST.slice(0, SELF_CHECK_MIN_ITEMS - 1);
    expect(problems({ comments: [selfCheck({ items })] }).some((problem) => problem.includes(String(SELF_CHECK_MIN_ITEMS)))).toBe(true);
  });

  it("head: не совпадает с головой PR — отказ с обоими SHA", () => {
    const result = problems({ comments: [selfCheck({ head: OTHER_HEAD })] });
    expect(result.some((problem) => problem.includes(OTHER_HEAD) && problem.includes(HEAD))).toBe(true);
  });

  it("строки head: нет вовсе — отказ", () => {
    const comment = { body: ["**claude-1:** самопроверка по review-pr", "", ...CHECKLIST].join("\n") };
    expect(problems({ comments: [comment] }).some((problem) => problem.includes("head:"))).toBe(true);
  });

  it("сокращённый SHA — отказ: нужен полный", () => {
    expect(problems({ comments: [selfCheck({ head: HEAD.slice(0, 7) })] }).length).toBeGreaterThan(0);
  });

  it("первая строка не по формату — отказ", () => {
    expect(problems({ comments: [selfCheck({ first: "claude-1: самопроверка по review-pr" })] }).length).toBeGreaterThan(0);
    expect(problems({ comments: [selfCheck({ first: "**claude-1:** проверил" })] }).length).toBeGreaterThan(0);
  });

  it("самопроверка от другого потока, чем в owner ветки, — отказ", () => {
    const result = problems({ comments: [selfCheck({ name: "claude-7" })] });
    expect(result.some((problem) => problem.includes("claude-7") && problem.includes("claude-1"))).toBe(true);
  });

  it("поток не определён в owner ветки — отказ", () => {
    expect(problems({ branchTask: branchTask({ owner: "" }) }).some((problem) => problem.includes("owner"))).toBe(true);
  });

  it("старая самопроверка на прежней голове и новая на текущей — проходит", () => {
    expect(problems({ comments: [selfCheck({ head: OTHER_HEAD }), selfCheck()] })).toEqual([]);
  });

  it("полная самопроверка и неполная на той же голове позже — берётся последняя", () => {
    const items = [...CHECKLIST, "- [ ] ещё не смотрел"];
    expect(problems({ comments: [selfCheck(), selfCheck({ items })] }).length).toBeGreaterThan(0);
  });

  it("CRLF и заглавная X в галочке читаются", () => {
    const body = [`**claude-1:** самопроверка по review-pr`, `head: ${HEAD}`, ...CHECKLIST.map((line) => line.replace("[x]", "[X]"))].join("\r\n");
    expect(problems({ comments: [{ body }] })).toEqual([]);
  });

  it("selfCheckProblems без комментариев — одна причина", () => {
    expect(selfCheckProblems([], HEAD, "claude-1")).toHaveLength(1);
  });
});

describe("mergeProblems: голова PR", () => {
  it("головы нет — отказ", () => {
    expect(problems({ headSha: "" }).length).toBeGreaterThan(0);
    expect(problems({ headSha: undefined }).length).toBeGreaterThan(0);
  });

  it("несколько причин собираются вместе", () => {
    const result = problems({ pr: pr({ isDraft: true }), mergeable: "CONFLICTING", comments: [] });
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});

describe("mergeArgs: команда мерджа", () => {
  it("merge-коммит и привязка к проверенной голове, без обходов", () => {
    expect(mergeArgs(7, HEAD)).toEqual(["pr", "merge", "7", "--merge", "--match-head-commit", HEAD]);
  });

  it("номер и SHA другого вида — исключение: команда не собирается из мусора", () => {
    expect(() => mergeArgs("7; rm", HEAD)).toThrow();
    expect(() => mergeArgs(7, "abc")).toThrow();
    expect(() => mergeArgs(0, HEAD)).toThrow();
  });
});

describe("teamSummary: сводка из описания PR", () => {
  it("берёт раздел до следующего «## » и обрезает пустые края", () => {
    const body = ["Задача: tasks/T-0500-x.md", "", "## Сводка для команды", "", "🚦 **СВОДКА: В DEV ВЛИТ PR #7**", "", "Текст.", "", "## Для игроков", "", "Нет"].join("\n");
    expect(teamSummary(body)).toBe("🚦 **СВОДКА: В DEV ВЛИТ PR #7**\n\nТекст.");
  });

  it("раздел в конце описания — до конца", () => {
    expect(teamSummary("## Сводка для команды\n\nСтрока.\n")).toBe("Строка.");
  });

  it("раздела нет или описание пустое — null", () => {
    expect(teamSummary("## Для игроков\n\nНет")).toBeNull();
    expect(teamSummary("")).toBeNull();
    expect(teamSummary(undefined)).toBeNull();
  });
});
