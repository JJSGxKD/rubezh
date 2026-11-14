import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  clientOsOf,
  decideReplay,
  effectOf,
  jobIdOf,
  jobPriorityOf,
  parseJobId,
  lootNeedsReplay,
  mismatchVerdictOf,
  REPLAY_KEEP_DAYS,
  REPLAY_NO_PROOF_HOURS,
  REPLAY_OUTCOMES,
  REPLAY_QUEUE_NAME,
  REPLAY_TOP_PLACE,
  replayResultSchema,
  sampleRoll,
  strictestVerdict,
  type ReplayFacts,
} from "../src/modules/runs/run-replay-rules.js";

/**
 * Перепроверка забегов повтором (tasks/T-0319, docs/35-stage4-plan.md WP5):
 * кому повтор обязателен, выборка остальных, что делает исход с вердиктом.
 * Правила чистые — без базы, очереди и часов.
 */

/** Рейтинговый забег без последствий: ни верха, ни дивизиона, ни добычи, ни Стража. */
const ORDINARY: ReplayFacts = {
  mode: "endless",
  cheats: false,
  verdict: "ok",
  ranked: true,
  boardPlace: null,
  seasonPlace: null,
  seasonDivision: null,
  lootRarity: null,
  rubezhCleared: false,
};

const facts = (patch: Partial<ReplayFacts>): ReplayFacts => ({ ...ORDINARY, ...patch });
const runId = (index: number): string => `run-${String(index).padStart(8, "0")}-aaaa-bbbb-cccc-000000000000`;

describe("кому повтор обязателен", () => {
  it("87-е место общей доски — обязателен", () => {
    expect(decideReplay(runId(1), facts({ boardPlace: 87 }), 0)).toEqual({ need: "required", reasons: ["top_board"] });
  });

  it("граница первой сотни: 100-е место — обязателен, 101-е — нет", () => {
    expect(REPLAY_TOP_PLACE).toBe(100);
    expect(decideReplay(runId(1), facts({ boardPlace: 100 }), 0).need).toBe("required");
    expect(decideReplay(runId(1), facts({ boardPlace: 101 }), 0).need).toBe("none");
    expect(decideReplay(runId(1), facts({ boardPlace: 1 }), 0).need).toBe("required");
  });

  it("место нуль, дробь и отрицательное — не место: обязательности нет", () => {
    for (const place of [0, -3, 1.5, Number.NaN]) expect(decideReplay(runId(1), facts({ boardPlace: place }), 0).need).toBe("none");
  });

  it("первая сотня сезонной доски — обязателен", () => {
    expect(decideReplay(runId(1), facts({ seasonPlace: 100 }), 0)).toEqual({ need: "required", reasons: ["top_season"] });
    expect(decideReplay(runId(1), facts({ seasonPlace: 101 }), 0).need).toBe("none");
  });

  it("дивизион «рубин» и «золото» — обязателен, «серебро» и «бронза» — нет", () => {
    expect(decideReplay(runId(1), facts({ seasonDivision: "ruby" }), 0)).toEqual({ need: "required", reasons: ["division"] });
    expect(decideReplay(runId(1), facts({ seasonDivision: "gold" }), 0)).toEqual({ need: "required", reasons: ["division"] });
    expect(decideReplay(runId(1), facts({ seasonDivision: "silver" }), 0).need).toBe("none");
    expect(decideReplay(runId(1), facts({ seasonDivision: "bronze" }), 0).need).toBe("none");
  });

  it("эпическая добыча и выше — обязателен, редкая — нет", () => {
    expect(decideReplay(runId(1), facts({ lootRarity: "epic" }), 0)).toEqual({ need: "required", reasons: ["loot"] });
    expect(decideReplay(runId(1), facts({ lootRarity: "legendary" }), 0).need).toBe("required");
    expect(decideReplay(runId(1), facts({ lootRarity: "mythic" }), 0).need).toBe("required");
    expect(decideReplay(runId(1), facts({ lootRarity: "rare" }), 0).need).toBe("none");
    expect(decideReplay(runId(1), facts({ lootRarity: "common" }), 0).need).toBe("none");
    expect(lootNeedsReplay(null)).toBe(false);
    expect(lootNeedsReplay("epic")).toBe(true);
    expect(lootNeedsReplay("uncommon")).toBe(false);
  });

  it("победа над Стражем рубежа — обязателен", () => {
    expect(decideReplay(runId(1), facts({ rubezhCleared: true }), 0)).toEqual({ need: "required", reasons: ["rubezh"] });
  });

  it("несколько причин сразу — все в списке, по порядку правил", () => {
    const decision = decideReplay(runId(1), facts({ rubezhCleared: true, lootRarity: "epic", boardPlace: 3, seasonPlace: 2, seasonDivision: "ruby" }), 0);
    expect(decision).toEqual({ need: "required", reasons: ["rubezh", "loot", "top_board", "top_season", "division"] });
  });

  it("верх и дивизион — только у забега в рейтинге: забег не в рейтинге их не получает, Страж и добыча — получают", () => {
    expect(decideReplay(runId(1), facts({ ranked: false, boardPlace: 5, seasonPlace: 5, seasonDivision: "ruby" }), 1).need).toBe("none");
    expect(decideReplay(runId(1), facts({ ranked: false, rubezhCleared: true }), 0).need).toBe("required");
    expect(decideReplay(runId(1), facts({ ranked: false, lootRarity: "epic" }), 0).need).toBe("required");
  });

  it("пролог — не нужен ни при каком месте и добыче: его награда разовая и малая", () => {
    const loud = facts({ mode: "prologue", boardPlace: 1, seasonPlace: 1, seasonDivision: "ruby", lootRarity: "legendary", rubezhCleared: true });
    expect(decideReplay(runId(1), loud, 1).need).toBe("none");
  });

  it("забег с читами и забег не с вердиктом «ok» — не нужен: рейтинга и наград у него и так нет", () => {
    expect(decideReplay(runId(1), facts({ cheats: true, boardPlace: 1 }), 1).need).toBe("none");
    expect(decideReplay(runId(1), facts({ verdict: "suspicious", boardPlace: 1 }), 1).need).toBe("none");
    expect(decideReplay(runId(1), facts({ verdict: "rejected", rubezhCleared: true }), 1).need).toBe("none");
  });
});

