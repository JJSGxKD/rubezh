import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { judgeRun, MODIFIER_UNLOCK_LEVEL, MODIFIER_VERDICT_MUL, RUN_MODIFIER_IDS, trustedStartMs, unlockedModifiers, type VerdictInput } from "../src/modules/runs/run-verdict.js";

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
    boosts: "none",
    counters: null,
    ...patch,
  };
}

describe("вердикт забега", () => {
  it("честный забег проходит без замечаний", () => {
    expect(judgeRun(run(), limits)).toEqual({ verdict: "ok", reasons: [] });
  });

  it("оружий больше, чем слотов, — отказ: честный клиент так не пришлёт", () => {
    expect(judgeRun(run({ weaponCount: 5 }), limits)).toMatchObject({ verdict: "rejected", reasons: ["weapons_over_slots"] });
    expect(judgeRun(run({ weaponCount: 4 }), limits).verdict).toBe("ok");
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

describe("рекламный переброс в вердикте (tasks/T-0199)", () => {
  it("заявлен без записи показа — отказ с нейтральной причиной unpaid_ad_reroll", () => {
    expect(judgeRun(run({ adRerolls: 1, paidAdRerolls: 0 }), limits)).toEqual({ verdict: "rejected", reasons: ["unpaid_ad_reroll"] });
  });

  it("заявлен и записан, не заявлен вовсе, поля нет — честный забег", () => {
    expect(judgeRun(run({ adRerolls: 1, paidAdRerolls: 1 }), limits)).toEqual({ verdict: "ok", reasons: [] });
    expect(judgeRun(run({ adRerolls: 0, paidAdRerolls: 0 }), limits)).toEqual({ verdict: "ok", reasons: [] });
    expect(judgeRun(run(), limits)).toEqual({ verdict: "ok", reasons: [] });
  });

  it("забег с читами разработчика этой причиной не отклоняется, как и неоплаченное продолжение", () => {
    expect(judgeRun(run({ adRerolls: 1, paidAdRerolls: 0, cheats: true }), limits).reasons).not.toContain("unpaid_ad_reroll");
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

  it("снимок с уровнем выше уровня аккаунта — отказ: открытое по нему игроку не положено", () => {
    expect(judgeRun(run({ loadout: "level_ahead" }), limits)).toEqual({ verdict: "rejected", reasons: ["loadout_level_ahead"] });
  });

  it("буст, не купленный на забег, — отказ: без оплаты честный клиент его не применит", () => {
    expect(judgeRun(run({ boosts: "unpaid" }), limits)).toEqual({ verdict: "rejected", reasons: ["boost_unpaid"] });
    expect(judgeRun(run({ boosts: "paid" }), limits)).toEqual({ verdict: "ok", reasons: [] });
  });
});

describe("счётчики в вердикте (tasks/T-0125)", () => {
  const plausible = { bossKills: 0, eliteKills: 1, chestsOpened: 1, rareChests: 0, crystals: 100, noHitSec: 0, noKillSec: 0, killsByElement: {} };
  const implausible = { bossKills: 50, eliteKills: 0, chestsOpened: 0, rareChests: 0, crystals: 0, noHitSec: 0, noKillSec: 0, killsByElement: {} };

  it("правдоподобные счётчики и забег без них — без замечаний", () => {
    expect(judgeRun(run({ counters: plausible }), limits)).toEqual({ verdict: "ok", reasons: [] });
    expect(judgeRun(run({ counters: null }), limits)).toEqual({ verdict: "ok", reasons: [] });
  });

  it("неправдоподобные дают причину, но вердикт остаётся прежним", () => {
    expect(judgeRun(run({ counters: implausible }), limits)).toEqual({ verdict: "ok", reasons: ["counters_implausible"] });
  });

  it("причина не делает подозрительный забег отказным и не лечит отказной", () => {
    const suspicious = judgeRun(run({ enemiesKilled: 3001, counters: implausible }), limits);
    expect(suspicious.verdict).toBe("suspicious");
    expect(suspicious.reasons).toEqual(expect.arrayContaining(["kill_rate", "counters_implausible"]));

    const rejected = judgeRun(run({ weaponCount: 5, counters: implausible }), limits);
    expect(rejected.verdict).toBe("rejected");
  });

  it("счётчики сверяются с убитыми и временем самого забега", () => {
    const counters = { bossKills: 1, eliteKills: 0, chestsOpened: 0, rareChests: 0, crystals: 0, noHitSec: 0, noKillSec: 0, killsByElement: {} };
    const long = { survivalSec: 600, finishedAtMs: START + 700_000 };
    expect(judgeRun(run({ counters, enemiesKilled: 0, ...long }), limits).reasons).toContain("counters_implausible");
    expect(judgeRun(run({ counters, enemiesKilled: 10, ...long }), limits).reasons).not.toContain("counters_implausible");
  });
});

describe("победа над стражем рубежа (T-0121)", () => {
  const long = { survivalSec: 700, finishedAtMs: START + 710_000 };
  const claim = (reached: boolean, clearedSec: number | null) => ({ reached, clearedSec, guardHpPercent: null });

  it("победа на 650 с при 700 с выживания — без замечаний; без поля rubezh — как раньше", () => {
    expect(judgeRun(run({ ...long, rubezh: claim(true, 650) }), limits)).toEqual({ verdict: "ok", reasons: [] });
    expect(judgeRun(run({ ...long, rubezh: null }), limits)).toEqual({ verdict: "ok", reasons: [] });
    expect(judgeRun(run({ ...long }), limits)).toEqual({ verdict: "ok", reasons: [] });
  });

  it("страж пришёл, но жив, — не замечание", () => {
    expect(judgeRun(run({ ...long, rubezh: claim(true, null) }), limits)).toEqual({ verdict: "ok", reasons: [] });
    expect(judgeRun(run({ ...long, rubezh: claim(false, null) }), limits)).toEqual({ verdict: "ok", reasons: [] });
  });

  it("победа раньше, чем страж мог пасть, — подозрение; ровно на границе честно", () => {
    expect(judgeRun(run({ ...long, rubezh: claim(true, 599) }), limits)).toEqual({ verdict: "suspicious", reasons: ["rubezh_implausible"] });
    expect(judgeRun(run({ ...long, rubezh: claim(true, 604) }), limits).verdict).toBe("suspicious");
    expect(judgeRun(run({ ...long, rubezh: claim(true, 605) }), limits).verdict).toBe("ok");
  });

  it("победа позже конца забега — подозрение; допуск в секунду", () => {
    expect(judgeRun(run({ ...long, rubezh: claim(true, 701) }), limits).verdict).toBe("ok");
    expect(judgeRun(run({ ...long, rubezh: claim(true, 702) }), limits)).toEqual({ verdict: "suspicious", reasons: ["rubezh_implausible"] });
  });

  it("победа при reached: false — подозрение", () => {
    expect(judgeRun(run({ ...long, rubezh: claim(false, 650) }), limits)).toEqual({ verdict: "suspicious", reasons: ["rubezh_implausible"] });
  });

  it("страж пришёл при выживании короче отметки — подозрение; допуск в секунду", () => {
    const short = { survivalSec: 598, finishedAtMs: START + 610_000 };
    expect(judgeRun(run({ ...short, rubezh: claim(true, null) }), limits)).toEqual({ verdict: "suspicious", reasons: ["rubezh_implausible"] });
    expect(judgeRun(run({ survivalSec: 599, finishedAtMs: START + 610_000, rubezh: claim(true, null) }), limits).verdict).toBe("ok");
  });

  it("причина не лечит отказной забег", () => {
    expect(judgeRun(run({ ...long, weaponCount: 5, rubezh: claim(true, 599) }), limits).verdict).toBe("rejected");
  });
});

describe("модификатор забега в вердикте (tasks/T-0122)", () => {
  const BOTH = ["hurry", "inverse"] as const;

  it("закрытый на сервере модификатор — отказ: честный клиент неоткрытого не выберет", () => {
    expect(judgeRun(run({ modifierId: "hurry", unlockedModifiers: [], startModifierId: "hurry" }), limits)).toEqual({ verdict: "rejected", reasons: ["modifier_locked"] });
    // «Спешка» открыта, «Инверсия» — нет: смотрится именно заявленный.
    expect(judgeRun(run({ modifierId: "inverse", unlockedModifiers: ["hurry"] }), limits)).toEqual({ verdict: "rejected", reasons: ["modifier_locked"] });
  });

  it("список открытых не передан — заявленный модификатор закрыт: молчание не открывает", () => {
    expect(judgeRun(run({ modifierId: "hurry" }), limits)).toMatchObject({ verdict: "rejected", reasons: ["modifier_locked"] });
  });

  it("открытый модификатор, совпавший со стартом, — честный забег", () => {
    expect(judgeRun(run({ modifierId: "hurry", unlockedModifiers: BOTH, startModifierId: "hurry" }), limits)).toEqual({ verdict: "ok", reasons: [] });
    expect(judgeRun(run({ modifierId: "inverse", unlockedModifiers: BOTH, startModifierId: "inverse" }), limits)).toEqual({ verdict: "ok", reasons: [] });
  });

  it("старт назвал одно, итог другое — подозрение: забег сохранён, множителя не будет", () => {
    expect(judgeRun(run({ modifierId: "inverse", unlockedModifiers: BOTH, startModifierId: "hurry" }), limits)).toEqual({ verdict: "suspicious", reasons: ["modifier_mismatch"] });
  });

  it("старт без модификатора, а итог с ним — и наоборот — тоже расхождение", () => {
    expect(judgeRun(run({ modifierId: "hurry", unlockedModifiers: BOTH, startModifierId: null }), limits)).toEqual({ verdict: "suspicious", reasons: ["modifier_mismatch"] });
    expect(judgeRun(run({ modifierId: null, unlockedModifiers: BOTH, startModifierId: "hurry" }), limits)).toEqual({ verdict: "suspicious", reasons: ["modifier_mismatch"] });
  });

  it("старт не дошёл — не причина, как unverified_time", () => {
    expect(judgeRun(run({ modifierId: "hurry", unlockedModifiers: BOTH }), limits)).toEqual({ verdict: "ok", reasons: [] });
    expect(judgeRun(run({ modifierId: "hurry", unlockedModifiers: BOTH, startModifierId: undefined, startedAtMs: null }), limits)).toEqual({ verdict: "ok", reasons: ["unverified_time"] });
  });

  it("забег без модификатора ни старта, ни итога причин не получает", () => {
    expect(judgeRun(run({ modifierId: null, startModifierId: null }), limits)).toEqual({ verdict: "ok", reasons: [] });
    expect(judgeRun(run(), limits)).toEqual({ verdict: "ok", reasons: [] });
  });

  it("закрытый и расходящийся одновременно — отказ сильнее, обе причины остаются", () => {
    const verdict = judgeRun(run({ modifierId: "inverse", unlockedModifiers: [], startModifierId: "hurry" }), limits);
    expect(verdict.verdict).toBe("rejected");
    expect(verdict.reasons).toEqual(expect.arrayContaining(["modifier_locked", "modifier_mismatch"]));
  });

  describe("пределы убийств и уровней шире на таблицу модификатора", () => {
    const hurry = (patch: Partial<VerdictInput>) => run({ modifierId: "hurry", unlockedModifiers: BOTH, startModifierId: "hurry", ...patch });
    const inverse = (patch: Partial<VerdictInput>) => run({ modifierId: "inverse", unlockedModifiers: BOTH, startModifierId: "inverse", ...patch });

    it("«Спешка»: убийства ×1,5 — ровно на пределе честно, чуть выше — подозрение", () => {
      // База 10 убийств в секунду, на «Спешке» 15: за 300 секунд 4500.
      expect(judgeRun(hurry({ enemiesKilled: 4500 }), limits)).toEqual({ verdict: "ok", reasons: [] });
      expect(judgeRun(hurry({ enemiesKilled: 4501 }), limits)).toMatchObject({ verdict: "suspicious", reasons: ["kill_rate"] });
      // Тот же забег без модификатора уезжает в подозрение уже на 3001.
      expect(judgeRun(run({ enemiesKilled: 4500 }), limits)).toMatchObject({ verdict: "suspicious", reasons: ["kill_rate"] });
    });

    it("«Спешка»: уровни ×1,6 — 5 уровней в минуту становятся 8", () => {
      expect(judgeRun(hurry({ level: 40 }), limits)).toEqual({ verdict: "ok", reasons: [] });
      expect(judgeRun(hurry({ level: 41 }), limits)).toMatchObject({ verdict: "suspicious", reasons: ["level_rate"] });
      expect(judgeRun(run({ level: 40 }), limits)).toMatchObject({ verdict: "suspicious", reasons: ["level_rate"] });
    });

    it("«Инверсия»: убийства ×1,0 — предел прежний, уровни ×1,6", () => {
      expect(judgeRun(inverse({ enemiesKilled: 3000 }), limits)).toEqual({ verdict: "ok", reasons: [] });
      expect(judgeRun(inverse({ enemiesKilled: 3001 }), limits)).toMatchObject({ verdict: "suspicious", reasons: ["kill_rate"] });
      expect(judgeRun(inverse({ level: 40 }), limits)).toEqual({ verdict: "ok", reasons: [] });
      expect(judgeRun(inverse({ level: 41 }), limits)).toMatchObject({ verdict: "suspicious", reasons: ["level_rate"] });
    });

    it("расширение не открывает чужое: закрытый модификатор остаётся отказом, а не «окей»", () => {
      expect(judgeRun(run({ modifierId: "hurry", unlockedModifiers: [], enemiesKilled: 4500 }), limits).verdict).toBe("rejected");
    });
  });

  it("лестница открытия: «Спешка» с 9-го уровня, «Инверсия» с 12-го", () => {
    expect(MODIFIER_UNLOCK_LEVEL).toEqual({ hurry: 9, inverse: 12 });
    expect(unlockedModifiers(1)).toEqual([]);
    expect(unlockedModifiers(8)).toEqual([]);
    expect(unlockedModifiers(9)).toEqual(["hurry"]);
    expect(unlockedModifiers(11)).toEqual(["hurry"]);
    expect(unlockedModifiers(12)).toEqual(["hurry", "inverse"]);
    expect(unlockedModifiers(100)).toEqual(["hurry", "inverse"]);
  });

  it("таблицы полны: у каждого модификатора есть предел вердикта и уровень открытия", () => {
    for (const id of RUN_MODIFIER_IDS) {
      expect(MODIFIER_VERDICT_MUL[id], `нет предела вердикта для ${id}: поправьте MODIFIER_VERDICT_MUL в run-verdict.ts`).toBeDefined();
      expect(MODIFIER_VERDICT_MUL[id].kills).toBeGreaterThanOrEqual(1);
      expect(MODIFIER_VERDICT_MUL[id].levels).toBeGreaterThanOrEqual(1);
      expect(MODIFIER_UNLOCK_LEVEL[id], `нет уровня открытия для ${id}`).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(MODIFIER_VERDICT_MUL).sort()).toEqual([...RUN_MODIFIER_IDS].sort());
    expect(MODIFIER_VERDICT_MUL).toEqual({ hurry: { kills: 1.5, levels: 1.6 }, inverse: { kills: 1, levels: 1.6 } });
  });
});
