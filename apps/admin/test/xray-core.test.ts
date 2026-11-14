import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchXrayCore, refreshXrayCore, updateXrayCore, xrayCoreSchema } from "../src/api/xray-core";
import { formatTime } from "../src/format";
import { blockedText, compatibilityText, runningNote, runText, testedRangeText } from "../src/screens/proxies/xray-core-view";

/** Пример ответа `GET /admin/xray-core` — поля `XrayCoreView` из T-0416. */
const sample = {
  running: { state: "ok", version: "26.9.1", startedAt: "2026-11-10T08:00:00.000Z", compatibility: { kind: "tested" } },
  tested: { min: "26.9.1", max: "26.10.31" },
  latest: {
    version: "26.11.5",
    publishedAt: "2026-11-05T10:00:00.000Z",
    url: "https://github.com/XTLS/Xray-core/releases/tag/v26.11.5",
    checkedAt: "2026-11-13T09:00:00.000Z",
    compatibility: { kind: "untested" },
  },
  latestError: null,
  update: {
    configured: true,
    blockedBy: null,
    lastRun: {
      status: "completed",
      active: false,
      conclusion: "success",
      url: "https://github.com/JJSGxKD/rubezh/actions/runs/1",
      createdAt: "2026-11-12T10:00:00.000Z",
      title: "xray-bump 26.10.31",
    },
    lastRunError: null,
    lockedUntil: null,
  },
};

describe("схема ответа «Ядро Xray»", () => {
  it("разбирает пример ответа сервера целиком", () => {
    const parsed = xrayCoreSchema.parse(sample);
    expect(parsed.running.version).toBe("26.9.1");
    expect(parsed.latest?.compatibility.kind).toBe("untested");
    expect(parsed.update.lastRun?.conclusion).toBe("success");
  });

  it("незнакомые blockedBy и kind не роняют разбор", () => {
    const parsed = xrayCoreSchema.parse({
      ...sample,
      running: { ...sample.running, compatibility: { kind: "future" } },
      latest: { ...sample.latest, compatibility: { kind: "blocked", reason: "сломан REALITY" } },
      update: { ...sample.update, blockedBy: "new_code" },
    });
    expect(parsed.update.blockedBy).toBe("new_code");
    expect(parsed.running.compatibility?.kind).toBe("future");
  });

  it("без выпуска, без запуска и без версии — тоже годный ответ", () => {
    const parsed = xrayCoreSchema.parse({
      ...sample,
      running: { state: "missing", version: null, startedAt: null, compatibility: null },
      latest: null,
      latestError: "GitHub не ответил",
      update: { ...sample.update, configured: false, blockedBy: "no_token", lastRun: null },
    });
    expect(parsed.latest).toBeNull();
    expect(parsed.update.lastRun).toBeNull();
  });

  it("не тот ответ — не годный", () => {
    expect(xrayCoreSchema.safeParse({ running: null }).success).toBe(false);
  });
});

