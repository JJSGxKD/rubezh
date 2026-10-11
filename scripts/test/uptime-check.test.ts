import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — утилита сопровождения на чистом JS, типов у неё нет и не нужно
import { checkUrl, decide } from "../ops/uptime-check.mjs";

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
