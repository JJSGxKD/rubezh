import { describe, expect, it } from "vitest";
import { AdminApi, CSRF_HEADER, CSRF_VALUE } from "../src/api/client";
import {
  CATEGORY_ACTIONS,
  CATEGORY_ORDER,
  CATEGORY_TITLES,
  KIND_TITLES,
  canRun,
  categoryCounts,
  createRule,
  fetchReclean,
  fetchRules,
  recleanLine,
  ruleFormSchema,
  rulesOf,
  startPreview,
  startRun,
  verdictText,
  type RecleanState,
  type RulesView,
} from "../src/api/name-rules";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Фильтр имён в панели (tasks/T-0339): слой API с Zod на границе, чистые
// функции экрана — отбор по вкладкам, форма, подписи исходов, строка перечистки
// и условие кнопки «Перечистить».

const LIMITS = { patternMax: 100, noteMax: 200, rulesMax: 2000, samplesMax: 20, sampleMax: 64 };
const NOW = new Date("2026-10-28T12:00:00Z");

function rule(patch: Partial<RulesView["rules"][number]> = {}): RulesView["rules"][number] {
  return {
    ruleId: "00000000-0000-4000-8000-000000000001",
    category: "brand",
    kind: "exact",
    pattern: "пример-бренд",
    active: true,
    note: null,
    updatedAt: "2026-10-20T10:00:00.000Z",
    updatedBy: null,
    ...patch,
  };
}

function state(patch: Partial<RecleanState> = {}): RecleanState {
  return {
    runId: "run-1",
    mode: "preview",
    status: "done",
    signature: "sig",
    scanned: 1200,
    planned: 41,
    updated: 0,
    skipped: 0,
    locked: 3,
    startedAt: "2026-10-28T11:50:00.000Z",
    finishedAt: "2026-10-28T11:55:00.000Z",
    startedBy: "a-1",
    error: null,
    ...patch,
  };
}

describe("слой API", () => {
  it("fetchRules разбирает ответ схемой; ответ без поля — ошибка, а не undefined", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { rules: [rule()], limits: LIMITS } }), json(200, { data: { rules: [rule()] } }));
    const api = new AdminApi(fetch);

    const ok = await fetchRules(api);
    expect(ok.ok && ok.data.rules[0]?.pattern).toBe("пример-бренд");
    expect(calls[0]?.url).toBe("/api/v1/admin/name-rules");

    const broken = await fetchRules(api);
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.error.kind).toBe("unavailable");
  });

  it("createRule шлёт POST без лишних полей и с заголовком CSRF; текст отказа попадает в error", async () => {
    const { fetch, calls } = fakeFetch(json(201, { data: rule() }), json(400, { error: { code: "name_rule_invalid", message: "Шаблон — от 1 до 100 знаков" } }));
    const api = new AdminApi(fetch);

    const created = await createRule(api, { category: "brand", kind: "exact", pattern: "пример-бренд", note: null, active: true });
    expect(created.ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/v1/admin/name-rules");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ category: "brand", kind: "exact", pattern: "пример-бренд", note: null, active: true });
    expect((calls[0]?.init.headers as Record<string, string>)[CSRF_HEADER]).toBe(CSRF_VALUE);

    const rejected = await createRule(api, { category: "brand", kind: "exact", pattern: "x" });
    expect(!rejected.ok && rejected.error).toMatchObject({ kind: "rejected", status: 400, message: "Шаблон — от 1 до 100 знаков" });
  });

  it("перечистка: чтение, предпросмотр и запуск идут своими адресами", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: null }), json(200, { data: state({ status: "queued", mode: "preview" }) }), json(200, { data: state({ mode: "run", status: "queued" }) }));
    const api = new AdminApi(fetch);

    const idle = await fetchReclean(api);
    expect(idle.ok && idle.data).toBeNull();
    expect(calls[0]?.url).toBe("/api/v1/admin/name-rules/reclean");

    await startPreview(api);
    expect([calls[1]?.url, calls[1]?.init.method]).toEqual(["/api/v1/admin/name-rules/reclean/preview", "POST"]);

    await startRun(api, "run-1");
    expect([calls[2]?.url, calls[2]?.init.method]).toEqual(["/api/v1/admin/name-rules/reclean/run", "POST"]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ previewRunId: "run-1" });
  });
});

