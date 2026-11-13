import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { annulRun, fetchRunReport, markHonest, restoreRun, runReportSchema, type RunReport } from "../src/api/run-report";
import {
  annulChanges,
  AXIS_TITLES,
  axisText,
  decisionToast,
  honestChanges,
  notReturnableWhy,
  ratingChange,
  ratingText,
  restoreChanges,
  reviewText,
  reviewView,
  STYLE_TITLES,
  verdictBadge,
} from "../src/screens/review/run-report-view";
import { fakeFetch, json } from "./helpers";

/**
 * Страница отчёта забега (Р203, tasks/T-0420): схема ответа сервера, слова
 * панели и то, что окна решений говорят про рейтинг ДО нажатия.
 */

const RUN = "4d1c7a0e-5a39-4c1b-8f35-1d2e3f4a5b6c";
const ACCOUNT = "8f7c1c1e-7f0a-4b8e-9d7e-1c2b3a4d5e6f";

/** Отчёт в форме `RunReportView` сервера (backend/api/src/modules/runs/run-review.service.ts). */
function sample(): Record<string, unknown> {
  return {
    runId: RUN,
    accountId: ACCOUNT,
    displayName: "Алина",
    difficulty: "hard",
    mode: "endless",
    startedAt: "2026-11-10T11:50:00.000Z",
    finishedAt: "2026-11-10T12:00:00.000Z",
    outcome: "died",
    survivalSec: 540,
    level: 14,
    enemiesKilled: 812,
    deathCause: "swarm_rat",
    weapons: [
      { id: "knife", level: 5, damage: 1200 },
      { id: "storm", level: 2 },
    ],
    details: {
      passives: [{ id: "might", level: 3 }],
      damageTaken: 220,
      xpCollected: 4000,
      waveReached: 9,
      topKills: [{ enemy: "swarm_rat", count: 500 }],
      bossKills: 1,
      eliteKills: 4,
      chestsOpened: 3,
      rareChests: 0,
      crystals: 1200,
      noHitSec: 20,
      noKillSec: 4,
      killsByElement: null,
    },
    continues: [300],
    cheats: false,
    contentHash: "abc123def456",
    rubezh: { reached: true, clearedSec: null },
    verdict: "suspicious",
    verdictReasons: ["kill_rate"],
    rating: { ranked: false, ratingRestricted: null, returnable: true },
    score: { points: 5400, axes: { t: 1.24, k: 0.9, h: 1, c: 1.1, b: 0.8 }, style: "t", band: "mid", expectedPoints: 5000 },
    scoreInput: { power: 120, huntLog: [{ rank: "elite", value: 3, aliveSec: 12 }], buildScore: 0.7 },
    review: { outcome: null, reviewedAt: null, reviewedBy: null, reviewerName: null },
    actions: { honest: true, annul: true, restore: false },
  };
}

function report(patch: Record<string, unknown> = {}): RunReport {
  return runReportSchema.parse({ ...sample(), ...patch });
}

function ratingOf(patch: Partial<RunReport["rating"]>): RunReport["rating"] {
  return { ranked: false, ratingRestricted: null, returnable: false, ...patch };
}

describe("схема отчёта", () => {
  it("разбирает пример целиком, в том числе rating.returnable и actions.restore", () => {
    const parsed = runReportSchema.parse(sample());
    expect(parsed.rating.returnable).toBe(true);
    expect(parsed.actions).toEqual({ honest: true, annul: true, restore: false });
    expect(parsed.weapons[1]?.damage).toBeUndefined();
  });

  it("не падает на details, score и scoreInput равных null", () => {
    const parsed = runReportSchema.parse({ ...sample(), details: null, score: null, scoreInput: null });
    expect(parsed.details).toBeNull();
    expect(parsed.score).toBeNull();
    expect(parsed.scoreInput).toBeNull();
  });

  it("незнакомые verdict, review.outcome и mode не роняют разбор", () => {
    const parsed = runReportSchema.parse({
      ...sample(),
      verdict: "maybe",
      mode: "daily",
      review: { outcome: "future", reviewedAt: null, reviewedBy: null, reviewerName: null },
    });
    expect(parsed.review.outcome).toBe("future");
    expect(parsed.verdict).toBe("maybe");
    expect(parsed.mode).toBe("daily");
  });

  it("отвергает ответ без обязательных полей", () => {
    const { rating: _rating, ...broken } = sample();
    expect(runReportSchema.safeParse(broken).success).toBe(false);
  });
});

