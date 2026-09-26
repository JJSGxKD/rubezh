import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { judgeRun, trustedStartMs, type VerdictInput } from "../src/modules/runs/run-verdict.js";

/**
 * Антифрод забега, фаза 1 (docs/34-stage3-plan.md, WP4). Каждое правило — на
 * границе: ровно на пороге честно, чуть выше — нет. Порог, срабатывающий на
 * честном игроке, хуже отсутствующего — он учит команду не верить вердикту.
 */

const limits = loadAppConfig({
  NODE_ENV: "test",
  RUNS_MAX_KILLS_PER_SEC: "10",
  RUNS_MAX_LEVELS_PER_MIN: "5",
  RUNS_WALL_CLOCK_TOLERANCE_SEC: "10",
  RUNS_START_MAX_DELAY_SEC: "30",
} as NodeJS.ProcessEnv).runs;

const START = 1_000_000;

function run(patch: Partial<VerdictInput> = {}): VerdictInput {
  return {
    survivalSec: 300,
    level: 10,
    enemiesKilled: 1000,
    weaponCount: 3,
    contentHash: "abc",
    startedAtMs: START,
    finishedAtMs: START + 310_000,
    continues: 0,
    paidContinues: 0,
    underpaidContinues: false,
    cheats: false,
    loadout: "none",
    ...patch,
  };
}

describe("вердикт забега", () => {
  it("честный забег проходит без замечаний", () => {
    expect(judgeRun(run(), limits)).toEqual({ verdict: "ok", reasons: [] });
  });

  it("оружий больше, чем слотов, — отказ: честный клиент так не пришлёт", () => {
    expect(judgeRun(run({ weaponCount: 4 }), limits)).toMatchObject({ verdict: "rejected", reasons: ["weapons_over_slots"] });
    expect(judgeRun(run({ weaponCount: 3 }), limits).verdict).toBe("ok");
  });

  it("забег длиннее, чем прошло по часам сервера, — отказ", () => {
    // Пауза в игровое время не идёт, поэтому честный забег всегда короче.
    const tooLong = run({ survivalSec: 400, finishedAtMs: START + 300_000 });

    expect(judgeRun(tooLong, limits)).toMatchObject({ verdict: "rejected", reasons: ["longer_than_wall_clock"] });
  });

  it("запас на время работает ровно до своей границы", () => {
    const wall = 300;
    expect(judgeRun(run({ survivalSec: wall + 10, finishedAtMs: START + wall * 1000 }), limits).verdict).toBe("ok");
    expect(judgeRun(run({ survivalSec: wall + 11, finishedAtMs: START + wall * 1000 }), limits).verdict).toBe("rejected");
  });

  it("долгая пауза честна: игровое время меньше прошедшего", () => {
    // Минута игры за час по часам: игрок стоял на паузе. Числа — под минуту.
    expect(judgeRun(run({ survivalSec: 60, level: 4, enemiesKilled: 300, finishedAtMs: START + 3_600_000 }), limits).verdict).toBe("ok");
  });

  it("без времени старта не отказывает, а честно говорит, что не проверил", () => {
    // Старт мог не дойти — сеть. Отказать за это значит наказать честного;
    // вердикт остаётся «ok», а причина записывается сведением.
    expect(judgeRun(run({ startedAtMs: null, survivalSec: 99_999 }), limits)).toEqual({
      verdict: "ok",
      reasons: ["unverified_time"],
    });
  });

  it("убивает быстрее порога — подозрение, а не отказ", () => {
    expect(judgeRun(run({ enemiesKilled: 3000, survivalSec: 300 }), limits)).toMatchObject({ verdict: "ok" });
    expect(judgeRun(run({ enemiesKilled: 3001, survivalSec: 300 }), limits)).toMatchObject({ verdict: "suspicious", reasons: ["kill_rate"] });
  });

  it("качается быстрее порога — подозрение", () => {
    expect(judgeRun(run({ level: 26, survivalSec: 300 }), limits)).toMatchObject({ verdict: "suspicious", reasons: ["level_rate"] });
  });

  it("короткий забег не выглядит невозможным: уровни считаются не короче минуты", () => {
    // Первые уровни приходят за полминуты — три уровня за двадцать секунд
    // это обычное начало, а не 9 уровней в минуту.
    expect(judgeRun(run({ level: 3, survivalSec: 20, enemiesKilled: 30, finishedAtMs: START + 25_000 }), limits).verdict).toBe("ok");
  });

  it("незнакомая сборка — подозрение, если список сборок задан", () => {
    const withHashes = { ...limits, knownContentHashes: new Set(["release-1"]) };

    expect(judgeRun(run({ contentHash: "release-1" }), withHashes).verdict).toBe("ok");
    expect(judgeRun(run({ contentHash: "самосбор" }), withHashes)).toMatchObject({ verdict: "suspicious", reasons: ["unknown_content"] });
  });

  it("пустой список сборок не делает все забеги чужими", () => {
    expect(judgeRun(run({ contentHash: "что угодно" }), limits).verdict).toBe("ok");
  });

  it("отказ сильнее подозрения, и причины сохраняются все", () => {
    const both = judgeRun(run({ weaponCount: 5, enemiesKilled: 99_999 }), limits);

    expect(both.verdict).toBe("rejected");
    expect(both.reasons).toEqual(expect.arrayContaining(["weapons_over_slots", "kill_rate"]));
  });
});

describe("время начала, которому можно верить", () => {
  it("вычитает, сколько забега прошло к отправке старта", () => {
    expect(trustedStartMs(100_000, 5, 30)).toBe(95_000);
  });

  it("старту, пролежавшему в очереди дольше предела, не верит", () => {
    // Заявленное «прошло много» иначе подарило бы запас читеру.
    expect(trustedStartMs(100_000, 31, 30)).toBeNull();
    expect(trustedStartMs(100_000, 30, 30)).toBe(70_000);
  });
});

describe("второй шанс в вердикте", () => {
  it("продолжение без оплаты — отказ: честный клиент продолжает только после подтверждения сервером", () => {
    expect(judgeRun(run({ continues: 1, paidContinues: 0 }), limits)).toEqual({ verdict: "rejected", reasons: ["unpaid_continue"] });
    expect(judgeRun(run({ continues: 1, paidContinues: 1 }), limits)).toEqual({ verdict: "ok", reasons: [] });
  });

  it("бесплатное продолжение забега разработчика — чит, а не отказ", () => {
    expect(judgeRun(run({ continues: 1, paidContinues: 0, cheats: true }), limits).reasons).not.toContain("unpaid_continue");
  });

  it("продолжение, оплаченное за меньшее время, — подозрение, а не отказ", () => {
    expect(judgeRun(run({ continues: 1, paidContinues: 1, underpaidContinues: true }), limits)).toEqual({
      verdict: "suspicious",
      reasons: ["underpaid_continue"],
    });
  });
});

describe("снаряжение в вердикте", () => {
  it("снимок, которого сервер не подписывал, — отказ; устаревший — подозрение; настоящий — обычный забег", () => {
    expect(judgeRun(run({ loadout: "forged" }), limits)).toEqual({ verdict: "rejected", reasons: ["loadout_forged"] });
    expect(judgeRun(run({ loadout: "stale" }), limits)).toEqual({ verdict: "suspicious", reasons: ["loadout_stale"] });
    expect(judgeRun(run({ loadout: "valid" }), limits)).toEqual({ verdict: "ok", reasons: [] });
    expect(judgeRun(run({ loadout: "none" }), limits)).toEqual({ verdict: "ok", reasons: [] });
  });
});
