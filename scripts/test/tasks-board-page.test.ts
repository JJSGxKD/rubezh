import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { SIZE_POINTS, contributions, freeBadge, renderBoardPage, taskCredits } from "../tasks/board-page.mjs";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { parseMergedTaskPrs } from "../tasks/git-io.mjs";

// Страница доски и счётчик свободных задач (T-0018).

function task(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    fileName: `${id}-x.md`,
    title: `Задача ${id}`,
    epic: "E0",
    priority: "P1",
    status: "done",
    owner: "claude-2 / sonnet-5.5",
    size: "S",
    depends_on: [],
    zones: [],
    shared: [],
    runner: "any",
    executor: "sonnet-5.5",
    effort: "medium",
    release: "patch",
    design: null,
    ...patch,
  };
}

const pr = (number: number, id: string, login: string | null, mergedAt: string) => ({ number, headRefName: `task/${id}`, login, mergedAt });

describe("значок «можно брать»", () => {
  it("0 — «нет задач», светло-серый", () => {
    expect(freeBadge(0)).toEqual({ schemaVersion: 1, label: "можно брать", message: "нет задач", color: "lightgrey", cacheSeconds: 300 });
  });

  it("склонение: 1 задача, 3 задачи, 5, 11 и 21 — как положено", () => {
    const messages = [1, 3, 5, 11, 12, 14, 20, 21, 22, 25].map((count) => freeBadge(count).message);
    expect(messages).toEqual(["1 задача", "3 задачи", "5 задач", "11 задач", "12 задач", "14 задач", "20 задач", "21 задача", "22 задачи", "25 задач"]);
  });

  it("не ноль — ярко-зелёный", () => {
    for (const count of [1, 3, 5, 11, 21, 22]) expect(freeBadge(count).color).toBe("brightgreen");
  });
});

describe("очки и авторы сделанных задач", () => {
  const done = (...tasks: Record<string, unknown>[]) => tasks.map((item) => ({ task: item }));

  it("очки по размеру: S — 1, M — 2", () => {
    expect(SIZE_POINTS).toEqual({ S: 1, M: 2 });
    const credits = taskCredits(done(task("T-0001", { size: "S" }), task("T-0002", { size: "M" })), []);
    expect(credits.get("T-0001").points).toBe(1);
    expect(credits.get("T-0002").points).toBe(2);
  });

  it("один PR — его автор, номер и дата", () => {
    const credits = taskCredits(done(task("T-0001")), [pr(205, "T-0001", "Kennix88", "2026-10-05T10:00:00Z")]);
    expect(credits.get("T-0001")).toEqual({ login: "Kennix88", pr: 205, mergedAt: "2026-10-05T10:00:00Z", owner: "claude-2 / sonnet-5.5", points: 1 });
  });

  it("два влитых PR одной задачи — самый поздний", () => {
    const credits = taskCredits(done(task("T-0001")), [
      pr(205, "T-0001", "old", "2026-10-05T10:00:00Z"),
      pr(210, "T-0001", "new", "2026-10-06T10:00:00Z"),
    ]);
    expect(credits.get("T-0001").login).toBe("new");
    expect(credits.get("T-0001").pr).toBe(210);
  });

  it("PR чужой задачи не засчитывается", () => {
    const credits = taskCredits(done(task("T-0001")), [pr(9, "T-0002", "other", "2026-10-06T10:00:00Z")]);
    expect(credits.get("T-0001").login).toBeNull();
  });

  it("PR нет — login, pr и mergedAt равны null", () => {
    expect(taskCredits(done(task("T-0001")), []).get("T-0001")).toMatchObject({ login: null, pr: null, mergedAt: null });
  });

  it("удалённый аккаунт (login null) — как без автора, но PR виден", () => {
    expect(taskCredits(done(task("T-0001")), [pr(5, "T-0001", null, "2026-10-06T10:00:00Z")]).get("T-0001")).toMatchObject({ login: null, pr: 5 });
  });

  it("список PR не получен (null) — у всех login null", () => {
    const credits = taskCredits(done(task("T-0001"), task("T-0002")), null);
    expect([...credits.values()].map((credit: { login: string | null }) => credit.login)).toEqual([null, null]);
  });

  it("owner пустой — «не указан»", () => {
    expect(taskCredits(done(task("T-0001", { owner: "" })), []).get("T-0001").owner).toBe("не указан");
  });
});

