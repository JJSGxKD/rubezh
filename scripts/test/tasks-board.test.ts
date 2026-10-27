import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { checkRunnerLines } from "../release/pr-check.mjs";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { OWNER_LABEL, boardCounters, hangingDays, launchedBy, reworkRounds, classify, epicStreamsBadge, isCiRed, nextTasks, waitingOn, renderStreamsText, statusBadge, streamRows, streamsSummary, batchRank } from "../tasks/board.mjs";

// Доска задач: каждая задача — ровно в одной колонке.

const EPIC_ORDER = ["E0", "E1", "E2"];

function task(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    fileName: `${id}-x.md`,
    title: `Задача ${id}`,
    epic: "E0",
    priority: "P1",
    status: "ready",
    owner: "",
    size: "S",
    depends_on: [],
    zones: [`zones/${id}/**`],
    shared: [],
    runner: "any",
    executor: "sonnet-5.5",
    effort: "medium",
    release: "patch",
    design: null,
    ...patch,
  };
}

function ids(entries: { task: { id: string } }[]): string[] {
  return entries.map((entry) => entry.task.id);
}

const FIXTURE = [
  task("T-0001", { status: "done" }),
  task("T-0002", { status: "cancelled" }),
  task("T-0003", { status: "draft" }),
  task("T-0004"), // ветка и открытый PR → на ревью
  task("T-0005"), // ветка без PR → в работе
  task("T-0006", { depends_on: ["T-0005"] }), // ждёт T-0005
  task("T-0007"), // свободна
];
const TAKEN = ["T-0004", "T-0005"];
const PRS = [{ number: 21, headRefName: "task/T-0004", isDraft: false }];

