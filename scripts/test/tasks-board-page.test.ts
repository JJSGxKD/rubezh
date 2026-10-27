import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { SIZE_POINTS, contributions, formatMoscow, freeBadge, moscowDay, renderBoardPage, taskCredits } from "../tasks/board-page.mjs";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { parseMergedTaskPrs } from "../tasks/git-io.mjs";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { flowPrompt } from "../tasks/board.mjs";

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
    rework: [entry(task("T-0017", { title: "Ответы", status: "ready", effort: "low", fileName: "T-0017-ans.md" }), { pr: 216, waiting: { who: "executor", why: "доработка" } })],
    free: [entry(task("T-0003", { title: "Деньги | оплата", status: "ready", priority: "P0", size: "M", effort: "extra", epic: "E1", fileName: "T-0003-pay.md" }))],
    inProgress: [entry(task("T-0012", { title: "Палитра", status: "ready", fileName: "T-0012-pal.md" }))],
    review: [entry(task("T-0016", { title: "Пересчёт", status: "ready", fileName: "T-0016-rec.md" }), { pr: 215, waiting: { who: "lead", why: "приёмка" } })],
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
      owners: new Map([
        ["T-0012", "claude-3 / sonnet-5.5"],
        ["T-0017", "claude-2 / sonnet-5.5 / low"],
      ]),
      credits,
      people: contributions(credits),
      githubAvailable: true,
      now: new Date("2026-10-06T10:48:00Z"),
      ...patch,
    });

  const BLOB = "https://github.com/JJSGxKD/rubezh/blob/dev/tasks";
  const STREAMS_INTRO =
    "Какие потоки запускать в автопоток (`tasks/README.md`, «Автопоток»): доработка раньше новых задач, п.N — пачка выпуска. Строки `local` и `owner` — задачи только для потоков на машине с Docker и на машине владельца. То же даёт `pnpm task streams`.";

  it("ссылка на архивную задачу в разделе «Готово» ведёт в tasks/archive/ (T-0204)", () => {
    const archived = { ...board, done: [entry(task("T-0001", { title: "Наборы", owner: "", fileName: "T-0001-sets.md", path: "archive/T-0001-sets.md" }))] };
    expect(render({ board: archived })).toContain(`[T-0001. Наборы](${BLOB}/archive/T-0001-sets.md)`);
  });

  it("страница целиком", () => {
    expect(render()).toBe(
      [
        "# Доска задач",
        "",
        "Обновлено 06.10.2026 13:48 МСК. Страницу пересчитывает workflow `task-board.yml` после захвата, PR и мерджа — руками не править. Как брать задачу — [tasks/README.md](https://github.com/JJSGxKD/rubezh/blob/dev/tasks/README.md#как-взять-задачу).",
        "",
        "Свободно 1 · в работе 1 · на ревью 1 · на доработке 1 · ждут тимлида 1 · ждут владельца 0 · влито сегодня 0",
        "",
        "## Ждут владельца — 0",
        "",
        "Пусто.",
        "",
        "## Ждут тимлида — 1",
        "",
        "| PR | Задача | Почему |",
        "|---|---|---|",
        `| [#215](https://github.com/JJSGxKD/rubezh/pull/215) | [T-0016. Пересчёт](${BLOB}/T-0016-rec.md) | приёмка |`,
        "",
        "## Потоки сейчас",
        "",
        STREAMS_INTRO,
        "",
        "### Запускать сейчас",
        "",
        "| Поток | Свободно | Доработка | Ближайшие задачи |",
        "|---|---|---|---|",
        `| sonnet-5.5 / low | 0 | 1 | [T-0017](${BLOB}/T-0017-ans.md) |`,
        `| sonnet-5.5 / extra | 1 | 0 | [T-0003](${BLOB}/T-0003-pay.md) |`,
        "",
        "### На очереди",
        "",
        "| Поток | Ждут | Ближайшая пачка |",
        "|---|---|---|",
        "| sonnet-5.5 / medium | 1 | без пачки |",
        "",
        "### Запуск по аккаунтам",
        "",
        "Готовые промты с номером аккаунта; потоки, которые на нём уже идут, не предлагаются.",
        "",
        "<details>",
        "<summary>claude-2 — запустить 2: sonnet-5.5 / low, sonnet-5.5 / extra</summary>",
        "",
        `\`\`\`\n${flowPrompt({ account: "claude-2", executor: "sonnet-5.5", effort: "low", runner: "any" })}\n\`\`\``,
        "",
        `\`\`\`\n${flowPrompt({ account: "claude-2", executor: "sonnet-5.5", effort: "extra", runner: "any" })}\n\`\`\``,
        "",
        "</details>",
        "",
        "## Доработка — 1",
        "",
        "| Задача | Поток | Запустил | Висит | Кругов | Чего ждёт | PR |",
        "|---|---|---|---|---|---|---|",
        `| [T-0017. Ответы](${BLOB}/T-0017-ans.md) | claude-2 / sonnet-5.5 / low | — | — | — | исполнителя · доработка | [#216](https://github.com/JJSGxKD/rubezh/pull/216) |`,
        "",
        "## Можно брать — 1",
        "",
        "### В облаке — 1",
        "",
        "| Задача | Приоритет | Размер | Исполнитель | Эпик |",
        "|---|---|---|---|---|",
        `| [T-0003. Деньги \\| оплата](${BLOB}/T-0003-pay.md) | P0 | M | sonnet-5.5 · extra | E1 |`,
        "",
        "### Машина с Docker — 0",
        "",
        "Пусто.",
        "",
        "### Машина владельца — 0",
        "",
        "Пусто.",
        "",
        "## В работе — 1",
        "",
        "| Задача | Поток | Запустил | Висит | Кругов | Чего ждёт |",
        "|---|---|---|---|---|---|",
        `| [T-0012. Палитра](${BLOB}/T-0012-pal.md) | claude-3 / sonnet-5.5 | — | — | — | исполнителя |`,
        "",
        "## На ревью — 1",
        "",
        "| Задача | Поток | Запустил | Висит | Кругов | Чего ждёт | PR |",
        "|---|---|---|---|---|---|---|",
        `| [T-0016. Пересчёт](${BLOB}/T-0016-rec.md) | неизвестно | — | — | — | тимлида · приёмка | [#215](https://github.com/JJSGxKD/rubezh/pull/215) |`,
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

  describe("раздел «Потоки сейчас»", () => {
    const empty = { rework: [], free: [], inProgress: [], review: [], blocked: [], done: [], draft: [], cancelled: [] };

    it("заголовок без числа: на якорь #потоки-сейчас ведёт ссылка из epics.md", () => {
      expect(render()).toContain("\n## Потоки сейчас\n");
    });

    it("раздел стоит первым — до колонок доски", () => {
      const page = render();
      expect(page.indexOf("## Потоки сейчас")).toBeGreaterThan(-1);
      expect(page.indexOf("## Потоки сейчас")).toBeLessThan(page.indexOf("## Доработка"));
    });

    it("задача с пачкой — «(п.N)», больше пяти — «+N», local отдельной строкой", () => {
      const many = Array.from({ length: 6 }, (_, index) =>
        entry(task(`T-010${String(index)}`, { status: "ready", batch: "2", effort: "high", runner: index === 5 ? "local" : "any", fileName: `T-010${String(index)}-x.md` })),
      );
      const page = render({ board: { ...empty, free: many } });
      expect(page).toContain(`| sonnet-5.5 / high | 5 | 0 | [T-0100](${BLOB}/T-0100-x.md) (п.2), [T-0101](${BLOB}/T-0101-x.md) (п.2), [T-0102](${BLOB}/T-0102-x.md) (п.2), [T-0103](${BLOB}/T-0103-x.md) (п.2), [T-0104](${BLOB}/T-0104-x.md) (п.2) |`);
      expect(page).toContain(`| sonnet-5.5 / high · local | 1 | 0 | [T-0105](${BLOB}/T-0105-x.md) (п.2) |`);
    });

    it("свободных, доработки и очереди нет — короткие строки вместо таблиц", () => {
      const page = render({ board: empty });
      expect(page).toContain("### Запускать сейчас\n\nНечего: ни свободных задач, ни доработки.");
      expect(page).toContain("### На очереди\n\nНичего нет.");
    });

    it("пары без задач в таблицу не попадают", () => {
      const page = render({ board: { ...empty, blocked: board.blocked } });
      expect(page).toContain("### Запускать сейчас\n\nНечего");
      expect(page).toContain("| sonnet-5.5 / medium | 1 | без пачки |");
      expect(page).not.toContain("haiku");
    });
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

// Кто кого ждёт, счётчики и время по Москве (T-0205).
describe("страница доски: ожидание, счётчики, МСК", () => {
  const entry = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ task: item, ...extra });
  const open = (id: string, title: string, extra: Record<string, unknown> = {}) => task(id, { title, status: "ready", fileName: `${id}-x.md`, ...extra });
  const board = {
    rework: [],
    free: [
      entry(open("T-0401", "Облако", { batch: "2" })),
      entry(open("T-0402", "Докер", { runner: "local", batch: "2" })),
      entry(open("T-0403", "Секреты прода", { runner: "owner", batch: "2" })),
      entry(open("T-0404", "Проверка на телефоне", { runner: "human" })),
    ],
    inProgress: [],
    review: [
      entry(open("T-0411", "С вопросом"), { pr: 501, waiting: { who: "lead", why: "вопрос" } }),
      entry(open("T-0412", "К приёмке"), { pr: 502, waiting: { who: "lead", why: "приёмка" } }),
      entry(open("T-0413", "Красный"), { pr: 503, waiting: { who: "executor", why: "CI красный" } }),
      entry(open("T-0414", "Ждёт владельца"), { pr: 504, waiting: { who: "owner", why: "решение владельца" } }),
    ],
    blocked: [],
    done: [],
    draft: [],
    cancelled: [],
  };
  const render = (patch: Record<string, unknown> = {}): string =>
    renderBoardPage({ board, owners: new Map(), credits: new Map(), people: [], githubAvailable: true, mergedPrs: [], now: new Date("2026-10-23T21:40:00Z"), ...patch });
  const BLOB = "https://github.com/JJSGxKD/rubezh/blob/dev/tasks";

  it("moscowDay и formatMoscow сдвигают на три часа", () => {
    expect(moscowDay(new Date("2026-10-23T21:00:00Z"))).toBe("2026-10-24");
    expect(moscowDay(new Date("2026-10-23T20:59:00Z"))).toBe("2026-10-23");
    expect(formatMoscow(new Date("2026-10-24T02:40:00Z"))).toBe("24.10.2026 05:40");
    expect(formatMoscow(new Date("2026-12-31T21:05:00Z"))).toBe("01.01.2027 00:05");
  });

  it("вступление — МСК, под ним строка счётчиков", () => {
    const page = render();
    expect(page).toContain("Обновлено 24.10.2026 00:40 МСК. Страницу пересчитывает");
    expect(page).not.toContain("UTC");
    expect(page).toContain("\n\nСвободно 4 · в работе 0 · на ревью 4 · на доработке 0 · ждут тимлида 2 · ждут владельца 3 · влито сегодня 0 · пачка 2: осталось 3\n");
  });

  it("влито сегодня — по Москве; пачки нет — последнего пункта нет", () => {
    const merged = [{ number: 9, headRefName: "task/T-0001", login: "a", mergedAt: "2026-10-23T21:10:00Z" }];
    const page = render({ mergedPrs: merged, board: { ...board, free: [entry(open("T-0404", "Телефон", { runner: "human" }))] } });
    expect(page).toContain("влито сегодня 1\n");
    expect(page).not.toMatch(/пачка \d+: осталось/);
  });

  it("«Ждут тимлида» — вопрос и приёмка, красный CI и чужие ожидания не входят", () => {
    const page = render();
    const lead = page.slice(page.indexOf("## Ждут тимлида"), page.indexOf("## Потоки сейчас"));
    expect(lead).toContain("## Ждут тимлида — 2");
    expect(lead).toContain("| PR | Задача | Почему |");
    expect(lead).toContain(`| [#501](https://github.com/JJSGxKD/rubezh/pull/501) | [T-0411. С вопросом](${BLOB}/T-0411-x.md) | вопрос |`);
    expect(lead).toContain("| приёмка |");
    expect(lead).not.toContain("T-0413");
    expect(lead).not.toContain("T-0414");
  });

  it("«Ждут тимлида» стоит перед «Потоки сейчас»", () => {
    const page = render();
    expect(page.indexOf("## Ждут владельца")).toBeLessThan(page.indexOf("## Ждут тимлида"));
    expect(page.indexOf("## Ждут тимлида")).toBeLessThan(page.indexOf("## Потоки сейчас"));
  });

  it("«Ждут владельца» — свободные owner и human, PR с меткой; local и any не входят", () => {
    const page = render();
    const owner = page.slice(page.indexOf("## Ждут владельца"), page.indexOf("## Ждут тимлида"));
    expect(owner).toContain("## Ждут владельца — 3");
    expect(owner).toContain("| Что | Почему |");
    expect(owner).toContain(`[T-0403. Секреты прода](${BLOB}/T-0403-x.md) | машина владельца |`);
    expect(owner).toContain(`[T-0404. Проверка на телефоне](${BLOB}/T-0404-x.md) | нужен человек |`);
    expect(owner).toContain("[#504](https://github.com/JJSGxKD/rubezh/pull/504)");
    expect(owner).toContain("| решение владельца |");
    expect(owner).not.toContain("T-0401");
    expect(owner).not.toContain("T-0402");
  });

  it("«Можно брать» — три подраздела, local — во втором, human — ни в одном", () => {
    const page = render();
    const free = page.slice(page.indexOf("## Можно брать"), page.indexOf("## В работе"));
    expect(free).toContain("## Можно брать — 3");
    const cloud = free.indexOf("### В облаке — 1");
    const docker = free.indexOf("### Машина с Docker — 1");
    const owner = free.indexOf("### Машина владельца — 1");
    expect(cloud).toBeGreaterThan(-1);
    expect(docker).toBeGreaterThan(cloud);
    expect(owner).toBeGreaterThan(docker);
    expect(free.slice(cloud, docker)).toContain("T-0401");
    expect(free.slice(docker, owner)).toContain("T-0402");
    expect(free.slice(owner)).toContain("T-0403");
    expect(free).not.toContain("T-0404");
  });

  it("пустой подраздел «Можно брать» — «Пусто.»", () => {
    const page = render({ board: { ...board, free: [entry(open("T-0401", "Облако"))] } });
    expect(page).toContain("### Машина с Docker — 0\n\nПусто.");
  });
});

// Столбцы «В работе», «На ревью» и «Доработка»: поток, запустил, висит, кругов, чего ждёт (T-0206).
describe("страница доски: кто, сколько висит и чего ждёт", () => {
  const open = (id: string, title: string) => task(id, { title, status: "ready", fileName: `${id}-x.md` });
  const empty = { rework: [], free: [], inProgress: [], review: [], blocked: [], done: [], draft: [], cancelled: [] };
  const render = (board: Record<string, unknown>): string =>
    renderBoardPage({ board, owners: new Map(), credits: new Map(), people: [], githubAvailable: true, mergedPrs: [], now: new Date("2026-10-24T12:00:00Z") });
  const BLOB = "https://github.com/JJSGxKD/rubezh/blob/dev/tasks";
  const PR = "https://github.com/JJSGxKD/rubezh/pull";

  it("«На ревью»: четвёртые сутки, один круг, красный CI — «⚠️ 4 дн», «1», «исполнителя · CI красный»", () => {
    const page = render({
      ...empty,
      review: [
        {
          task: open("T-0501", "Висит"),
          pr: 601,
          waiting: { who: "executor", why: "CI красный" },
          owner: "claude-3 / sonnet-5.5 / medium",
          launchedBy: "помощник ivan_2",
          days: 4,
          rounds: 1,
        },
      ],
    });
    const section = page.slice(page.indexOf("## На ревью"), page.indexOf("## Ждут —"));
    expect(section).toContain("| Задача | Поток | Запустил | Висит | Кругов | Чего ждёт | PR |");
    expect(section).toContain(`| [T-0501. Висит](${BLOB}/T-0501-x.md) | claude-3 / sonnet-5.5 / medium | помощник ivan_2 | ⚠️ 4 дн | 1 | исполнителя · CI красный | [#601](${PR}/601) |`);
  });

  it("меньше суток — «сегодня», один-два дня — «N дн» без пометки, ноль кругов — «—»", () => {
    const entry = (id: string, days: number) => ({ task: open(id, id), pr: 700 + days, waiting: { who: "lead", why: "приёмка" }, owner: "x", launchedBy: "владелец", days, rounds: 0 });
    const page = render({ ...empty, review: [entry("T-0502", 0), entry("T-0503", 2), entry("T-0504", 3)] });
    expect(page).toContain("| владелец | сегодня | — | тимлида · приёмка |");
    expect(page).toContain("| владелец | 2 дн | — | тимлида · приёмка |");
    expect(page).toContain("| владелец | ⚠️ 3 дн | — | тимлида · приёмка |");
  });

  it("«В работе»: нет коммита захвата — «Висит» «—»; PR нет — колонки PR нет, ждёт исполнителя", () => {
    const page = render({ ...empty, inProgress: [{ task: open("T-0505", "Без даты"), owner: "claude-4 / sonnet-5.5", launchedBy: null, days: null, rounds: 0 }] });
    const section = page.slice(page.indexOf("## В работе"), page.indexOf("## На ревью"));
    expect(section).toContain("| Задача | Поток | Запустил | Висит | Кругов | Чего ждёт |");
    expect(section).not.toContain("| PR |");
    expect(section).toContain(`| [T-0505. Без даты](${BLOB}/T-0505-x.md) | claude-4 / sonnet-5.5 | — | — | — | исполнителя |`);
  });

  it("PR без строки «Запустил:» — «—» в столбце «Запустил»", () => {
    const page = render({ ...empty, review: [{ task: open("T-0506", "Без строки"), pr: 801, waiting: { who: "lead", why: "вопрос" }, owner: "x", launchedBy: null, days: 1, rounds: 0 }] });
    expect(page).toContain("| x | — | 1 дн | — | тимлида · вопрос |");
  });

  it("«Доработка» — те же столбцы; владелец — «владельца»; поток не прочитан — «неизвестно»", () => {
    const page = render({
      ...empty,
      rework: [{ task: open("T-0507", "Ответили"), pr: 901, waiting: { who: "owner", why: "решение владельца" }, launchedBy: "владелец", days: 5, rounds: 2 }],
    });
    const section = page.slice(page.indexOf("## Доработка"), page.indexOf("## Можно брать"));
    expect(section).toContain("| Задача | Поток | Запустил | Висит | Кругов | Чего ждёт | PR |");
    expect(section).toContain("| неизвестно | владелец | ⚠️ 5 дн | 2 | владельца | [#901]");
  });
});

// Запуск по аккаунтам (T-0209).
describe("страница доски: запуск по аккаунтам", () => {
  const open = (id: string, patch: Record<string, unknown> = {}) => task(id, { title: id, status: "ready", fileName: `${id}-x.md`, ...patch });
  const entry = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ task: item, ...extra });
  const render = (board: Record<string, unknown>, credits = new Map()): string =>
    renderBoardPage({ board, owners: new Map(), credits, people: [], githubAvailable: true, mergedPrs: [], now: new Date("2026-10-27T12:00:00Z") });
  const base = { rework: [], free: [], inProgress: [], review: [], blocked: [], done: [], draft: [], cancelled: [] };

  it("на аккаунт — <details> с промтами блоками кода", () => {
    const page = render({
      ...base,
      free: [entry(open("T-0601")), entry(open("T-0602", { effort: "high" })), entry(open("T-0603", { runner: "local" }))],
      inProgress: [entry(open("T-0604", { effort: "low", executor: "haiku-5.5" }), { owner: "claude-2 / haiku-5.5 / low" })],
    });
    const part = page.slice(page.indexOf("### Запуск по аккаунтам"), page.indexOf("## Доработка"));
    expect(part).toContain("<details>");
    expect(part).toContain("<summary>claude-2 — запустить 3: sonnet-5.5 / medium, sonnet-5.5 / medium · local, sonnet-5.5 / high</summary>");
    expect(part).toContain("поток claude-2 / sonnet-5.5 / medium, запустил: владелец");
    expect(part).toContain("--effort medium --runner local");
    expect(part).toContain("</details>");
  });

  it("аккаунт без свободных потоков — «всё нужное уже работает»", () => {
    const page = render({
      ...base,
      free: [entry(open("T-0601"))],
      inProgress: [entry(open("T-0605"), { owner: "claude-3 / sonnet-5.5 / medium" })],
    });
    expect(page).toContain("claude-3 — всё нужное уже работает");
  });

  it("аккаунтов нет — подсказка про команду", () => {
    const page = render({ ...base, free: [entry(open("T-0601"))] });
    expect(page).toContain("### Запуск по аккаунтам");
    expect(page).toContain("pnpm task streams --account claude-N");
  });
});