describe("выборка остальных", () => {
  it("обычный забег — выборка: решение на одном runId одно и то же, сколько ни спрашивай", () => {
    const id = runId(42);
    const first = decideReplay(id, ORDINARY, 0.05);
    for (let attempt = 0; attempt < 20; attempt += 1) expect(decideReplay(id, ORDINARY, 0.05)).toEqual(first);
    expect(sampleRoll(id)).toBe(sampleRoll(id));
  });

  it("бросок — число от 0 до 1, у разных забегов разный", () => {
    const rolls = Array.from({ length: 200 }, (_, index) => sampleRoll(runId(index)));
    for (const roll of rolls) {
      expect(roll).toBeGreaterThanOrEqual(0);
      expect(roll).toBeLessThan(1);
    }
    expect(new Set(rolls).size).toBeGreaterThan(190);
  });

  it("доля выборки близка к ключу: 5 % из десяти тысяч забегов — от 4 до 6 %", () => {
    let sampled = 0;
    for (let index = 0; index < 10_000; index += 1) if (decideReplay(runId(index), ORDINARY, 0.05).need === "sample") sampled += 1;
    expect(sampled).toBeGreaterThan(400);
    expect(sampled).toBeLessThan(600);
  });

  it("доля 0 — никого, доля 1 — всех; больше единицы и меньше нуля не ломают", () => {
    expect(decideReplay(runId(7), ORDINARY, 0).need).toBe("none");
    expect(decideReplay(runId(7), ORDINARY, 1).need).toBe("sample");
    expect(decideReplay(runId(7), ORDINARY, 5).need).toBe("sample");
    expect(decideReplay(runId(7), ORDINARY, -1).need).toBe("none");
  });

  it("выборка касается только рейтинговых забегов", () => {
    expect(decideReplay(runId(7), facts({ ranked: false }), 1).need).toBe("none");
  });

  it("обязательный забег в выборку не попадает: причина названа, а не «выборка»", () => {
    expect(decideReplay(runId(7), facts({ boardPlace: 10 }), 1)).toEqual({ need: "required", reasons: ["top_board"] });
  });
});

