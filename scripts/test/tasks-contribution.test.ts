import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { checkRunnerLines } from "../release/pr-check.mjs";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { contributionRows, parseRunnerLine, periodsAt } from "../tasks/contribution.mjs";

// «Вклад» на доске (T-0208): пять видов работы за пять периодов по Москве.

const NOW = new Date("2026-10-24T21:30:00Z"); // воскресенье, 00:30 МСК 25.10

describe("периоды по Москве", () => {
  const periods = periodsAt(NOW);
  const from = (key: string): string => periods.find((period: { key: string }) => period.key === key).from;
  const to = (key: string): string | null => periods.find((period: { key: string }) => period.key === key).to;

  it("пять периодов по порядку", () => {
    expect(periods.map((period: { key: string }) => period.key)).toEqual(["today", "yesterday", "week", "month", "all"]);
  });

  it("сегодня — сутки с 00:00 МСК, вчера — предыдущие", () => {
    expect(from("today")).toBe("2026-10-24T21:00:00.000Z");
    expect(to("today")).toBe("2026-10-25T21:00:00.000Z");
    expect(from("yesterday")).toBe("2026-10-23T21:00:00.000Z");
    expect(to("yesterday")).toBe("2026-10-24T21:00:00.000Z");
  });

  it("неделя — с понедельника 00:00 МСК, месяц — с первого числа", () => {
    expect(from("week")).toBe("2026-10-18T21:00:00.000Z");
    expect(from("month")).toBe("2026-09-30T21:00:00.000Z");
  });

  it("всё время — без нижней и верхней границы", () => {
    expect(from("all")).toBe("1970-01-01T00:00:00.000Z");
    expect(to("all")).toBeNull();
  });

  it("понедельник днём: неделя начинается в этот же день", () => {
    const monday = periodsAt(new Date("2026-10-26T09:00:00Z"));
    expect(monday.find((period: { key: string }) => period.key === "week").from).toBe("2026-10-25T21:00:00.000Z");
  });
});

const TASKS = [
  { id: "T-0001", size: "M", owner: "claude-2 / haiku-5.5 / low", author: "claude-lead-1" },
  { id: "T-0002", size: "S", owner: "claude-2 / haiku-5.5 / low", author: "claude-lead-1" },
];

const BODY = "Задача: tasks/archive/T-0001-x.md\n\nПоток: claude-3 / sonnet-5.5 / medium\nЗапустил: владелец";

function mergedPr(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { number: 1, headRefName: "task/T-0001", baseRefName: "dev", mergedAt: "2026-10-24T22:00:00Z", body: BODY, commits: [], reviews: [], comments: [], ...patch };
}

const rowsOf = (period: string, input: Record<string, unknown>) =>
  contributionRows({ tasks: TASKS, mergedPrs: [], specs: [], now: NOW, ...input })[period];

describe("задачи и очки", () => {
  it("задача M, влитая сегодня: «claude-3 · владелец», 1 задача, 2 очка; за вчера — нет", () => {
    const input = { mergedPrs: [mergedPr()] };
    for (const period of ["today", "week", "month", "all"]) {
      expect(rowsOf(period, input), period).toEqual([{ who: "claude-3 · владелец", tasks: 1, points: 2, rework: 0, reviews: 0, specs: 0, leadPrs: 0 }]);
    }
    expect(rowsOf("yesterday", input)).toEqual([]);
  });

  it("помощник: строка «Запустил: помощник ivan_2» делает отдельную строку", () => {
    const body = BODY.replace("Запустил: владелец", "Запустил: помощник ivan_2");
    const rows = rowsOf("today", { mergedPrs: [mergedPr(), mergedPr({ number: 2, body })] });
    expect(rows.map((row: { who: string }) => row.who).sort()).toEqual(["claude-3 · владелец", "claude-3 · помощник ivan_2"]);
  });

  it("старый PR без строк: аккаунт из owner файла, человек — «не указан»", () => {
    const rows = rowsOf("today", { mergedPrs: [mergedPr({ body: "Без строк" })] });
    expect(rows[0]).toMatchObject({ who: "claude-2 · не указан", tasks: 1, points: 2 });
  });

  it("задачи нет в реестре — одно очко, аккаунт «не указан · не указан»", () => {
    const rows = rowsOf("today", { mergedPrs: [mergedPr({ headRefName: "task/T-0999", body: "" })] });
    expect(rows[0]).toMatchObject({ tasks: 1, points: 1 });
  });

  it("порядок строк: очки, затем ревью и ответы, затем имя", () => {
    const task = (number: number, id: string, account: string) => mergedPr({ number, headRefName: `task/${id}`, body: BODY.replace("claude-3", account) });
    const comment = (name: string) => ({ author: { login: "x" }, body: `**${name}:** ок`, createdAt: "2026-10-24T22:00:00Z" });
    const rows = rowsOf("today", {
      mergedPrs: [
        task(1, "T-0001", "claude-6"), // M — два очка
        task(2, "T-0002", "claude-5"), // S — одно
        task(3, "T-0002", "claude-4"), // S — одно
        mergedPr({ number: 4, headRefName: "docs/x", body: "Тело", comments: [comment("claude-review-2"), comment("claude-lead-1"), comment("claude-lead-1")] }),
      ],
    });
    expect(rows.map((row: { who: string }) => row.who)).toEqual([
      "claude-6 · владелец",
      "claude-4 · владелец",
      "claude-5 · владелец",
      "claude-lead-1 · —",
      "claude-review-2 · —",
    ]);
  });
});

