import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет и не нужно
import { ciOf, trainStatus } from "../lead/train-status.mjs";
// @ts-expect-error — утилита на чистом JS, типов у неё нет и не нужно
import { leadPaths, resolveLeadRoot } from "../lead/paths.mjs";
// @ts-expect-error — утилита на чистом JS, типов у неё нет и не нужно
import { runningAgents } from "../lead/workflow-running.mjs";

// Конвейер тимлида в репозитории (T-0477, Р224, E): поезд мерджей, статус,
// ожидание работы и сценарий Workflow. Состояние — в игнорируемой `.lead/`.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const LEAD = join(ROOT, "scripts", "lead");
const PIPELINE = join(ROOT, ".claude", "workflows", "pipeline.js");

const lines = (...rows: string[]): string => rows.join("\n") + "\n";

describe("train-status: состояние поезда по файлам очереди, итогов и провалов", () => {
  it("пустые файлы — пустое состояние", () => {
    expect(trainStatus({ queue: "", done: "", failed: "" })).toEqual({ queued: [], approved: [], failed: [] });
  });

  it("поставленный в очередь PR без итога ещё поедет", () => {
    const s = trainStatus({ queue: lines("101", "102"), done: "", failed: "" });
    expect(s.queued).toEqual([101, 102]);
    expect(s.approved).toEqual([101, 102]);
  });

  it("влитый PR из ожидающих уходит, но остаётся одобренным", () => {
    const s = trainStatus({ queue: lines("101", "102"), done: lines("101 влит пачкой"), failed: "" });
    expect(s.queued).toEqual([102]);
    expect(s.approved).toEqual([101, 102]);
  });

  it("провал без повторной постановки — открытый провал с причиной и номером строки", () => {
    const s = trainStatus({ queue: lines("101"), done: "", failed: lines("101 конфликт с dev: a.ts") });
    expect(s.queued).toEqual([]);
    expect(s.failed).toEqual([{ line: 1, pr: 101, reason: "конфликт с dev: a.ts" }]);
  });

  it("повторная постановка после провала: PR снова едет и не числится провалом", () => {
    const s = trainStatus({ queue: lines("101", "101"), done: "", failed: lines("101 красный CI") });
    expect(s.queued).toEqual([101]);
    expect(s.failed).toEqual([]);
  });

  it("повторная постановка, и PR снова не прошёл — провал открыт, строка последняя", () => {
    const s = trainStatus({
      queue: lines("101", "101"),
      done: "",
      failed: lines("101 первый провал", "102 чужой", "101 второй провал"),
    });
    expect(s.queued).toEqual([]);
    expect(s.failed).toEqual([
      { line: 2, pr: 102, reason: "чужой" },
      { line: 3, pr: 101, reason: "второй провал" },
    ]);
  });

  it("повторная постановка и влитие — ни очереди, ни провала", () => {
    const s = trainStatus({ queue: lines("101", "101"), done: lines("101 влит"), failed: lines("101 красный CI") });
    expect(s.queued).toEqual([]);
    expect(s.failed).toEqual([]);
  });

  it("устаревшие строки «0 …» провалами не считаются, но номера строк сохраняются", () => {
    const s = trainStatus({ queue: lines("7"), done: "", failed: lines("0 старая запись", "7 новый провал") });
    expect(s.failed).toEqual([{ line: 2, pr: 7, reason: "новый провал" }]);
  });

  it("пустые строки, комментарии и CRLF не мешают", () => {
    const s = trainStatus({ queue: "\r\n# заметка\r\n55\r\n\r\n", done: "", failed: "\r\n55 причина\r\n" });
    expect(s.approved).toEqual([55]);
    expect(s.failed).toEqual([{ line: 2, pr: 55, reason: "причина" }]);
  });

  it("одобренные — без повторов, в порядке первой постановки", () => {
    const s = trainStatus({ queue: lines("9", "3", "9", "3", "9"), done: "", failed: "" });
    expect(s.approved).toEqual([9, 3]);
  });
});