describe("что исход делает с забегом", () => {
  const input = { verdict: "ok" as const, required: true, mismatchVerdict: "suspicious" as const };

  it("совпал — вердикт не меняется; обязательный забег хранит запись полгода, выборочный — как прежде", () => {
    expect(effectOf("match", input)).toEqual({ replayVerdict: "match", verdict: null, reason: null, unrank: false, keepProofDays: REPLAY_KEEP_DAYS, ourSide: false });
    expect(effectOf("match", { ...input, required: false }).keepProofDays).toBeNull();
    expect(REPLAY_KEEP_DAYS).toBe(180);
  });

  it("разошёлся — подозрение, причина replay_mismatch, из рейтинга ушёл, запись хранится полгода", () => {
    expect(effectOf("mismatch", input)).toEqual({ replayVerdict: "mismatch", verdict: "suspicious", reason: "replay_mismatch", unrank: true, keepProofDays: REPLAY_KEEP_DAYS, ourSide: false });
    // Выборочный забег расходится так же: запись нужна для разбора и для замера движков.
    expect(effectOf("mismatch", { ...input, required: false }).keepProofDays).toBe(REPLAY_KEEP_DAYS);
  });

  it("ключ «rejected» — отказ", () => {
    expect(effectOf("mismatch", { ...input, mismatchVerdict: "rejected" }).verdict).toBe("rejected");
  });

  it("отказ раньше не смягчается подозрением: вердикт только строже", () => {
    expect(effectOf("mismatch", { ...input, verdict: "rejected", mismatchVerdict: "suspicious" }).verdict).toBe("rejected");
    expect(effectOf("mismatch", { ...input, verdict: "suspicious", mismatchVerdict: "suspicious" }).verdict).toBe("suspicious");
    expect(effectOf("mismatch", { ...input, verdict: null, mismatchVerdict: "suspicious" }).verdict).toBe("suspicious");
    expect(strictestVerdict("ok", "rejected")).toBe("rejected");
    expect(strictestVerdict("rejected", "suspicious")).toBe("rejected");
    expect(strictestVerdict(null, "suspicious")).toBe("suspicious");
  });

  it("content_mismatch, broken, timeout — наша сторона: вердикт и рейтинг не трогаются", () => {
    for (const outcome of ["content_mismatch", "broken", "timeout"] as const) {
      expect(effectOf(outcome, input)).toEqual({ replayVerdict: outcome, verdict: null, reason: null, unrank: false, keepProofDays: null, ourSide: true });
    }
  });

  it("not_replayable и no_proof — вердикт не меняется; последствия для наград — T-0320", () => {
    for (const outcome of ["not_replayable", "no_proof"] as const) {
      expect(effectOf(outcome, input)).toEqual({ replayVerdict: outcome, verdict: null, reason: null, unrank: false, keepProofDays: null, ourSide: false });
    }
  });

  it("ключ вердикта: «rejected» — отказ, всё остальное и пустое — подозрение", () => {
    expect(mismatchVerdictOf("rejected")).toBe("rejected");
    expect(mismatchVerdictOf("suspicious")).toBe("suspicious");
    expect(mismatchVerdictOf("")).toBe("suspicious");
    expect(mismatchVerdictOf("banned")).toBe("suspicious");
  });

  it("исходов семь, и «ожидает» среди них нет", () => {
    expect([...REPLAY_OUTCOMES]).toEqual(["match", "mismatch", "content_mismatch", "not_replayable", "broken", "timeout", "no_proof"]);
    expect(REPLAY_NO_PROOF_HOURS).toBe(72);
  });
});