describe("запросы", () => {
  it("состояние, проверка и запуск идут на свои адреса", async () => {
    const calls: { path: string; method: string; body: string | null }[] = [];
    const api = new AdminApi(async (input, init) => {
      calls.push({ path: input, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : null });
      return new Response(JSON.stringify({ data: sample }), { status: 200, headers: { "content-type": "application/json" } });
    });
    expect((await fetchXrayCore(api)).ok).toBe(true);
    expect((await refreshXrayCore(api)).ok).toBe(true);
    expect((await updateXrayCore(api, "26.11.5")).ok).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.path.replace(/^.*\/admin/, "")}`)).toEqual(["GET /xray-core", "POST /xray-core/refresh", "POST /xray-core/update"]);
    expect(calls[2]?.body).toBe(JSON.stringify({ version: "26.11.5" }));
  });
});

describe("compatibilityText", () => {
  it("проверена", () => {
    expect(compatibilityText({ kind: "tested" })).toEqual({ tone: "success", label: "Проверено", detail: "Наш конфиг принят этой версией" });
  });

  it("не проверена", () => {
    expect(compatibilityText({ kind: "untested" })).toEqual({ tone: "warning", label: "Не проверено", detail: "Проверит CI в PR обновления" });
  });

  it("несовместима: причина — в detail", () => {
    expect(compatibilityText({ kind: "blocked", reason: "сломан REALITY" })).toEqual({ tone: "danger", label: "Перейти нельзя, нужно обновить код", detail: "сломан REALITY" });
  });

  it("старше проверенных", () => {
    expect(compatibilityText({ kind: "older" })).toEqual({ tone: "neutral", label: "Старше проверенных", detail: "Обновляться на неё незачем" });
  });

  it("не распознана", () => {
    expect(compatibilityText({ kind: "unknown" })).toEqual({ tone: "neutral", label: "Версия не распознана", detail: null });
  });

  it("незнакомый kind — neutral с самим кодом", () => {
    expect(compatibilityText({ kind: "future" })).toEqual({ tone: "neutral", label: "future", detail: null });
  });
});

describe("blockedText", () => {
  it.each([
    ["no_release", "Свежий выпуск не получен"],
    ["blocked", "Перейти нельзя, нужно обновить код"],
    ["older", "Выпуск старше проверенных версий"],
    ["up_to_date", "Ядро уже этой версии"],
    ["in_code", "Версия уже в коде — уедет с ближайшим выпуском"],
    ["running", "Обновление уже идёт"],
    ["no_token", "Нет ключа github.xray-update"],
  ])("%s", (code, text) => {
    expect(blockedText(code, null)).toBe(text);
  });

  it("locked — со временем окончания в поясе браузера", () => {
    const until = "2026-11-13T09:30:00.000Z";
    expect(blockedText("locked", until)).toBe(`Запускали недавно — снова можно в ${formatTime(until)}`);
    expect(blockedText("locked", until)).toMatch(/^Запускали недавно — снова можно в \d{2}:\d{2}$/);
  });

  it("locked без времени — без выдуманной цифры", () => {
    expect(blockedText("locked", null)).toBe("Запускали недавно — подождите немного");
  });

  it("незнакомый код — сам код", () => {
    expect(blockedText("new_code", null)).toBe("new_code");
  });
});

describe("runText", () => {
  it("идёт", () => {
    expect(runText({ status: "in_progress", active: true, conclusion: null })).toEqual({ tone: "warning", label: "идёт" });
  });

  it("успех", () => {
    expect(runText({ status: "completed", active: false, conclusion: "success" })).toEqual({ tone: "success", label: "PR открыт" });
  });

  it("сбой", () => {
    expect(runText({ status: "completed", active: false, conclusion: "failure" })).toEqual({
      tone: "danger",
      label: "упал — проверка конфига не прошла или ошибка запуска, смотрите в GitHub",
    });
  });

  it("отменён", () => {
    expect(runText({ status: "completed", active: false, conclusion: "cancelled" })).toEqual({ tone: "neutral", label: "отменён" });
  });

  it("другое — conclusion как есть", () => {
    expect(runText({ status: "completed", active: false, conclusion: "skipped" })).toEqual({ tone: "neutral", label: "skipped" });
  });
});

describe("testedRangeText", () => {
  it("одна версия", () => {
    expect(testedRangeText("26.10.31", "26.10.31")).toBe("Проверена версия 26.10.31");
  });

  it("диапазон", () => {
    expect(testedRangeText("26.9.1", "26.10.31")).toBe("Проверены версии 26.9.1–26.10.31");
  });
});

describe("runningNote", () => {
  it("старше проверенных — предупреждение", () => {
    expect(runningNote({ compatibility: { kind: "older" } })).toEqual({ tone: "warning", text: "Запущенное ядро старше проверенных версий — выкатите выпуск" });
  });

  it("новее проверенных — сведение", () => {
    expect(runningNote({ compatibility: { kind: "untested" } })).toEqual({ tone: "info", text: "Запущенное ядро новее проверенных версий" });
  });

  it("проверена и нет сведений — без замечания", () => {
    expect(runningNote({ compatibility: { kind: "tested" } })).toBeNull();
    expect(runningNote({ compatibility: null })).toBeNull();
  });
});