describe("запросы", () => {
  it("читает отчёт и шлёт решения на свои адреса с причиной", async () => {
    const view = sample();
    const { fetch, calls } = fakeFetch(json(200, { data: view }), json(200, { data: view }), json(200, { data: view }), json(200, { data: view }));
    const api = new AdminApi(fetch);
    expect((await fetchRunReport(api, RUN)).ok).toBe(true);
    expect((await markHonest(api, RUN)).ok).toBe(true);
    expect((await annulRun(api, RUN, "читы")).ok).toBe(true);
    expect((await restoreRun(api, RUN, "ошибка проверки")).ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      `/api/v1/admin/runs/${RUN}/report`,
      `/api/v1/admin/runs/${RUN}/honest`,
      `/api/v1/admin/runs/${RUN}/annul`,
      `/api/v1/admin/runs/${RUN}/restore`,
    ]);
    expect(calls.map((call) => call.init.method)).toEqual(["GET", "POST", "POST", "POST"]);
    expect(calls[2]?.init.body).toBe(JSON.stringify({ comment: "читы" }));
    expect(calls[3]?.init.body).toBe(JSON.stringify({ comment: "ошибка проверки" }));
  });

  it("404 — «не найдено», 409 — отказ с текстом сервера", async () => {
    const { fetch } = fakeFetch(json(404, { code: "run_not_found", message: "Забег не найден" }), json(409, { code: "run_not_in_review", message: "Забег не в разборе" }));
    const api = new AdminApi(fetch);
    const missing = await fetchRunReport(api, RUN);
    expect(!missing.ok && missing.error.kind).toBe("not_found");
    const refused = await markHonest(api, RUN);
    expect(!refused.ok && refused.error.status).toBe(409);
  });
});

describe("названия", () => {
  it("оси и стили — ровно пять ключей сервера", () => {
    expect(Object.keys(AXIS_TITLES).sort()).toEqual(["b", "c", "h", "k", "t"]);
    expect(Object.keys(STYLE_TITLES).sort()).toEqual(["b", "c", "h", "k", "t"]);
    expect(STYLE_TITLES.t).toBe("Стена");
    expect(AXIS_TITLES.c).toBe("Чистота (получено урона)");
  });

  it("вердикт — значок со словом и тоном", () => {
    expect(verdictBadge("rejected")).toEqual({ tone: "danger", text: "отклонён" });
    expect(verdictBadge("suspicious")).toEqual({ tone: "warning", text: "подозрительный" });
    expect(verdictBadge("ok")).toEqual({ tone: "success", text: "честный по проверке" });
    expect(verdictBadge(null)).toEqual({ tone: "neutral", text: "без вердикта" });
  });

  it("решение разбора — с именем и датой; без имени — короткий id; нет решения — null", () => {
    const at = "2026-11-10T12:00:00.000Z";
    const named = reviewText({ outcome: "honest", reviewedAt: at, reviewedBy: ACCOUNT, reviewerName: "Мира" });
    expect(named).toMatch(/^Решение: честный — Мира, /);
    const anonymous = reviewText({ outcome: "annulled", reviewedAt: at, reviewedBy: ACCOUNT, reviewerName: null });
    expect(anonymous).toMatch(/^Решение: аннулирован — /);
    expect(anonymous).toContain(ACCOUNT.slice(0, 4));
    expect(anonymous).not.toContain(ACCOUNT);
    expect(reviewText({ outcome: null, reviewedAt: null, reviewedBy: null, reviewerName: null })).toBeNull();
  });

  it("рейтинг словами: в рейтинге, молчаливое и объявленное ограничение, просто не в рейтинге", () => {
    expect(ratingText(ratingOf({ ranked: true }))).toBe("В рейтинге");
    expect(ratingText(ratingOf({ ratingRestricted: "silent" }))).toBe("Не в рейтинге: молчаливое ограничение");
    expect(ratingText(ratingOf({ ratingRestricted: "notified" }))).toBe("Не в рейтинге: ограничение, игроку сообщили");
    expect(ratingText(ratingOf({}))).toBe("Не в рейтинге");
  });

  it("ось — два знака и запятая", () => {
    expect(axisText(1.2345)).toBe("1,23 × ожидаемого");
    expect(axisText(1)).toBe("1,00 × ожидаемого");
  });
});