describe("исход воркера из Redis", () => {
  const good = { runId: "r1", verdict: "match", reason: null, divergedTick: null, replayed: { ticks: 3600, survivalSec: 60, level: 3, enemiesKilled: 40, checksum: 99 }, durationMs: 812 };

  it("разбирается по форме воркера", () => {
    expect(replayResultSchema.parse(good)).toMatchObject({ runId: "r1", verdict: "match", durationMs: 812 });
    expect(replayResultSchema.parse({ ...good, verdict: "mismatch", divergedTick: 1800, reason: "свёртка минуты разошлась" })).toMatchObject({ divergedTick: 1800 });
    expect(replayResultSchema.parse({ ...good, verdict: "broken", replayed: null, reason: "запись не по схеме" })).toMatchObject({ replayed: null });
  });

  it("мусор не проходит: незнакомый вердикт, тик дробью, пустой идентификатор, не объект", () => {
    expect(replayResultSchema.safeParse({ ...good, verdict: "banned" }).success).toBe(false);
    expect(replayResultSchema.safeParse({ ...good, verdict: "pending" }).success).toBe(false);
    expect(replayResultSchema.safeParse({ ...good, divergedTick: 1.5 }).success).toBe(false);
    expect(replayResultSchema.safeParse({ ...good, runId: "" }).success).toBe(false);
    expect(replayResultSchema.safeParse(null).success).toBe(false);
    expect(replayResultSchema.safeParse("match").success).toBe(false);
  });

  it("очередь и форма задания совпадают с воркером: сервер его кода не импортирует", () => {
    const source = readFileSync(new URL("../../../apps/sim-worker/src/replay-job.ts", import.meta.url), "utf8");
    expect(source).toContain(`REPLAY_QUEUE = "${REPLAY_QUEUE_NAME}"`);
    for (const key of ["runId", "proof", "contentSnapshot", "claimed"]) expect(source).toContain(`${key}:`);
    expect(source).toContain("z.strictObject({");
  });
});

describe("площадка клиента для метрики", () => {
  it("iOS и Android — по ОС, где бы ни открылась игра: движок у браузера на iPhone тот же", () => {
    expect(clientOsOf({ os: "ios", deviceClass: "mobile" })).toBe("ios");
    expect(clientOsOf({ os: "ios", deviceClass: "web" })).toBe("ios");
    expect(clientOsOf({ os: "android", deviceClass: "mobile" })).toBe("android");
  });

  it("веб и компьютер — по классу устройства", () => {
    expect(clientOsOf({ os: "windows", deviceClass: "web" })).toBe("web");
    expect(clientOsOf({ os: "macos", deviceClass: "desktop" })).toBe("desktop");
    expect(clientOsOf({ os: "linux", deviceClass: "desktop" })).toBe("desktop");
  });

  it("неизвестное — отдельное значение, а не подмена веба", () => {
    expect(clientOsOf(null)).toBe("unknown");
    expect(clientOsOf({ os: "unknown", deviceClass: "unknown" })).toBe("unknown");
    expect(clientOsOf({ os: "plan9", deviceClass: "kiosk" })).toBe("unknown");
  });
});

describe("постановка в очередь", () => {
  it("приоритет: обязательные и решение модератора — выше выборки (у BullMQ меньше число — раньше)", () => {
    expect(jobPriorityOf({ required: true, byModerator: false })).toBeLessThan(jobPriorityOf({ required: false, byModerator: false }));
    expect(jobPriorityOf({ required: false, byModerator: true })).toBe(jobPriorityOf({ required: true, byModerator: false }));
  });

  it("идентификатор задания — забег и попытка, без двоеточия: BullMQ его не принимает; по нему же читается попытка", () => {
    const id = jobIdOf("0f8fad5b-d9cb-469f-a165-70867728950e", 0);
    expect(id).toBe("replay-0f8fad5b-d9cb-469f-a165-70867728950e-0");
    expect(id).not.toContain(":");
    expect(jobIdOf("x", 1)).not.toBe(jobIdOf("x", 0));
    expect(parseJobId(id)).toEqual({ runId: "0f8fad5b-d9cb-469f-a165-70867728950e", attempt: 0 });
    expect(parseJobId(jobIdOf("run-with-dashes-1", 12))).toEqual({ runId: "run-with-dashes-1", attempt: 12 });
  });

  it("чужой идентификатор не разбирается: без приставки, без попытки, дробная и нечисловая попытка", () => {
    for (const id of ["content-check-1", "replay-run", "replay--1", "replay-run-1.5", "replay-run-x", "", "replay-"]) expect(parseJobId(id)).toBeNull();
  });
});