describe("вклад по людям", () => {
  const credit = (login: string | null, owner: string, points: number, mergedAt: string | null = "2026-10-06T10:00:00Z") => ({ login, pr: 1, mergedAt, owner, points });
  const of = (...items: ReturnType<typeof credit>[]) => contributions(new Map(items.map((item, index) => [`T-${String(index)}`, item])));

  it("больше очков — первый", () => {
    expect(of(credit("a", "x", 1), credit("b", "x", 2)).map((person: { login: string }) => person.login)).toEqual(["b", "a"]);
  });

  it("равные очки — больше задач", () => {
    const people = of(credit("a", "x", 2), credit("b", "x", 1), credit("b", "x", 1));
    expect(people.map((person: { login: string }) => person.login)).toEqual(["b", "a"]);
  });

  it("всё равно — по логину", () => {
    expect(of(credit("b", "x", 1), credit("a", "x", 1)).map((person: { login: string }) => person.login)).toEqual(["a", "b"]);
  });

  it("без автора — последним, даже с большим числом очков", () => {
    expect(of(credit(null, "x", 9), credit("a", "x", 1)).map((person: { login: string | null }) => person.login)).toEqual(["a", null]);
  });

  it("сумма, последний мердж и исполнители внутри человека", () => {
    const [person] = of(
      credit("a", "claude-2 / sonnet-5.5", 2, "2026-10-05T10:00:00Z"),
      credit("a", "claude-3 / sonnet-5.5", 1, "2026-10-07T10:00:00Z"),
      credit("a", "claude-2 / sonnet-5.5", 1, "2026-10-06T10:00:00Z"),
    );
    expect(person).toEqual({
      login: "a",
      tasks: 3,
      points: 4,
      lastMergedAt: "2026-10-07T10:00:00Z",
      executors: [
        { owner: "claude-2 / sonnet-5.5", tasks: 2, points: 3 },
        { owner: "claude-3 / sonnet-5.5", tasks: 1, points: 1 },
      ],
    });
  });
});

describe("влитые PR задач из gh", () => {
  it("оставляет ветки task/T-NNNN, автор может быть null", () => {
    const parsed = [
      { number: 1, headRefName: "task/T-0001", author: { login: "a" }, mergedAt: "2026-10-06T10:00:00Z" },
      { number: 2, headRefName: "task/T-0002", author: null, mergedAt: "2026-10-06T11:00:00Z" },
      { number: 3, headRefName: "docs/x", author: { login: "a" }, mergedAt: "2026-10-06T12:00:00Z" },
      { number: 4, headRefName: "task/T-0004-x", author: { login: "a" }, mergedAt: "2026-10-06T12:00:00Z" },
      { number: "5", headRefName: "task/T-0005", author: { login: "a" }, mergedAt: "2026-10-06T12:00:00Z" },
      { number: 6, headRefName: "task/T-0006", author: { login: "a" }, mergedAt: null },
    ];
    expect(parseMergedTaskPrs(parsed)).toEqual([
      { number: 1, headRefName: "task/T-0001", login: "a", mergedAt: "2026-10-06T10:00:00Z" },
      { number: 2, headRefName: "task/T-0002", login: null, mergedAt: "2026-10-06T11:00:00Z" },
    ]);
  });

  it("ответ не массив — null", () => {
    expect(parseMergedTaskPrs({})).toBeNull();
  });
});