describe("что станет с рейтингом — до нажатия", () => {
  it("ratingChange: уже в рейтинге, вернётся, и причины отказа по порядку", () => {
    expect(ratingChange(report({ rating: ratingOf({ ranked: true }) }))).toBe("уже в рейтинге");
    expect(ratingChange(report({ rating: ratingOf({ returnable: true }) }))).toBe("вернуть в текущие доски");
    expect(ratingChange(report({ cheats: true, rating: ratingOf({}) }))).toBe("без изменений: забег с читами");
    expect(ratingChange(report({ rating: ratingOf({ ratingRestricted: "silent" }) }))).toBe("без изменений: сдан под ограничением рейтинга");
    expect(ratingChange(report({ mode: "prologue", rating: ratingOf({}) }))).toBe("без изменений: пролог");
    expect(ratingChange(report({ rating: ratingOf({}) }))).toBe("без изменений: нерейтинговая сложность или забег раньше отсечки рейтинга");
  });

  it("notReturnableWhy берёт первое совпадение: читы сильнее ограничения и пролога", () => {
    expect(notReturnableWhy(report({ cheats: true, mode: "prologue", rating: ratingOf({ ratingRestricted: "notified" }) }))).toBe("забег с читами");
    expect(notReturnableWhy(report({ mode: "prologue", rating: ratingOf({ ratingRestricted: "notified" }) }))).toBe("сдан под ограничением рейтинга");
  });

  it("annulChanges: рейтинговый — «убрать забег», нерейтинговый — «забега в них нет»; награды и сезоны — всегда", () => {
    const ranked = annulChanges(report({ rating: ratingOf({ ranked: true }) }));
    const unranked = annulChanges(report({ rating: ratingOf({}) }));
    expect(ranked.find((row) => row.label === "Доски рейтинга и сезона")?.value).toBe("убрать забег");
    expect(unranked.find((row) => row.label === "Доски рейтинга и сезона")?.value).toBe("забега в них нет");
    for (const rows of [ranked, unranked]) {
      expect(rows.find((row) => row.label === "Выданные награды")?.value).toBe("не отнимаются");
      expect(rows.find((row) => row.label === "Закрытые сезоны")?.value).toBe("не меняются");
      expect(rows.find((row) => row.label === "Очередь разбора")?.value).toBe("убрать");
    }
  });

  it("honestChanges и restoreChanges несут строку «Рейтинг» из ratingChange и закрытые сезоны", () => {
    const view = report({ rating: ratingOf({ returnable: true }) });
    for (const rows of [honestChanges(view), restoreChanges(view)]) {
      expect(rows.find((row) => row.label === "Рейтинг")?.value).toBe(ratingChange(view));
      expect(rows.find((row) => row.label === "Закрытые сезоны")?.value).toBe("не меняются");
    }
    expect(honestChanges(view).find((row) => row.label === "Очередь разбора")?.value).toBe("убрать");
    expect(restoreChanges(view).find((row) => row.label === "Решение разбора")?.value).toBe("аннулирован → честный");
    expect(restoreChanges(view).find((row) => row.label === "Очередь разбора")?.value).toBe("не вернётся");
  });

  it("тост — по ответу сервера", () => {
    const inRating = report({ rating: ratingOf({ ranked: true }) });
    const outside = report({ rating: ratingOf({}) });
    expect(decisionToast("honest", inRating)).toBe("Забег снят с очереди и возвращён в рейтинг");
    expect(decisionToast("honest", outside)).toBe("Забег снят с очереди");
    expect(decisionToast("annul", inRating)).toBe("Забег аннулирован");
    expect(decisionToast("restore", inRating)).toBe("Аннулирование отменено, забег в рейтинге");
    expect(decisionToast("restore", outside)).toBe("Аннулирование отменено");
  });
});

describe("выбор экрана раздела", () => {
  it("нет объекта в адресе — очередь, есть — отчёт", () => {
    expect(reviewView(null)).toBe("queue");
    expect(reviewView("abc12345")).toBe("report");
  });
});