describe("доска задач", () => {
  const board = classify(FIXTURE, TAKEN, PRS, [], EPIC_ORDER);

  it("каждая задача — в своей колонке", () => {
    expect(ids(board.done)).toEqual(["T-0001"]);
    expect(ids(board.cancelled)).toEqual(["T-0002"]);
    expect(ids(board.draft)).toEqual(["T-0003"]);
    expect(ids(board.review)).toEqual(["T-0004"]);
    expect(ids(board.inProgress)).toEqual(["T-0005"]);
    expect(ids(board.blocked)).toEqual(["T-0006"]);
    expect(ids(board.free)).toEqual(["T-0007"]);
  });

  it("ни одна задача не пропала и не задвоилась", () => {
    const all = Object.values(board).flat() as { task: { id: string } }[];
    expect(ids(all).sort()).toEqual(FIXTURE.map((item) => item.id).sort());
  });

  it("заблокированной — причина: какая зависимость не сделана", () => {
    expect(board.blocked[0].reason).toContain("T-0005");
  });

  it("у задачи на ревью виден номер PR", () => {
    expect(board.review[0].pr).toBe(21);
  });

  it("PR в черновике — «на ревью» с ожиданием, «в работе» только ветка без PR", () => {
    const draftPr = [{ number: 21, headRefName: "task/T-0004", isDraft: true }];
    const result = classify(FIXTURE, TAKEN, draftPr, [], EPIC_ORDER);
    expect(ids(result.review)).toEqual(["T-0004"]);
    expect(result.review[0].waiting).toEqual({ who: "executor", why: "черновик" });
    expect(ids(result.inProgress)).toEqual(["T-0005"]);
  });

  it("без списка PR (нет gh) «на ревью» сливается с «в работе»", () => {
    const result = classify(FIXTURE, TAKEN, null, [], EPIC_ORDER);
    expect(ids(result.review)).toEqual([]);
    expect(ids(result.inProgress).sort()).toEqual(["T-0004", "T-0005"]);
  });

  it("зависимость, которой нет в реестре, блокирует и называется", () => {
    const result = classify([task("T-0008", { depends_on: ["T-0099"] })], [], [], [], EPIC_ORDER);
    expect(result.blocked[0].reason).toContain("T-0099");
  });

  it("зависимость в статусе done не блокирует", () => {
    const result = classify([task("T-0001", { status: "done" }), task("T-0002", { depends_on: ["T-0001"] })], [], [], [], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0002"]);
  });
});

describe("пересечение зон на доске", () => {
  it("зоны пересекаются с задачей в работе — заблокирована, причина называет её", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const result = classify(tasks, ["T-0004"], [], ["a/b.ts"], EPIC_ORDER);
    expect(ids(result.blocked)).toEqual(["T-0005"]);
    expect(result.blocked[0].reason).toContain("T-0004");
  });

  // Р171: PR, ждущий ревью, соседей не держит; черновик и доработка — держат.
  it("пересечение с задачей на ревью не блокирует", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const prs = [{ number: 7, headRefName: "task/T-0004", isDraft: false }];
    const result = classify(tasks, ["T-0004"], prs, ["a/b.ts"], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0005"]);
  });

  it("пересечение с черновиком PR или доработкой блокирует", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    for (const pr of [
      { number: 7, headRefName: "task/T-0004", isDraft: true },
      { number: 7, headRefName: "task/T-0004", isDraft: false, labels: [{ name: "доработка" }] },
    ]) {
      const result = classify(tasks, ["T-0004"], [pr], ["a/b.ts"], EPIC_ORDER);
      expect(ids(result.blocked)).toEqual(["T-0005"]);
    }
  });

  it("пересечение с другой свободной задачей не блокирует: занята только та, у которой есть ветка", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const result = classify(tasks, [], [], ["a/b.ts"], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0004", "T-0005"]);
  });

  it("задача с готовой зависимостью не блокируется зонами done-задачи", () => {
    const tasks = [task("T-0001", { status: "done", zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const result = classify(tasks, [], [], ["a/b.ts"], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0005"]);
  });
});

describe("порядок в колонке «Свободно»", () => {
  const tasks = [
    task("T-0010", { priority: "P2", epic: "E0" }),
    task("T-0011", { priority: "P0", epic: "E2" }),
    task("T-0012", { priority: "P0", epic: "E1" }),
    task("T-0013", { priority: "P0", epic: "E1" }),
    task("T-0014", { priority: "P1", epic: "E0" }),
  ];

  it("по приоритету, затем по порядку эпика, затем по id", () => {
    const result = classify(tasks, [], [], [], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0012", "T-0013", "T-0011", "T-0014", "T-0010"]);
  });

  it("эпик, которого нет в epics.md, идёт последним среди своего приоритета", () => {
    const result = classify([task("T-0020", { epic: "E9" }), task("T-0021", { epic: "E2" })], [], [], [], EPIC_ORDER);
    expect(ids(result.free)).toEqual(["T-0021", "T-0020"]);
  });
});

// Пачки очереди (docs/38-release-plan.md): ближняя пачка — раньше приоритета.
describe("пачка задачи в порядке выдачи", () => {
  it("ближняя пачка раньше дальней при любом приоритете; без пачки — в конце", () => {
    const result = classify(
      [task("T-0050", { priority: "P0", batch: "10" }), task("T-0051", { priority: "P2", batch: "2" }), task("T-0052", { priority: "P0" }), task("T-0053", { priority: "P1", batch: "3" })],
      [],
      [],
      [],
      EPIC_ORDER,
    );
    expect(ids(result.free)).toEqual(["T-0051", "T-0053", "T-0050", "T-0052"]);
  });

  it("внутри одной пачки порядок прежний: приоритет, эпик, id", () => {
    const result = classify(
      [
        task("T-0060", { priority: "P1", epic: "E1", batch: "1" }),
        task("T-0061", { priority: "P1", epic: "E0", batch: "1" }),
        task("T-0062", { priority: "P0", epic: "E2", batch: "1" }),
        task("T-0063", { priority: "P1", epic: "E0", batch: "1" }),
      ],
      [],
      [],
      [],
      EPIC_ORDER,
    );
    expect(ids(result.free)).toEqual(["T-0062", "T-0061", "T-0063", "T-0060"]);
  });

  it("batchRank: пачка 10 позже пачки 9 (число, а не строка), мусор — как без пачки", () => {
    expect(batchRank("10")).toBeGreaterThan(batchRank("9"));
    expect(batchRank(2)).toBe(batchRank("2"));
    expect(batchRank("1")).toBeLessThan(batchRank("2"));
    for (const bad of [undefined, null, "", "x", "0", "-1", "1.5", "v0.8"]) {
      expect(batchRank(bad), String(bad)).toBeGreaterThan(batchRank("999999"));
    }
  });
});

const FIXTURE_NEXT = [
  task("T-0030", { runner: "human" }),
  task("T-0031", { runner: "local" }),
  task("T-0032", { runner: "any" }),
  task("T-0033", { runner: "any", executor: "other-model" }),
];

describe("следующая задача", () => {
  const free = classify(
    FIXTURE_NEXT,
    [],
    [],
    [],
    EPIC_ORDER,
  ).free;

  it("по умолчанию — только runner: any; human не показывается никогда", () => {
    expect(ids(nextTasks(free, {}))).toEqual(["T-0032", "T-0033"]);
  });

  it("local включает any", () => {
    expect(ids(nextTasks(free, { runner: "local" }))).toEqual(["T-0031", "T-0032", "T-0033"]);
  });

  it("owner включает any и local, но не human", () => {
    const withOwner = classify([...FIXTURE_NEXT, task("T-0034", { runner: "owner" })], [], [], [], EPIC_ORDER).free;
    expect(ids(nextTasks(withOwner, { runner: "owner" }))).toEqual(["T-0031", "T-0032", "T-0033", "T-0034"]);
    expect(ids(nextTasks(withOwner, { runner: "local" }))).toEqual(["T-0031", "T-0032", "T-0033"]);
    expect(ids(nextTasks(withOwner, {}))).toEqual(["T-0032", "T-0033"]);
  });

  it("--executor оставляет задачи только этого исполнителя", () => {
    expect(ids(nextTasks(free, { runner: "local", executor: "sonnet-5.5" }))).toEqual(["T-0031", "T-0032"]);
  });
});

// Доработка (tasks/README.md, «Доработка»): PR с меткой может закончить любой
// поток с тем же исполнителем и уровнем.
describe("доработка", () => {
  const REWORK = [{ name: "доработка" }];

  it("PR с меткой «доработка» — в своей колонке, будь он хоть черновиком", () => {
    const prs = [
      { number: 21, headRefName: "task/T-0004", isDraft: false, labels: REWORK },
      { number: 22, headRefName: "task/T-0005", isDraft: true, labels: [{ name: "release: patch" }, ...REWORK] },
    ];
    const result = classify(FIXTURE, TAKEN, prs, [], EPIC_ORDER);
    expect(ids(result.rework)).toEqual(["T-0004", "T-0005"]);
    expect(result.rework.map((entry: { pr: number }) => entry.pr)).toEqual([21, 22]);
    expect(ids(result.review)).toEqual([]);
    expect(ids(result.inProgress)).toEqual([]);
  });

  it("задача на доработке держит свои зоны", () => {
    const tasks = [task("T-0004", { zones: ["a/**"] }), task("T-0005", { zones: ["a/b.ts"] })];
    const prs = [{ number: 21, headRefName: "task/T-0004", isDraft: false, labels: REWORK }];
    const result = classify(tasks, ["T-0004"], prs, ["a/b.ts"], EPIC_ORDER);
    expect(result.blocked[0].reason).toContain("T-0004 (на доработке)");
  });

  it("--effort оставляет задачи только этого уровня — и в доработке, и в свободных", () => {
    const result = classify(
      [task("T-0040", { effort: "low" }), task("T-0041", { effort: "medium" }), task("T-0042", { effort: "medium", executor: "haiku-5.5" })],
      ["T-0041"],
      [{ number: 30, headRefName: "task/T-0041", isDraft: false, labels: REWORK }],
      [],
      EPIC_ORDER,
    );
    expect(ids(nextTasks(result.rework, { executor: "sonnet-5.5", effort: "medium" }))).toEqual(["T-0041"]);
    expect(ids(nextTasks(result.free, { executor: "sonnet-5.5", effort: "medium" }))).toEqual([]);
    expect(ids(nextTasks(result.free, { executor: "haiku-5.5", effort: "medium" }))).toEqual(["T-0042"]);
    expect(ids(nextTasks(result.free, { effort: "low" }))).toEqual(["T-0040"]);
  });

  it("значок — «доработка · #N», жёлтый; в работе с уровнем в owner — только аккаунт", () => {
    expect(statusBadge({ column: "rework", task: task("T-0001"), pr: 214 })).toEqual({
      schemaVersion: 1,
      label: "статус",
      cacheSeconds: 300,
      message: "доработка · #214",
      color: "yellow",
    });
    expect(statusBadge({ column: "inProgress", task: task("T-0001"), owner: "claude-3 / haiku-5.5 / low" }).message).toBe("в работе · claude-3");
  });
});

describe("причины блокировки в структурном виде", () => {
  it("зависимости и занятые зоны — списками id, чтобы значок не разбирал текст", () => {
    const tasks = [
      task("T-0004", { zones: ["a/**"] }),
      task("T-0005", { zones: ["a/b.ts"], depends_on: ["T-0006", "T-0099"] }),
      task("T-0006"),
    ];
    const result = classify(tasks, ["T-0004"], [], ["a/b.ts"], EPIC_ORDER);
    const blocked = result.blocked.find((entry: { task: { id: string } }) => entry.task.id === "T-0005");
    expect(blocked.waitingFor).toEqual(["T-0006", "T-0099"]);
    expect(blocked.busyWith).toEqual(["T-0004"]);
  });
});

describe("значок статуса", () => {
  const base = { schemaVersion: 1, label: "статус", cacheSeconds: 300 };

  it("свободно — «можно брать», ярко-зелёный", () => {
    expect(statusBadge({ column: "free", task: task("T-0001") })).toEqual({ ...base, message: "можно брать", color: "brightgreen" });
  });

  it("в работе — «в работе · аккаунт», оранжевый; модель из owner отрезана", () => {
    expect(statusBadge({ column: "inProgress", task: task("T-0001"), owner: "claude-2 / sonnet-5.5" })).toEqual({
      ...base,
      message: "в работе · claude-2",
      color: "orange",
    });
  });

  it("в работе без известного владельца — просто «в работе»", () => {
    expect(statusBadge({ column: "inProgress", task: task("T-0001"), owner: "" }).message).toBe("в работе");
    expect(statusBadge({ column: "inProgress", task: task("T-0001") }).message).toBe("в работе");
  });

  it("на ревью — номер PR, синий", () => {
    expect(statusBadge({ column: "review", task: task("T-0001"), pr: 214 })).toEqual({ ...base, message: "на ревью · #214", color: "blue" });
  });

  it("заблокировано зависимостью — «ждёт T-0003», красный", () => {
    expect(statusBadge({ column: "blocked", task: task("T-0001"), waitingFor: ["T-0003"], busyWith: [] })).toEqual({
      ...base,
      message: "ждёт T-0003",
      color: "red",
    });
  });

  it("две зависимости перечисляются обе, три — две и «+1»", () => {
    const blocked = (waitingFor: string[]) => statusBadge({ column: "blocked", task: task("T-0001"), waitingFor, busyWith: [] }).message;
    expect(blocked(["T-0003", "T-0004"])).toBe("ждёт T-0003, T-0004");
    expect(blocked(["T-0003", "T-0004", "T-0005"])).toBe("ждёт T-0003, T-0004 +1");
    expect(blocked(["T-0003", "T-0004", "T-0005", "T-0006", "T-0007"])).toBe("ждёт T-0003, T-0004 +3");
  });

  it("заблокировано зоной — «зона занята T-0005», красный", () => {
    expect(statusBadge({ column: "blocked", task: task("T-0001"), waitingFor: [], busyWith: ["T-0005"] })).toEqual({
      ...base,
      message: "зона занята T-0005",
      color: "red",
    });
  });

  it("и зависимость, и зона — в значке зависимость: без неё зона ничего не решает", () => {
    expect(statusBadge({ column: "blocked", task: task("T-0001"), waitingFor: ["T-0003"], busyWith: ["T-0005"] }).message).toBe("ждёт T-0003");
  });

  it("готово — фиолетовый, как влитый PR", () => {
    expect(statusBadge({ column: "done", task: task("T-0001") })).toEqual({ ...base, message: "готово", color: "6e40c9" });
  });

  it("черновик — светло-серый", () => {
    expect(statusBadge({ column: "draft", task: task("T-0001") })).toEqual({ ...base, message: "черновик", color: "lightgrey" });
  });

  it("отменено — неактивный", () => {
    expect(statusBadge({ column: "cancelled", task: task("T-0001") })).toEqual({ ...base, message: "отменено", color: "inactive" });
  });

  it("у каждой колонки доски есть значок", () => {
    const board = classify(FIXTURE, TAKEN, PRS, [], EPIC_ORDER);
    for (const [column, entries] of Object.entries(board) as [string, Record<string, unknown>[]][]) {
      for (const entry of entries) {
        expect(statusBadge({ ...entry, column }).message).not.toBe("");
      }
    }
  });
});

// Потоки автопотока (tasks/README.md, «Автопоток»): что запускать сейчас и что ждёт.
describe("потоки", () => {
  const REWORK = [{ name: "доработка" }];
  const high = { executor: "sonnet-5.5", effort: "high" };
  const tasks = [
    task("T-0201", { ...high, epic: "E1", batch: "1" }),
    task("T-0202", { ...high, epic: "E1", batch: "2" }),
    task("T-0203", { ...high, epic: "E0" }), // без пачки — после пачек
    task("T-0204", { executor: "haiku-5.5", effort: "low", epic: "E0", batch: "1" }),
    task("T-0205", { effort: "medium", epic: "E0", runner: "local" }),
    task("T-0206", { effort: "medium", epic: "E0", runner: "human" }), // делает человек — потоку не нужна
    task("T-0207", { ...high, epic: "E1", batch: "1" }), // на доработке
    task("T-0208", { ...high, epic: "E1", batch: "3", depends_on: ["T-0209"] }),
    task("T-0209", { effort: "low", epic: "E2" }), // в работе
    task("T-0210", { ...high, epic: "E1", depends_on: ["T-0209"] }), // без пачки
    task("T-0211", { ...high, epic: "E1", batch: "2", status: "done" }),
    task("T-0212", { ...high, epic: "E1", batch: "2", status: "draft" }),
  ];
  const prs = [{ number: 40, headRefName: "task/T-0207", isDraft: true, labels: REWORK }];
  const board = classify(tasks, ["T-0207", "T-0209"], prs, [], EPIC_ORDER);
  const { streams, epics } = streamsSummary(board);
  type Item = { id: string; batch: number | null; rework?: boolean };
  type Stream = { executor: string; effort: string; runner: string; now: Item[]; queue: Item[] };
  const brief = (list: Stream[]) => list.map((stream) => [stream.executor, stream.effort, stream.runner, stream.now.map((item) => item.id), stream.queue.map((item) => item.id)]);

  it("пары: модель, уровень, раннер — any перед local; пустые пары не входят", () => {
    expect(brief(streams)).toEqual([
      ["sonnet-5.5", "medium", "local", ["T-0205"], []],
      ["sonnet-5.5", "high", "any", ["T-0207", "T-0201", "T-0202", "T-0203"], ["T-0208", "T-0210"]],
      ["haiku-5.5", "low", "any", ["T-0204"], []],
    ]);
  });

  it("доработка в now раньше новых, внутри — порядок колонки: пачка, приоритет, эпик", () => {
    const stream: Stream = streams[1];
    expect(stream.now.map((item) => item.rework)).toEqual([true, false, false, false]);
    expect(stream.now.map((item) => item.batch)).toEqual([1, 1, 2, null]);
    expect(stream.queue.map((item) => item.batch)).toEqual([3, null]);
  });

  it("человек, сделанные, черновики и задачи в работе в сводку не попадают", () => {
    const all = JSON.stringify(streams);
    for (const id of ["T-0206", "T-0209", "T-0211", "T-0212"]) expect(all).not.toContain(id);
  });

  it("элемент хранит имя файла, чтобы страница доски сделала ссылку", () => {
    expect(streams[0].now[0]).toEqual({ id: "T-0205", fileName: "T-0205-x.md", batch: null, rework: false });
  });

  it("то же по эпикам: каждая задача — в потоках своего эпика", () => {
    expect(Object.keys(epics).sort()).toEqual(["E0", "E1"]);
    expect(brief(epics.E0)).toEqual([
      ["sonnet-5.5", "medium", "local", ["T-0205"], []],
      ["sonnet-5.5", "high", "any", ["T-0203"], []],
      ["haiku-5.5", "low", "any", ["T-0204"], []],
    ]);
    expect(brief(epics.E1)).toEqual([["sonnet-5.5", "high", "any", ["T-0207", "T-0201", "T-0202"], ["T-0208", "T-0210"]]]);
  });

  it("задач нет — потоков нет", () => {
    expect(streamsSummary(classify([], [], [], [], EPIC_ORDER))).toEqual({ streams: [], epics: {} });
  });

  it("неизвестная модель идёт после известных, а не пропадает", () => {
    const odd = classify([task("T-0301", { executor: "opus-9", effort: "high" }), task("T-0302", { effort: "extra" })], [], [], [], EPIC_ORDER);
    expect(brief(streamsSummary(odd).streams).map((row) => row[0])).toEqual(["sonnet-5.5", "opus-9"]);
  });

  describe("строки таблиц", () => {
    it("now — сколько свободно и на доработке; queue — сколько ждут и ближайшая пачка", () => {
      const { now, queue } = streamRows(streams);
      expect(now.map((row: { label: string; free: number; rework: number }) => [row.label, row.free, row.rework])).toEqual([
        ["sonnet-5.5 / medium · local", 1, 0],
        ["sonnet-5.5 / high", 3, 1],
        ["haiku-5.5 / low", 1, 0],
      ]);
      expect(queue).toEqual([{ label: "sonnet-5.5 / high", count: 2, batch: 3 }]);
    });

    it("показываются первые пять задач, остальные — числом", () => {
      const many = Array.from({ length: 7 }, (_, index) => task(`T-040${String(index)}`, high));
      const { now } = streamRows(streamsSummary(classify(many, [], [], [], EPIC_ORDER)).streams);
      expect(now[0].shown.map((item: Item) => item.id)).toEqual(["T-0400", "T-0401", "T-0402", "T-0403", "T-0404"]);
      expect(now[0].more).toBe(2);
    });

    it("у ждущих нет пачки ни у одной — batch null", () => {
      const waiting = classify([task("T-0501"), task("T-0502", { depends_on: ["T-0501"] })], ["T-0501"], [], [], EPIC_ORDER);
      expect(streamRows(streamsSummary(waiting).streams).queue[0].batch).toBeNull();
    });
  });

  describe("текст для терминала", () => {
    const text = renderStreamsText(streams).join("\n");

    it("свободное и доработка по потокам, id с пачкой, local отдельной строкой", () => {
      expect(text).toContain("sonnet-5.5 / medium · local  свободно 1, на доработке 0  T-0205");
      expect(text).toContain("свободно 3, на доработке 1  T-0207 (п.1), T-0201 (п.1), T-0202 (п.2), T-0203");
    });

    it("очередь — сколько ждут и ближайшая пачка; пары без ждущих не печатаются", () => {
      const queue = text.slice(text.indexOf("На очереди"));
      expect(queue).toContain("sonnet-5.5 / high  ждут 2, ближайшая пачка 3");
      expect(queue).not.toContain("haiku");
      expect(queue).not.toContain("local");
    });

    it("пустая доска — короткие строки вместо таблиц", () => {
      expect(renderStreamsText([])).toEqual(["Запускать сейчас нечего: ни свободных задач, ни доработки.", "", "На очереди ничего нет."]);
    });
  });

  describe("значок эпика", () => {
    const stream = (executor: string, effort: string, now: number, queue = 0, runner = "any") => ({
      executor,
      effort,
      runner,
      now: Array.from({ length: now }, (_, index) => ({ id: `T-${String(index)}` })),
      queue: Array.from({ length: queue }, (_, index) => ({ id: `T-${String(index)}` })),
    });

    it("есть что делать — «сейчас: пары по убыванию числа», зелёный", () => {
      expect(epicStreamsBadge([stream("haiku-5.5", "low", 1), stream("sonnet-5.5", "high", 2)])).toEqual({
        schemaVersion: 1,
        label: "потоки",
        message: "сейчас: sonnet·high 2, haiku·low 1",
        color: "brightgreen",
        cacheSeconds: 300,
      });
    });

    it("больше трёх пар — три и «+N»; local помечается", () => {
      const badge = epicStreamsBadge([
        stream("sonnet-5.5", "low", 4),
        stream("sonnet-5.5", "medium", 3),
        stream("sonnet-5.5", "high", 2, 0, "local"),
        stream("haiku-5.5", "low", 1),
        stream("haiku-5.5", "high", 1),
      ]);
      expect(badge.message).toBe("сейчас: sonnet·low 4, sonnet·medium 3, sonnet·high·local 2 +2");
    });

    it("свободных нет, но есть очередь — светло-серый «нет свободных · в очереди N»", () => {
      const badge = epicStreamsBadge([stream("sonnet-5.5", "high", 0, 2), stream("haiku-5.5", "low", 0, 1)]);
      expect(badge).toMatchObject({ message: "нет свободных · в очереди 3", color: "lightgrey" });
    });

    it("в эпике ничего нет — просто «нет свободных»", () => {
      expect(epicStreamsBadge([])).toMatchObject({ message: "нет свободных", color: "lightgrey" });
    });
  });
});

// Кто кого ждёт (T-0205).
describe("кого ждёт PR", () => {
  const label = (name: string) => ({ name });
  const pr = (patch: Record<string, unknown> = {}) => ({ number: 1, headRefName: "task/T-0001", isDraft: false, labels: [], body: "", statusCheckRollup: [], ...patch });

  it("метка «ждёт владельца» сильнее метки «доработка»", () => {
    expect(OWNER_LABEL).toBe("ждёт владельца");
    expect(waitingOn(pr({ labels: [label("доработка"), label(OWNER_LABEL)] }))).toEqual({ who: "owner", why: "решение владельца" });
  });

  it("метка «доработка» — исполнитель", () => {
    expect(waitingOn(pr({ labels: [label("доработка")], isDraft: true, body: "## Вопросы\n1." }))).toEqual({ who: "executor", why: "доработка" });
  });

  it("черновик с разделом «## Вопросы» — тимлид, «вопрос»", () => {
    expect(waitingOn(pr({ isDraft: true, body: "Описание\n\n## Вопросы\n\n1. Как?" }))).toEqual({ who: "lead", why: "вопрос" });
  });

  it("черновик без вопросов — исполнитель, «черновик»", () => {
    expect(waitingOn(pr({ isDraft: true, body: "Пока не готово" }))).toEqual({ who: "executor", why: "черновик" });
    expect(waitingOn(pr({ isDraft: true, body: "см. ## Вопросы в тексте" }))).toEqual({ who: "executor", why: "черновик" });
  });

  it("открытый PR с упавшей проверкой — исполнитель, «CI красный»", () => {
    const rollup = [{ __typename: "CheckRun", conclusion: "FAILURE" }];
    expect(waitingOn(pr({ statusCheckRollup: rollup }))).toEqual({ who: "executor", why: "CI красный" });
  });

  it("открытый PR с идущей проверкой — тимлид, «приёмка»", () => {
    const rollup = [{ __typename: "CheckRun", conclusion: null, status: "IN_PROGRESS" }];
    expect(waitingOn(pr({ statusCheckRollup: rollup }))).toEqual({ who: "lead", why: "приёмка" });
    expect(waitingOn(pr())).toEqual({ who: "lead", why: "приёмка" });
  });

  it("поля нет вовсе — не падает", () => {
    expect(waitingOn({ number: 1, headRefName: "task/T-0001", isDraft: false })).toEqual({ who: "lead", why: "приёмка" });
  });
});

describe("красный CI", () => {
  it("StatusContext в состоянии ERROR или FAILURE — красный", () => {
    expect(isCiRed({ statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }] })).toBe(true);
    expect(isCiRed({ statusCheckRollup: [{ __typename: "StatusContext", state: "FAILURE" }] })).toBe(true);
  });

  it("CheckRun с TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE — красный", () => {
    for (const conclusion of ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
      expect(isCiRed({ statusCheckRollup: [{ __typename: "CheckRun", conclusion }] }), conclusion).toBe(true);
    }
  });

  it("успех, пропуск, идущая проверка и ожидающий статус — не красный", () => {
    const rollup = [
      { __typename: "CheckRun", conclusion: "SUCCESS" },
      { __typename: "CheckRun", conclusion: "SKIPPED" },
      { __typename: "CheckRun", conclusion: null },
      { __typename: "StatusContext", state: "PENDING" },
    ];
    expect(isCiRed({ statusCheckRollup: rollup })).toBe(false);
  });

  it("пустой список, не массив и отсутствие поля — не красный", () => {
    expect(isCiRed({ statusCheckRollup: [] })).toBe(false);
    expect(isCiRed({ statusCheckRollup: null })).toBe(false);
    expect(isCiRed({})).toBe(false);
  });
});

describe("классификация PR: кого ждут", () => {
  it("черновик с вопросами попадает в «На ревью» с waiting, ветка без PR — в «В работе»", () => {
    const prs = [{ number: 5, headRefName: "task/T-0004", isDraft: true, labels: [], body: "## Вопросы\n1. ?", statusCheckRollup: [] }];
    const board = classify([task("T-0004"), task("T-0005")], ["T-0004", "T-0005"], prs, [], EPIC_ORDER);
    expect(ids(board.review)).toEqual(["T-0004"]);
    expect(board.review[0].waiting).toEqual({ who: "lead", why: "вопрос" });
    expect(ids(board.inProgress)).toEqual(["T-0005"]);
  });

  it("доработка тоже несёт waiting", () => {
    const prs = [{ number: 6, headRefName: "task/T-0004", isDraft: false, labels: [{ name: "доработка" }], body: "", statusCheckRollup: [] }];
    const board = classify([task("T-0004")], ["T-0004"], prs, [], EPIC_ORDER);
    expect(board.rework[0].waiting).toEqual({ who: "executor", why: "доработка" });
  });
});

describe("счётчики доски", () => {
  const NOW = new Date("2026-10-24T07:00:00Z"); // 10:00 МСК
  const merged = (mergedAt: string) => [{ number: 1, headRefName: "task/T-0001", login: "a", mergedAt }];
  const empty = classify([], [], [], [], EPIC_ORDER);

  it("влитый в 23:30 UTC 23.10 (02:30 МСК 24.10) — сегодня", () => {
    expect(boardCounters(empty, merged("2026-10-23T23:30:00Z"), NOW).mergedToday).toBe(1);
  });

  it("влитый в 20:00 UTC 23.10 (23:00 МСК 23.10) — не сегодня", () => {
    expect(boardCounters(empty, merged("2026-10-23T20:00:00Z"), NOW).mergedToday).toBe(0);
  });

  it("список влитых не получен — 0", () => {
    expect(boardCounters(empty, null, NOW).mergedToday).toBe(0);
  });

  it("пачка — ближайшая с невыполненными задачами, left — их число", () => {
    const tasks = [
      task("T-0101", { batch: "1", status: "done" }),
      task("T-0102", { batch: "1", status: "cancelled" }),
      task("T-0103", { batch: "2" }),
      task("T-0104", { batch: "2" }),
      task("T-0105", { batch: "2", depends_on: ["T-0104"] }),
      task("T-0106", { batch: "3" }),
    ];
    const board = classify(tasks, [], [], [], EPIC_ORDER);
    expect(boardCounters(board, [], NOW).batch).toEqual({ number: 2, left: 3 });
  });

  it("всё сделано — пачки нет", () => {
    const board = classify([task("T-0101", { batch: "1", status: "done" }), task("T-0102", { status: "ready" })], [], [], [], EPIC_ORDER);
    expect(boardCounters(board, [], NOW).batch).toBeNull();
  });

  it("колонки и ожидание: тимлид, владелец (PR с меткой + свободные owner и human)", () => {
    const prs = [
      { number: 10, headRefName: "task/T-0201", isDraft: false, labels: [], body: "", statusCheckRollup: [] },
      { number: 11, headRefName: "task/T-0202", isDraft: false, labels: [{ name: OWNER_LABEL }], body: "", statusCheckRollup: [] },
      { number: 12, headRefName: "task/T-0203", isDraft: false, labels: [{ name: "доработка" }], body: "", statusCheckRollup: [] },
    ];
    const tasks = [
      task("T-0201"),
      task("T-0202"),
      task("T-0203"),
      task("T-0204", { runner: "owner" }),
      task("T-0205", { runner: "human" }),
      task("T-0206"),
    ];
    const board = classify(tasks, ["T-0201", "T-0202", "T-0203"], prs, [], EPIC_ORDER);
    expect(boardCounters(board, [], NOW)).toEqual({ free: 3, inProgress: 0, review: 2, rework: 1, waitLead: 1, waitOwner: 3, mergedToday: 0, batch: null });
  });
});

describe("поток owner", () => {
  it("есть в сводке потоков и подписан «· owner»", () => {
    const board = classify([task("T-0301", { runner: "owner" }), task("T-0302")], [], [], [], EPIC_ORDER);
    const { streams } = streamsSummary(board);
    expect(streams.map((stream: { runner: string }) => stream.runner)).toEqual(["any", "owner"]);
    expect(renderStreamsText(streams).join("\n")).toContain("sonnet-5.5 / medium · owner");
    expect(epicStreamsBadge(streams.slice(1)).message).toContain("sonnet·medium·owner");
  });
});

// Столбцы «Кругов», «Запустил», «Висит» (T-0206).
describe("круги доработки", () => {
  const commit = (messageHeadline: string) => ({ messageHeadline });

  it("считает коммиты «Продолжить T-NNNN после ответа» этой задачи", () => {
    const pr = {
      commits: [
        commit("feat(dev): Что-то"),
        commit("chore(tasks): Продолжить T-0001 после ответа"),
        commit("chore(tasks): Продолжить T-0001 после ответа"),
        commit("chore(tasks): Продолжить T-0002 после ответа"),
      ],
    };
    expect(reworkRounds(pr, "T-0001")).toBe(2);
    expect(reworkRounds(pr, "T-0002")).toBe(1);
  });

  it("нет коммитов или поля — ноль", () => {
    expect(reworkRounds({ commits: [] }, "T-0001")).toBe(0);
    expect(reworkRounds({}, "T-0001")).toBe(0);
    expect(reworkRounds(undefined, "T-0001")).toBe(0);
  });
});

describe("кто запустил поток", () => {
  it("значение строки «Запустил:» из описания", () => {
    expect(launchedBy("Описание\n\nПоток: claude-3 / sonnet-5.5 / medium\nЗапустил: помощник ivan_2\n")).toBe("помощник ivan_2");
    expect(launchedBy("Запустил: владелец")).toBe("владелец");
    expect(launchedBy("a\r\nЗапустил: владелец\r\n")).toBe("владелец");
  });

  it("строки нет, описания нет или строка не по формату — null", () => {
    expect(launchedBy("Просто текст")).toBeNull();
    expect(launchedBy(undefined)).toBeNull();
    expect(launchedBy(null)).toBeNull();
    expect(launchedBy("Запустил: помощник @ivan")).toBeNull();
    expect(launchedBy("в тексте Запустил: владелец")).toBeNull();
  });

  it("на тех же примерах отвечает так же, как проверка pr-check", () => {
    const bodies = [
      "Запустил: владелец",
      "Запустил: помощник ivan_2",
      "Запустил: помощник @ivan",
      "Запустил: помощник",
      "Запустил: кто-то",
      "нет строки",
    ];
    for (const body of bodies) {
      const checkOk = !checkRunnerLines(`${body}\nПоток: claude-3 / sonnet-5.5 / medium`, "task/T-0001").some((error: string) => error.startsWith("запустил"));
      expect(launchedBy(body) !== null, body).toBe(checkOk);
    }
  });
});

describe("сколько висит", () => {
  const NOW = new Date("2026-10-24T12:00:00Z");
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

  it("целые сутки: 23 часа — 0, 49 часов — 2", () => {
    expect(hangingDays(hoursAgo(23), NOW)).toBe(0);
    expect(hangingDays(hoursAgo(24), NOW)).toBe(1);
    expect(hangingDays(hoursAgo(49), NOW)).toBe(2);
  });

  it("даты нет или она битая — null; из будущего — 0", () => {
    expect(hangingDays(null, NOW)).toBeNull();
    expect(hangingDays(undefined, NOW)).toBeNull();
    expect(hangingDays("не дата", NOW)).toBeNull();
    expect(hangingDays(hoursAgo(-5), NOW)).toBe(0);
  });
});