describe("доработки", () => {
  it("круги — коммиты «Продолжить T-0001 после ответа» того же PR, потоку и периоду задачи", () => {
    const commits = [
      { messageHeadline: "feat: что-то" },
      { messageHeadline: "chore(tasks): Продолжить T-0001 после ответа" },
      { messageHeadline: "chore(tasks): Продолжить T-0001 после ответа" },
    ];
    const rows = rowsOf("today", { mergedPrs: [mergedPr({ commits })] });
    expect(rows[0]).toMatchObject({ who: "claude-3 · владелец", rework: 2 });
  });
});

describe("ревью и ответы", () => {
  const signed = (name: string, createdAt: string) => ({ author: { login: "Ferdinans228" }, body: `**${name}:** ответ`, createdAt });

  it("подписанный комментарий считается, без подписи — нет; кто — кодовое имя, человек «—»", () => {
    const comments = [signed("claude-lead-1", "2026-10-24T23:00:00Z"), { author: { login: "x" }, body: "просто текст", createdAt: "2026-10-24T23:00:00Z" }];
    const rows = rowsOf("today", { mergedPrs: [mergedPr({ headRefName: "docs/x", body: "Тело", comments })] });
    expect(rows).toEqual([{ who: "claude-lead-1 · —", tasks: 0, points: 0, rework: 0, reviews: 1, specs: 0, leadPrs: 0 }]);
  });

  it("ревью считается по submittedAt; период — по дате ревью, а не слияния", () => {
    const reviews = [{ author: { login: "x" }, body: "**claude-review-2:** Approve", submittedAt: "2026-10-23T22:00:00Z" }];
    const input = { mergedPrs: [mergedPr({ reviews })] };
    expect(rowsOf("yesterday", input).find((row: { who: string }) => row.who === "claude-review-2 · —")).toMatchObject({ reviews: 1 });
    expect(rowsOf("today", input).find((row: { who: string }) => row.who === "claude-review-2 · —")).toBeUndefined();
  });

  it("поток-исполнитель, подписавшийся claude-N, получает «не указан»", () => {
    const rows = rowsOf("today", { mergedPrs: [mergedPr({ headRefName: "docs/x", body: "Тело", comments: [signed("claude-12", "2026-10-24T23:00:00Z")] })] });
    expect(rows[0].who).toBe("claude-12 · не указан");
  });
});

describe("спецификации", () => {
  it("по полю author и дате добавления: вчера — в «вчера», «неделе» и далее", () => {
    const specs = [{ id: "T-0003", author: "claude-lead-1", addedAt: "2026-10-24T10:00:00Z" }];
    expect(rowsOf("yesterday", { specs })).toEqual([{ who: "claude-lead-1 · —", tasks: 0, points: 0, rework: 0, reviews: 0, specs: 1, leadPrs: 0 }]);
    expect(rowsOf("today", { specs })).toEqual([]);
    expect(rowsOf("week", { specs })[0]).toMatchObject({ specs: 1 });
  });

  it("спецификация без автора не считается", () => {
    expect(rowsOf("all", { specs: [{ id: "T-0003", author: null, addedAt: "2026-10-24T10:00:00Z" }] })).toEqual([]);
  });

  it("без GitHub (mergedPrs = null) спецификации всё равно считаются", () => {
    const specs = [{ id: "T-0003", author: "claude-lead-2", addedAt: "2026-10-25T00:00:00Z" }];
    expect(rowsOf("today", { mergedPrs: null, specs })[0]).toMatchObject({ who: "claude-lead-2 · —", specs: 1 });
  });
});

describe("PR тимлидов", () => {
  const lead = { headRefName: "lead/x", body: "**claude-lead-1:** Правка правил\n\nТело" };

  it("влитый PR не из task/ с подписью в первой строке — «PR тимлидов»", () => {
    expect(rowsOf("today", { mergedPrs: [mergedPr(lead)] })).toEqual([{ who: "claude-lead-1 · —", tasks: 0, points: 0, rework: 0, reviews: 0, specs: 0, leadPrs: 1 }]);
  });

  it("служебный синк main → dev и PR без подписи не считаются", () => {
    expect(rowsOf("today", { mergedPrs: [mergedPr({ ...lead, headRefName: "main" })] })).toEqual([]);
    expect(rowsOf("today", { mergedPrs: [mergedPr({ headRefName: "lead/y", body: "Просто PR" })] })).toEqual([]);
  });

  it("подпись не в первой строке не считается", () => {
    expect(rowsOf("today", { mergedPrs: [mergedPr({ headRefName: "lead/y", body: "Вступление\n**claude-lead-1:** текст" })] })).toEqual([]);
  });
});

describe("строка «Поток:»", () => {
  it("разбор отдаёт аккаунт", () => {
    expect(parseRunnerLine("Описание\nПоток: claude-3 / sonnet-5.5 / medium\nЗапустил: владелец")).toBe("claude-3");
    expect(parseRunnerLine("нет строки")).toBeNull();
  });

  it("на тех же примерах отвечает так же, как проверка pr-check", () => {
    const bodies = ["Поток: claude-3 / sonnet-5.5 / medium", "Поток: claude-x / sonnet-5.5 / medium", "Поток: claude-3 / gpt-5 / medium", "Поток: claude-3 / sonnet-5.5", "ничего"];
    for (const body of bodies) {
      const checkOk = !checkRunnerLines(`${body}\nЗапустил: владелец`, "task/T-0001").some((error: string) => error.startsWith("поток"));
      // pr-check дополнительно сверяет модель и уровень по спискам; формат строки совпадает.
      if (checkOk) expect(parseRunnerLine(body), body).not.toBeNull();
      if (parseRunnerLine(body) === null) expect(checkOk, body).toBe(false);
    }
  });
});