describe("вкладки и список", () => {
  const view: RulesView = {
    limits: LIMITS,
    rules: [
      rule({ ruleId: "1", pattern: "Яблоко" }),
      rule({ ruleId: "2", pattern: "арбуз", active: false }),
      rule({ ruleId: "3", pattern: "банан" }),
      rule({ ruleId: "4", category: "profanity", pattern: "слово" }),
      rule({ ruleId: "5", category: "allow", pattern: "исключение" }),
    ],
  };

  it("пять вкладок в заданном порядке, у каждой подпись и действие", () => {
    expect(CATEGORY_ORDER).toEqual(["brand", "ads", "profanity", "other", "allow"]);
    expect(CATEGORY_TITLES.allow).toBe("Исключения");
    expect(CATEGORY_ACTIONS.profanity).toBe("ник заменяется целиком");
    expect(CATEGORY_ACTIONS.allow).toBe("не трогается");
    expect(KIND_TITLES.word).toBe("Слово целиком");
  });

  it("rulesOf: отбор по вкладке, включённые выше выключенных, порядок без учёта регистра", () => {
    expect(rulesOf(view, "brand").map((item) => item.pattern)).toEqual(["банан", "Яблоко", "арбуз"]);
    expect(rulesOf(view, "ads")).toEqual([]);
  });

  it("categoryCounts считает правила каждой вкладки, пустые — нулём", () => {
    expect(categoryCounts(view)).toEqual({ brand: 3, ads: 0, profanity: 1, other: 0, allow: 1 });
  });
});

describe("форма правила", () => {
  const schema = ruleFormSchema(LIMITS);
  const base = { category: "brand", kind: "exact", pattern: "пример", note: "", active: true } as const;

  it("пустой шаблон и 101 знак — наши тексты", () => {
    const empty = schema.safeParse({ ...base, pattern: "   " });
    expect(!empty.success && empty.error.issues[0]?.message).toBe("Введите слово или фразу");
    const long = schema.safeParse({ ...base, pattern: "а".repeat(101) });
    expect(!long.success && long.error.issues[0]?.message).toBe("Не длиннее 100 знаков");
  });

  it("заметка длиннее 200 знаков — ошибка", () => {
    const result = schema.safeParse({ ...base, note: "б".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("пробелы по краям обрезаются", () => {
    const result = schema.safeParse({ ...base, pattern: "  пример  " });
    expect(result.success && result.data.pattern).toBe("пример");
  });
});

describe("подписи", () => {
  it("verdictText: четыре исхода", () => {
    expect(verdictText({ sample: "Вася", name: "Вася", verdict: "ok", candidateHit: false, saved: false })).toBe("ник не изменится");
    expect(verdictText({ sample: "Вася пример-бренд", name: "Вася", verdict: "symbols", candidateHit: true, saved: false })).toBe("останется: Вася");
    expect(verdictText({ sample: "слово", name: null, verdict: "profanity", candidateHit: true, saved: false })).toBe("ник будет заменён");
    expect(verdictText({ sample: "пример-бренд", name: null, verdict: "empty", candidateHit: true, saved: false })).toBe("ника не останется");
  });

  it("recleanLine: строка на каждое состояние", () => {
    expect(recleanLine(null)).toBe("Перечистка ещё не запускалась");
    expect(recleanLine(state({ status: "running", scanned: 500, planned: 12 }))).toBe("Считаем: проверено 500, затронет 12");
    expect(recleanLine(state({ planned: 41, scanned: 1200, locked: 3 }))).toMatch(/^Затронет 41 игрок из 1\s200 проверенных \(закреплённых: 3\)$/);
    expect(recleanLine(state({ planned: 42 }))).toContain("Затронет 42 игрока");
    expect(recleanLine(state({ planned: 45 }))).toContain("Затронет 45 игроков");
    expect(recleanLine(state({ mode: "run", status: "running", scanned: 500, updated: 20 }))).toBe("Перечищаем: проверено 500, изменено 20");
    expect(recleanLine(state({ mode: "run", status: "done", updated: 41, skipped: 2 }))).toBe("Готово: изменено 41, пропущено 2 — игрок успел зайти");
    expect(recleanLine(state({ mode: "run", status: "stopped", updated: 10, planned: 41 }))).toBe("Остановлено: изменено 10 из 41");
    expect(recleanLine(state({ mode: "run", status: "failed", error: "Правила изменились — запустите заново" }))).toBe("Правила изменились — запустите заново");
  });

  it("canRun: ложь без предпросмотра, при запуске, при устаревшем и при изменённых правилах; истина при свежем", () => {
    expect(canRun(null, false, NOW)).toBe(false);
    expect(canRun(state({ mode: "run" }), false, NOW)).toBe(false);
    expect(canRun(state({ status: "running" }), false, NOW)).toBe(false);
    expect(canRun(state({ finishedAt: "2026-10-28T10:00:00.000Z" }), false, NOW)).toBe(false);
    expect(canRun(state(), true, NOW)).toBe(false);
    expect(canRun(state(), false, NOW)).toBe(true);
  });
});

describe("меню", () => {
  it("раздел names в группе «Поддержка» с правом names.edit", () => {
    const section = SECTIONS.find((item) => item.id === "names");
    expect(section).toMatchObject({ title: "Фильтр имён", permission: "names.edit" });
  });
});
