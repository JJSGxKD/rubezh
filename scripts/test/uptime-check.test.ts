import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — утилита сопровождения на чистом JS, типов у неё нет и не нужно
import { CHECK_STEP, DOWN_STEP, checkUrl, decide, previousState, stateOfRun, writeStateOutput } from "../ops/uptime-check.mjs";

// Внешняя проверка прода (tasks/T-0034): 200 за 10 секунд со второй попытки;
// сообщение — только при смене состояния.

const URL_CLIENT = "https://client.example/";
const URL_API = "https://api.example/health/ready";

function answer(status: number) {
  return { status, ok: status >= 200 && status < 300 };
}

function sequence(...steps: (number | Error)[]) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return answer(step as number);
  });
  return { fetchImpl, calls };
}

const instantWait = async () => undefined;

afterEach(() => {
  vi.useRealTimers();
});

describe("checkUrl", () => {
  it("200 с первого раза — рабочий, одна попытка", async () => {
    const { fetchImpl } = sequence(200);
    expect(await checkUrl(URL_CLIENT, { fetchImpl, wait: instantWait })).toEqual({ url: URL_CLIENT, ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("503, затем 200 — рабочий, две попытки", async () => {
    const { fetchImpl } = sequence(503, 200);
    expect(await checkUrl(URL_CLIENT, { fetchImpl, wait: instantWait })).toEqual({ url: URL_CLIENT, ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("503 дважды — падение с кодом", async () => {
    const { fetchImpl } = sequence(503);
    expect(await checkUrl(URL_API, { fetchImpl, wait: instantWait })).toEqual({ url: URL_API, ok: false, reason: "HTTP 503" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("между попытками ждёт паузу", async () => {
    const { fetchImpl } = sequence(500, 200);
    const wait = vi.fn(async () => undefined);
    await checkUrl(URL_CLIENT, { fetchImpl, wait, retryDelayMs: 5_000 });
    expect(wait).toHaveBeenCalledWith(5_000);
  });

  it("зависший запрос — «нет ответа за 10 с»", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise<never>(() => undefined));
    const pending = checkUrl(URL_CLIENT, { fetchImpl, wait: instantWait, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await pending).toEqual({ url: URL_CLIENT, ok: false, reason: "нет ответа за 10 с" });
  });

  it("ошибка сети — с кодом ошибки", async () => {
    const { fetchImpl } = sequence(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    expect(await checkUrl(URL_CLIENT, { fetchImpl, wait: instantWait })).toEqual({
      url: URL_CLIENT,
      ok: false,
      reason: "ошибка сети: ECONNREFUSED",
    });
  });

  it("ошибка без кода — «неизвестно»", async () => {
    const { fetchImpl } = sequence(new Error("что-то"));
    expect(await checkUrl(URL_CLIENT, { fetchImpl, wait: instantWait })).toMatchObject({ ok: false, reason: "ошибка сети: неизвестно" });
  });
});

describe("decide", () => {
  const ok = [
    { url: URL_CLIENT, ok: true },
    { url: URL_API, ok: true },
  ];
  const oneDown = [
    { url: URL_CLIENT, ok: true },
    { url: URL_API, ok: false, reason: "HTTP 503" },
  ];

  it("прогонов не было и всё хорошо — тихо", () => {
    expect(decide(null, ok)).toEqual({ state: "up", message: null });
  });

  it("было хорошо, упал один адрес — «🔴» с адресом и причиной", () => {
    const { state, message } = decide("up", oneDown);
    expect(state).toBe("down");
    expect(message).toBe(
      ["🔴 Прод недоступен", `${URL_API} — HTTP 503`, "Проверка из GitHub Actions; следующая — через 5 минут."].join("\n"),
    );
  });

  it("плохо и дальше — молчание", () => {
    expect(decide("down", oneDown)).toEqual({ state: "down", message: null });
  });

  it("было плохо, стало хорошо — «🟢» со всеми адресами", () => {
    expect(decide("down", ok)).toEqual({ state: "up", message: `🟢 Прод снова доступен: ${URL_CLIENT}, ${URL_API}` });
  });

  it("прогонов не было и упал — «🔴»", () => {
    const { state, message } = decide(null, oneDown);
    expect(state).toBe("down");
    expect(message).toContain("🔴 Прод недоступен");
  });

  it("упавшие адреса — по строке на каждый", () => {
    const both = [
      { url: URL_CLIENT, ok: false, reason: "нет ответа за 10 с" },
      { url: URL_API, ok: false, reason: "HTTP 503" },
    ];
    const lines = (decide("up", both).message as string).split("\n");
    expect(lines).toContain(`${URL_CLIENT} — нет ответа за 10 с`);
    expect(lines).toContain(`${URL_API} — HTTP 503`);
  });
});

// Прежнее состояние — итог ближайшего прогона, давшего ответ про прод
// (tasks/T-0088): отменённые и упавшие сами пропускаются.

const step = (name: string, conclusion: string) => ({ name, conclusion });
const REAL_DOWN = [step(CHECK_STEP, "success"), step(DOWN_STEP, "failure")];
const FAILED_CHECKOUT = [step("Run actions/checkout", "failure")];
const SCRIPT_FAILED = [step(CHECK_STEP, "failure")];

type Run = { databaseId: number; conclusion: string; steps?: { name: string; conclusion: string }[] };

/** Поддельный `gh`: `run list` отдаёт прогоны, `run view` — шаги нужного. */
function gh(runs: Run[]) {
  const calls: string[][] = [];
  const runGh = vi.fn((args: string[]) => {
    calls.push(args);
    if (args[0] === "run" && args[1] === "list") return runs.map(({ databaseId, conclusion }) => ({ databaseId, conclusion }));
    const run = runs.find((candidate) => String(candidate.databaseId) === args[2]);
    return { jobs: [{ steps: run?.steps ?? [] }] };
  });
  return { runGh, calls };
}

const run = (databaseId: number, conclusion: string, steps?: Run["steps"]): Run => ({ databaseId, conclusion, ...(steps === undefined ? {} : { steps }) });

describe("stateOfRun", () => {
  it("success — прод в порядке", () => {
    expect(stateOfRun("success", [])).toBe("up");
  });

  it("failure и упавший шаг «Прод недоступен» — прод лежит", () => {
    expect(stateOfRun("failure", REAL_DOWN)).toBe("down");
  });

  it("failure по другому шагу (checkout, setup) — про прод ничего", () => {
    expect(stateOfRun("failure", FAILED_CHECKOUT)).toBeNull();
  });

  it("упал сам скрипт проверки или старый прогон без нового шага — про прод ничего", () => {
    expect(stateOfRun("failure", SCRIPT_FAILED)).toBeNull();
  });

  it("отменённый и просроченный прогоны ответа не дают", () => {
    expect(stateOfRun("cancelled", REAL_DOWN)).toBeNull();
    expect(stateOfRun("timed_out", REAL_DOWN)).toBeNull();
  });
});

describe("previousState", () => {
  it("прогонов нет — неизвестно", () => {
    expect(previousState(gh([]).runGh)).toBeNull();
  });

  it("последний прогон успешен — «up»", () => {
    expect(previousState(gh([run(3, "success")]).runGh)).toBe("up");
  });

  it("отменённый прогон пропускается: дальше лежал прод — «down», второго «🔴» нет", () => {
    const state = previousState(gh([run(3, "cancelled"), run(2, "failure", REAL_DOWN)]).runGh);
    expect(state).toBe("down");
    expect(decide(state, [{ url: URL_CLIENT, ok: false, reason: "HTTP 503" }]).message).toBeNull();
  });

  it("прогон, упавший сам, пропускается: дальше был успех — «up», ложного «🟢» нет", () => {
    const state = previousState(gh([run(3, "failure", FAILED_CHECKOUT), run(2, "success")]).runGh);
    expect(state).toBe("up");
    expect(decide(state, [{ url: URL_CLIENT, ok: true }]).message).toBeNull();
  });

  it("никто из десяти не сказал про прод — неизвестно", () => {
    expect(previousState(gh([run(3, "cancelled"), run(2, "failure", SCRIPT_FAILED), run(1, "cancelled")]).runGh)).toBeNull();
  });

  it("список — десять завершённых прогонов, шаги смотрим только у failure", () => {
    const { runGh, calls } = gh([run(4, "cancelled"), run(3, "failure", FAILED_CHECKOUT), run(2, "timed_out"), run(1, "success")]);
    previousState(runGh);
    expect(calls[0]).toEqual(["run", "list", "--workflow", "uptime.yml", "--status", "completed", "--limit", "10", "--json", "databaseId,conclusion"]);
    expect(calls.filter((args) => args[1] === "view")).toEqual([["run", "view", "3", "--json", "jobs"]]);
  });

  it("долгий обход прерывается по бюджету времени", () => {
    let clock = 0;
    const now = () => (clock += 70_000);
    const { runGh, calls } = gh([run(4, "failure", FAILED_CHECKOUT), run(3, "failure", FAILED_CHECKOUT), run(2, "failure", FAILED_CHECKOUT), run(1, "success")]);
    expect(previousState(runGh, { now })).toBeNull();
    expect(calls.filter((args) => args[1] === "view")).toHaveLength(1);
  });

  it("gh бросает — неизвестно, причина в stderr", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runGh = vi.fn(() => {
      throw new Error("нет сети");
    });
    expect(previousState(runGh)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("нет сети"));
    error.mockRestore();
  });
});

describe("writeStateOutput", () => {
  it("дописывает state=… в файл вывода шага", () => {
    const dir = mkdtempSync(join(tmpdir(), "uptime-"));
    try {
      const file = join(dir, "output");
      writeStateOutput("down", file);
      writeStateOutput("up", file);
      expect(readFileSync(file, "utf8")).toBe("state=down\nstate=up\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
