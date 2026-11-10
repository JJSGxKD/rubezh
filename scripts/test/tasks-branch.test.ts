import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { TASK_BRANCH_RE, attemptOf, currentBranchOf, currentBranchTaskId, parseTaskBranch, previousAttemptBranches, takenIdsOf, taskBranch } from "../tasks/branch.mjs";

// Имена веток задач и попытки (T-0390, Р195): единственное место, где ветка
// собирается и разбирается. Без обращений к git.

describe("parseTaskBranch", () => {
  it("task/T-NNNN — попытка 1", () => {
    expect(parseTaskBranch("task/T-0119")).toEqual({ id: "T-0119", attempt: 1 });
  });

  it("task/T-NNNN-2 — попытка 2", () => {
    expect(parseTaskBranch("task/T-0119-2")).toEqual({ id: "T-0119", attempt: 2 });
  });

  it("полное имя ссылки refs/heads/… принимается, номер из двух знаков читается", () => {
    expect(parseTaskBranch("refs/heads/task/T-0119-12")).toEqual({ id: "T-0119", attempt: 12 });
    expect(parseTaskBranch("refs/heads/task/T-0119")).toEqual({ id: "T-0119", attempt: 1 });
  });

  it("суффикса -1, -0 и -02 не бывает: это не ветки задач", () => {
    for (const ref of ["task/T-0119-1", "task/T-0119-0", "task/T-0119-02", "task/T-0119-10x"]) {
      expect(parseTaskBranch(ref), ref).toBeNull();
    }
  });

  it("короткий номер, буква вместо числа и чужие ветки — null", () => {
    for (const ref of ["task/T-119", "task/T-0119-x", "task/T-0119-", "task/T-0119-2-3", "backup/claude-10/T-0119", "feat/x", "task/T-0119-x.md", "", undefined, null]) {
      expect(parseTaskBranch(ref), String(ref)).toBeNull();
    }
  });

  it("регулярка выражает то же самое", () => {
    expect(TASK_BRANCH_RE.test("task/T-0119-2")).toBe(true);
    expect(TASK_BRANCH_RE.test("task/T-0119-1")).toBe(false);
  });
});

describe("taskBranch и currentBranchOf", () => {
  it("попытка 1 и попытка по умолчанию — без суффикса", () => {
    expect(taskBranch("T-0119")).toBe("task/T-0119");
    expect(taskBranch("T-0119", 1)).toBe("task/T-0119");
  });

  it("попытка от 2 — с суффиксом", () => {
    expect(taskBranch("T-0119", 2)).toBe("task/T-0119-2");
    expect(taskBranch("T-0119", 12)).toBe("task/T-0119-12");
  });

  it("обратно: имя, собранное taskBranch, разбирается в те же id и попытку", () => {
    for (const attempt of [1, 2, 9, 10, 23]) {
      expect(parseTaskBranch(taskBranch("T-0042", attempt))).toEqual({ id: "T-0042", attempt });
    }
  });

  it("attemptOf: нет поля — 1, строка из шапки и число читаются, мусор — 1", () => {
    expect(attemptOf({ id: "T-0001" })).toBe(1);
    expect(attemptOf({ id: "T-0001", attempt: "2" })).toBe(2);
    expect(attemptOf({ id: "T-0001", attempt: 3 })).toBe(3);
    for (const bad of ["1", "0", "2.5", "два", "", null, undefined]) {
      expect(attemptOf({ id: "T-0001", attempt: bad }), String(bad)).toBe(1);
    }
  });

  it("currentBranchOf — ветка по попытке задачи", () => {
    expect(currentBranchOf({ id: "T-0119" })).toBe("task/T-0119");
    expect(currentBranchOf({ id: "T-0119", attempt: "2" })).toBe("task/T-0119-2");
  });
});

describe("takenIdsOf: занята только задача с веткой текущей попытки", () => {
  const tasks = [{ id: "T-0001" }, { id: "T-0002", attempt: "2" }, { id: "T-0003", attempt: "3" }];

  it("ветка попытки 1 у задачи без поля — занята", () => {
    expect(takenIdsOf(["task/T-0001"], tasks)).toEqual(["T-0001"]);
  });

  it("ветка прежней попытки задачу не занимает", () => {
    expect(takenIdsOf(["task/T-0002"], tasks)).toEqual([]);
  });

  it("ветка текущей попытки занимает", () => {
    expect(takenIdsOf(["task/T-0002", "task/T-0002-2"], tasks)).toEqual(["T-0002"]);
  });

  it("ветка будущей попытки задачу не занимает", () => {
    expect(takenIdsOf(["task/T-0002-3"], tasks)).toEqual([]);
  });

  it("чужие ветки и ссылки refs/heads/… — сначала разбор; задача вне реестра считается попыткой 1", () => {
    expect(takenIdsOf(["refs/heads/task/T-0003-3", "feat/x", "task/T-0009", "task/T-0009-2"], tasks)).toEqual(["T-0003", "T-0009"]);
  });

  it("повторов нет", () => {
    expect(takenIdsOf(["task/T-0001", "refs/heads/task/T-0001"], tasks)).toEqual(["T-0001"]);
  });
});

describe("currentBranchTaskId: PR или ветка принадлежат задаче только в текущей попытке", () => {
  const tasks = [{ id: "T-0001" }, { id: "T-0002", attempt: "2" }];

  it("текущая попытка — id задачи", () => {
    expect(currentBranchTaskId("task/T-0001", tasks)).toBe("T-0001");
    expect(currentBranchTaskId("task/T-0002-2", tasks)).toBe("T-0002");
  });

  it("прежняя, будущая, чужая ветка — undefined", () => {
    expect(currentBranchTaskId("task/T-0002", tasks)).toBeUndefined();
    expect(currentBranchTaskId("task/T-0002-3", tasks)).toBeUndefined();
    expect(currentBranchTaskId("feat/x", tasks)).toBeUndefined();
  });
});

describe("previousAttemptBranches: ветки прежних попыток задачи", () => {
  it("по убыванию попытки, только меньшие текущей", () => {
    const task = { id: "T-0007", attempt: "4" };
    const branches = ["task/T-0007", "task/T-0007-2", "task/T-0007-3", "task/T-0007-4", "task/T-0007-5", "task/T-0008"];
    expect(previousAttemptBranches(task, branches)).toEqual(["task/T-0007-3", "task/T-0007-2", "task/T-0007"]);
  });

  it("попытка 1 — прежних нет", () => {
    expect(previousAttemptBranches({ id: "T-0007" }, ["task/T-0007"])).toEqual([]);
  });
});
