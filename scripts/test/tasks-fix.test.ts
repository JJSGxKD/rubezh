import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { planFix } from "../tasks/fix.mjs";

// План `pnpm task fix` и `pnpm task archive` (tasks/T-0343): fix ставит значки,
// ссылки и ячейки эпиков по тому, где файлы лежат сейчас, и ничего не переносит;
// archive ещё и переносит закрытые задачи в архив и возвращает открытые наверх.

interface TaskFile {
  name: string;
  text: string;
}

const EPICS = ["| Эпик | Цель | Приоритет | Задачи |", "|---|---|---|---|", "| **E0. Процесс** | Цель | P0 | — |"].join("\n");

/** Файл задачи без строки значков и со ссылками из `body`: значки поставит сам план. */
function task(id: string, slug: string, patch: Record<string, string> = {}, body = "", dir = ""): TaskFile {
  const fields: Record<string, string> = {
    id,
    title: "Задача",
    epic: "E0",
    priority: "P1",
    status: "ready",
    owner: "",
    size: "S",
    depends_on: "[]",
    zones: "[a.ts]",
    shared: "[]",
    runner: "any",
    executor: "sonnet-5.5",
    effort: "medium",
    release: "patch",
    design: "null",
    ...patch,
  };
  const lines = Object.entries(fields).map(([key, value]) => `${key}:${value === "" ? "" : ` ${value}`}`);
  const pr = ["## PR", "", "- **Заголовок:** `fix(app-shell): Чинить X`", `- **Метка:** \`release: ${fields.release}\``, ""];
  return { name: `${dir}${id}-${slug}.md`, text: ["---", ...lines, "---", "", `# ${id}. Задача`, "", "", body, "", ...pr].join("\n") };
}

/** Применить план к списку файлов в памяти: переносы по именам, затем новые тексты. */
function apply(files: TaskFile[], plan: { moves: { from: string; to: string }[]; files: TaskFile[] }): TaskFile[] {
  const moved = files.map((file) => ({ ...file, name: plan.moves.find((move) => move.from === file.name)?.to ?? file.name }));
  return moved.map((file) => plan.files.find((changed) => changed.name === file.name) ?? file);
}

const textOf = (files: TaskFile[], name: string): string => files.find((file) => file.name === name)?.text ?? "";

/** Набор A: закрытая задача наверху и открытая, которая от неё зависит и ссылается на неё в тексте. */
function setA(): TaskFile[] {
  const files = [
    { name: "epics.md", text: EPICS },
    task("T-9001", "a", { status: "done" }),
    task("T-9002", "b", { depends_on: "[T-9001]" }, "См. [T-9001](T-9001-a.md#решения)."),
  ];
  // Нормализация: один fix, чтобы значки и ячейки были в том виде, который ставит команда.
  return apply(files, planFix(files, { archive: false }));
}

describe("fix — без переноса", () => {
  it("закрытая задача остаётся наверху, ссылки на неё не трогаются: план пуст", () => {
    expect(planFix(setA(), { archive: false })).toEqual({ moves: [], files: [] });
  });

  it("значок новой задачи встаёт в ячейку эпика; ссылка на закрытую остаётся прежней", () => {
    const files = [...setA(), task("T-9003", "c")];
    const plan = planFix(files, { archive: false });
    expect(plan.moves).toEqual([]);
    expect(plan.files.map((file: TaskFile) => file.name).sort()).toEqual(["T-9003-c.md", "epics.md"]);
    const epics = textOf(plan.files, "epics.md");
    expect(epics).toContain("](T-9003-c.md)");
    expect(epics).toContain("](T-9001-a.md)");
    expect(epics).not.toContain("archive/");
  });

  it("открытая задача в архиве без archive: true на месте", () => {
    const files = [...setA(), task("T-9004", "d", {}, "", "archive/")];
    expect(planFix(files, { archive: false }).moves).toEqual([]);
  });
});

describe("archive — уборка", () => {
  it("закрытая уходит в архив, все ссылки на неё переписаны", () => {
    const plan = planFix(setA(), { archive: true });
    expect(plan.moves).toEqual([{ from: "T-9001-a.md", to: "archive/T-9001-a.md" }]);

    const names = plan.files.map((file: TaskFile) => file.name).sort();
    expect(names).toEqual(["T-9002-b.md", "archive/T-9001-a.md", "epics.md"]);
    expect(textOf(plan.files, "epics.md")).toContain("](archive/T-9001-a.md)");
    const dependent = textOf(plan.files, "T-9002-b.md");
    expect(dependent).toContain("](archive/T-9001-a.md)");
    expect(dependent).toContain("](archive/T-9001-a.md#решения)");
    expect(textOf(plan.files, "archive/T-9001-a.md")).toContain("](../README.md#значки-статуса)");
  });

  it("отменённая — как закрытая: без переноса при fix, с переносом при archive", () => {
    const files = setA().map((file) => (file.name === "T-9001-a.md" ? { ...file, text: file.text.replace("status: done", "status: cancelled") } : file));
    expect(planFix(files, { archive: false }).moves).toEqual([]);
    expect(planFix(files, { archive: true }).moves).toEqual([{ from: "T-9001-a.md", to: "archive/T-9001-a.md" }]);
  });

  it("открытая задача возвращается из архива наверх", () => {
    const files = [...setA(), task("T-9004", "d", {}, "", "archive/")];
    expect(planFix(files, { archive: true }).moves).toContainEqual({ from: "archive/T-9004-d.md", to: "T-9004-d.md" });
    expect(planFix(files, { archive: false }).moves).toEqual([]);
  });

  it("повторный план после применения пуст", () => {
    const files = setA();
    const once = apply(files, planFix(files, { archive: true }));
    expect(planFix(once, { archive: true })).toEqual({ moves: [], files: [] });
  });
});