describe("страница доски", () => {
  const entry = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ task: item, ...extra });
  const board = {
    free: [entry(task("T-0003", { title: "Деньги | оплата", status: "ready", priority: "P0", size: "M", effort: "extra", epic: "E1", fileName: "T-0003-pay.md" }))],
    inProgress: [entry(task("T-0012", { title: "Палитра", status: "ready", fileName: "T-0012-pal.md" }))],
    review: [entry(task("T-0016", { title: "Пересчёт", status: "ready", fileName: "T-0016-rec.md" }), { pr: 215 })],
    blocked: [entry(task("T-0004", { title: "Возвраты", status: "ready", fileName: "T-0004-ref.md" }), { reason: "ждёт T-0003" })],
    done: [
      entry(task("T-0001", { title: "Наборы", owner: "", fileName: "T-0001-sets.md" })),
      entry(task("T-0011", { title: "Значки", size: "M", fileName: "T-0011-badges.md" })),
    ],
    draft: [entry(task("T-0020", { title: "Черновик", status: "draft" }))],
    cancelled: [entry(task("T-0021", { title: "Отменена", status: "cancelled" }))],
  };
  const credits = taskCredits(board.done, [pr(213, "T-0011", "Kennix88", "2026-10-06T09:00:00Z")]);
  const render = (patch: Record<string, unknown> = {}): string =>
    renderBoardPage({
      board,
      owners: new Map([["T-0012", "claude-3 / sonnet-5.5"]]),
      credits,
      people: contributions(credits),
      githubAvailable: true,
      now: new Date("2026-10-06T10:48:00Z"),
      ...patch,
    });

  const BLOB = "https://github.com/JJSGxKD/rubezh/blob/dev/tasks";

  it("страница целиком", () => {
    expect(render()).toBe(
      [
        "# Доска задач",
        "",
        "Обновлено 06.10.2026 10:48 UTC. Страницу пересчитывает workflow `task-board.yml` после захвата, PR и мерджа — руками не править. Как брать задачу — [tasks/README.md](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/README.md#как-взять-задачу).",
        "",
        "## Можно брать — 1",
        "",
        "| Задача | Приоритет | Размер | Исполнитель | Эпик |",
        "|---|---|---|---|---|",
        `| [T-0003. Деньги \\| оплата](${BLOB}/T-0003-pay.md) | P0 | M | sonnet-5.5 · extra | E1 |`,
        "",
        "## В работе — 1",
        "",
        "| Задача | Взял |",
        "|---|---|",
        `| [T-0012. Палитра](${BLOB}/T-0012-pal.md) | claude-3 / sonnet-5.5 |`,
        "",
        "## На ревью — 1",
        "",
        "| Задача | PR |",
        "|---|---|",
        `| [T-0016. Пересчёт](${BLOB}/T-0016-rec.md) | [#215](https://github.com/JJSGxKD/rubezh/pull/215) |`,
        "",
        "## Ждут — 1",
        "",
        "| Задача | Чего ждёт |",
        "|---|---|",
        `| [T-0004. Возвраты](${BLOB}/T-0004-ref.md) | ждёт T-0003 |`,
        "",
        "## Готово — 2",
        "",
        "| Задача | Сделал | PR |",
        "|---|---|---|",
        `| [T-0011. Значки](${BLOB}/T-0011-badges.md) | @Kennix88 · claude-2 / sonnet-5.5 | [#213](https://github.com/JJSGxKD/rubezh/pull/213) |`,
        `| [T-0001. Наборы](${BLOB}/T-0001-sets.md) | не указан | — |`,
        "",
        "## Вклад",
        "",
        "Очки — сумма размеров сделанных задач: S — 1, M — 2. Это наглядность, а не формула выплат: доли участников — `docs/11-revenue-split.md`.",
        "",
        "| GitHub | Задач | Очков | Последний мердж |",
        "|---|---|---|---|",
        "| [@Kennix88](https://github.com/Kennix88) | 1 | 2 | 06.10.2026 |",
        "| без PR задачи | 1 | 1 | — |",
        "",
        "| GitHub | Исполнитель | Задач | Очков |",
        "|---|---|---|---|",
        "| @Kennix88 | claude-2 / sonnet-5.5 | 1 | 2 |",
        "| без PR задачи | не указан | 1 | 1 |",
        "",
      ].join("\n"),
    );
  });

  it("черновики и отменённые на странице не показываются", () => {
    expect(render()).not.toContain("T-0020");
    expect(render()).not.toContain("T-0021");
  });

  it("пустая колонка — «Пусто.» вместо таблицы", () => {
    const page = render({ board: { ...board, review: [] } });
    expect(page).toContain("## На ревью — 0\n\nПусто.\n");
  });

  it("владелец «в работе» неизвестен — «неизвестно»", () => {
    expect(render({ owners: new Map() })).toContain("| неизвестно |");
  });

  it("список влитых PR не получен — вместо таблиц вклада строка про GitHub", () => {
    const page = render({ githubAvailable: false });
    expect(page).toContain("Нет данных GitHub: список влитых PR не получен.");
    expect(page).not.toContain("| GitHub |");
  });

  it("на странице нет почт и юзернеймов Telegram", () => {
    expect(render()).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+|t\.me/i);
  });
});