describe("ciOf: итог проверок по последнему прогону каждого имени", () => {
  const row = (name: string, state: string, startedAt: string) => ({ name, state, startedAt });

  it("обе проверки зелёные", () => {
    expect(ciOf([row("gate", "SUCCESS", "2026-11-13T10:00:00Z"), row("check", "SUCCESS", "2026-11-13T10:00:00Z")])).toBe("GREEN GREEN");
  });

  it("старый красный прогон перекрыт новым зелёным", () => {
    expect(
      ciOf([
        row("gate", "FAILURE", "2026-11-13T09:00:00Z"),
        row("gate", "SUCCESS", "2026-11-13T10:00:00Z"),
        row("check", "SUCCESS", "2026-11-13T10:00:00Z"),
      ]),
    ).toBe("GREEN GREEN");
  });

  it("старый зелёный прогон не спасает новый красный", () => {
    expect(
      ciOf([
        row("gate", "SUCCESS", "2026-11-13T09:00:00Z"),
        row("gate", "FAILURE", "2026-11-13T10:00:00Z"),
        row("check", "SUCCESS", "2026-11-13T10:00:00Z"),
      ]),
    ).toBe("RED GREEN");
  });

  it("отменённый старый прогон при идущем новом — ждём, а не красное", () => {
    expect(
      ciOf([
        row("gate", "CANCELLED", "2026-11-13T09:00:00Z"),
        row("gate", "IN_PROGRESS", "2026-11-13T10:00:00Z"),
        row("check", "PENDING", "2026-11-13T10:00:00Z"),
      ]),
    ).toBe("PENDING PENDING");
  });

  it("нет проверки — NONE; чужие проверки (board) не считаются", () => {
    expect(ciOf([row("board", "FAILURE", "2026-11-13T10:00:00Z")])).toBe("NONE NONE");
    expect(ciOf([])).toBe("NONE NONE");
  });

  it("каждое красное состояние — RED", () => {
    for (const state of ["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
      expect(ciOf([row("gate", state, "2026-11-13T10:00:00Z"), row("check", "SUCCESS", "2026-11-13T10:00:00Z")])).toBe("RED GREEN");
    }
  });
});

describe("paths: корень, состояние и рабочая копия поезда", () => {
  it("LEAD_ROOT из окружения сильнее git", () => {
    expect(resolveLeadRoot({ env: { LEAD_ROOT: "/srv/clone" }, commonDir: "/x/.git", toplevel: "/y" })).toBe("/srv/clone");
  });

  it("из связанной рабочей копии корень — основной клон по общему каталогу git", () => {
    expect(resolveLeadRoot({ env: {}, commonDir: "F:/projects/rubezh/.git", toplevel: "F:/projects/rubezh/.claude/worktrees/w1" })).toBe("F:/projects/rubezh");
  });

  it("обратные слэши Windows приводятся к прямым", () => {
    expect(resolveLeadRoot({ env: {}, commonDir: "F:\\projects\\rubezh\\.git", toplevel: "F:\\projects\\rubezh" })).toBe("F:/projects/rubezh");
  });

  it("общий каталог не `.git` (bare, нестандартная раскладка) — корень рабочей копии", () => {
    expect(resolveLeadRoot({ env: {}, commonDir: "/srv/repo.git", toplevel: "/srv/work" })).toBe("/srv/work");
  });

  it("состояние — .lead/ в корне, поезд — .claude/worktrees/train, всё переопределяется", () => {
    const p = leadPaths("/r", {});
    expect(p.dir).toBe("/r/.lead");
    expect(p.queue).toBe("/r/.lead/train-queue.txt");
    expect(p.done).toBe("/r/.lead/train-done.txt");
    expect(p.failed).toBe("/r/.lead/train-failed.txt");
    expect(p.log).toBe("/r/.lead/train.log");
    expect(p.trainWorktree).toBe("/r/.claude/worktrees/train");
    const o = leadPaths("/r", { LEAD_DIR: "/tmp/l", TRAIN_WT: "/tmp/t" });
    expect(o.dir).toBe("/tmp/l");
    expect(o.queue).toBe("/tmp/l/train-queue.txt");
    expect(o.trainWorktree).toBe("/tmp/t");
  });
});

describe("workflow-running: сколько агентов сценария идут", () => {
  const j = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

  it("started без result — идёт", () => {
    const text = j(
      { type: "started", key: "a", label: "ревью #1" },
      { type: "started", key: "b", label: "код T-0002" },
      { type: "result", key: "a" },
    );
    expect(runningAgents(text)).toEqual({ count: 1, labels: ["код T-0002"] });
  });

  it("пустой журнал — ноль", () => {
    expect(runningAgents("")).toEqual({ count: 0, labels: [] });
  });
});

describe("файлы конвейера", () => {
  const names = [
    "paths.sh",
    "paths.mjs",
    "train.sh",
    "merge-one.sh",
    "wait-checks.sh",
    "wait-work.sh",
    "enqueue.sh",
    "test-env.sh",
    "train-status.mjs",
    "workflow-running.mjs",
    "metrics.mjs",
    "review-stats.mjs",
  ];

  it("все на месте", () => {
    for (const name of names) expect(existsSync(join(LEAD, name)), name).toBe(true);
    expect(existsSync(PIPELINE)).toBe(true);
  });

  it("без абсолютных путей машины, адресов и секретов", () => {
    const files = [...names.map((n) => join(LEAD, n)), PIPELINE];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\b[A-Za-z]:[\\/]/);
      expect(text, file).not.toMatch(/\/(?:f|d|c)\/projects/i);
      expect(text, file).not.toMatch(/scratchpad/);
      expect(text, file).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      expect(text, file).not.toMatch(/(?:token|secret|password)\s*=\s*["'][^"']{6,}/i);
    }
  });

  it("shell-скрипты: bash-шебанг, LF, бит исполняемости в git", () => {
    const sh = names.filter((n) => n.endsWith(".sh") && n !== "paths.sh");
    for (const name of sh) {
      const text = readFileSync(join(LEAD, name), "utf8");
      expect(text.startsWith("#!/usr/bin/env bash\n"), name).toBe(true);
      expect(text, name).not.toContain("\r");
    }
    const out = execFileSync("git", ["ls-files", "-s", "--", "scripts/lead"], { cwd: ROOT, encoding: "utf8" });
    for (const name of sh) {
      expect(out, `${name}: бит исполняемости`).toMatch(new RegExp(`^100755 .*scripts/lead/${name.replace(".", "\\.")}$`, "m"));
    }
  });

  it.skipIf(process.platform === "win32")("shell-скрипты проходят bash -n", () => {
    for (const name of names.filter((n) => n.endsWith(".sh"))) {
      expect(() => execFileSync("bash", ["-n", join(LEAD, name)]), name).not.toThrow();
    }
  });

  it("в каталоге скриптов нет лишнего", () => {
    expect(readdirSync(LEAD).sort()).toEqual([...names].sort());
  });

  it(".lead/ в .gitignore", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/);
    expect(ignore).toContain(".lead/");
  });

  it.skipIf(process.platform === "win32")("enqueue.sh дописывает номер в очередь выбранного .lead и отвергает мусор", () => {
    const dir = mkdtempSync(join(tmpdir(), "lead-"));
    try {
      const env = { ...process.env, LEAD_DIR: dir };
      execFileSync("bash", [join(LEAD, "enqueue.sh"), "123"], { env });
      execFileSync("bash", [join(LEAD, "enqueue.sh"), "123"], { env });
      expect(readFileSync(join(dir, "train-queue.txt"), "utf8")).toBe("123\n123\n");
      expect(() => execFileSync("bash", [join(LEAD, "enqueue.sh"), "abc; rm"], { env, stdio: "pipe" })).toThrow();
      expect(readFileSync(join(dir, "train-queue.txt"), "utf8")).toBe("123\n123\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Сценарий исполняется с подставным agent: проверяется, кто и как ревьюирует,
// а не работа настоящих агентов.
type Call = { prompt: string; opts: { label?: string; model?: string; effort?: string } };

async function runPipeline(args: Record<string, unknown>, scoutPr: { effort: string } | null): Promise<Call[]> {
  const source = readFileSync(PIPELINE, "utf8").replace("export const meta =", "const meta =");
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...a: string[]) => (...v: unknown[]) => Promise<unknown>;
  const run = new AsyncFunction("args", "agent", "log", source);
  const calls: Call[] = [];
  let scouted = false;
  const agent = async (prompt: string, opts: Call["opts"]): Promise<unknown> => {
    calls.push({ prompt, opts });
    const label = opts.label ?? "";
    const none = { kind: "none", pr: 0, branch: "", task: "", effort: "", executor: "", lead: false, failLine: 0, reason: "" };
    if (label === "поиск работы") {
      if (scoutPr && !scouted) {
        scouted = true;
        return { ...none, kind: "review", pr: 11, branch: "task/T-0001", task: "T-0001", effort: scoutPr.effort, executor: "sonnet-5.5", lead: true };
      }
      return none;
    }
    if (label.startsWith("ревью #")) return { verdict: "approve", difficulty: false, enqueued: false, issues: [], nits: [], questions: [] };
    return undefined;
  };
  await run(args, agent, () => undefined);
  return calls;
}

describe("pipeline.js: сценарий конвейера", () => {
  const args = { lanes: 1, maxTasks: 0, priority: ["P0", "P1"], exclude: ["T-0999"], skipPrs: [] };

  it("называется pipeline и лежит в .claude/workflows", () => {
    expect(readFileSync(PIPELINE, "utf8")).toMatch(/export const meta = \{\s*name: 'pipeline'/);
  });

  it("обычный PR проверяет один ревьюер и ставит в поезд через enqueue.sh", async () => {
    const calls = await runPipeline(args, { effort: "high" });
    const reviews = calls.filter((c) => c.opts.label?.startsWith("ревью #"));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.opts.model).toBe("sonnet");
    expect(reviews[0]?.prompt).toContain("enqueue.sh 11");
    expect(reviews[0]?.opts.label).not.toContain("·");
  });

  it("effort: extra — два ревьюера с линзами «корректность» и «безопасность», в поезд ставит сценарий", async () => {
    const calls = await runPipeline(args, { effort: "extra" });
    const reviews = calls.filter((c) => c.opts.label?.startsWith("ревью #"));
    expect(reviews.map((c) => c.opts.label)).toEqual(["ревью #11 T-0001 · корректность", "ревью #11 T-0001 · безопасность"]);
    for (const r of reviews) {
      expect(r.opts.model).toBe("opus");
      expect(r.prompt).not.toContain("enqueue.sh");
    }
    const enqueue = calls.filter((c) => c.opts.label === "в поезд #11");
    expect(enqueue).toHaveLength(1);
    expect(enqueue[0]?.prompt).toContain("enqueue.sh 11");
  });

  it("корень репозитория из аргументов попадает в команды агентов", async () => {
    const calls = await runPipeline({ ...args, root: "/srv/clone" }, { effort: "high" });
    const wait = calls.find((c) => c.opts.label === "ожидание работы");
    expect(wait?.prompt).toContain("/srv/clone/scripts/lead/wait-work.sh");
    const scout = calls.find((c) => c.opts.label === "поиск работы");
    expect(scout?.prompt).toContain("/srv/clone/scripts/lead/train-status.mjs");
  });

  it("исключённые задачи называются в правилах из аргументов, а не зашиты", () => {
    const text = readFileSync(PIPELINE, "utf8");
    expect(text).not.toMatch(/claude-10 \(T-/);
    expect(text).toContain("A.exclude");
  });
});

describe("документация конвейера", () => {
  it("tasks/README.md описывает запуск поезда, сценария, состояние и провалы", () => {
    const text = readFileSync(join(ROOT, "tasks", "README.md"), "utf8");
    expect(text).toContain("## Конвейер тимлида");
    for (const needle of ["scripts/lead/train.sh", "scripts/lead/merge-one.sh", ".lead/", "train-failed.txt", "pipeline", "train-status.mjs"]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("docs/09-ci-cd.md §8 объясняет поезд мерджей и правило свежести dev", () => {
    const text = readFileSync(join(ROOT, "docs", "09-ci-cd.md"), "utf8");
    expect(text).toContain("Поезд мерджей");
  });
});
