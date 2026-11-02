import { describe, expect, it } from "vitest";
import "../src/i18n/season";
import {
  formatSeasonLeft,
  ladderRows,
  pendingTotal,
  seasonDateLabel,
  seasonLeftAt,
  seasonRangeLabel,
  thresholdProgress,
} from "../src/screens/meta/rating-rules";

// Правила экрана недельного сезона (tasks/T-0111): время до конца, даты в UTC,
// прогресс порога, лестница наград с множителем сложности и сумма к забору.
// Числа клиент не выдумывает: он только умножает и округляет, как сервер.

const DAY = 86_400;

describe("formatSeasonLeft: сколько осталось до конца сезона", () => {
  it("от суток — дни и часы", () => {
    expect(formatSeasonLeft(3 * DAY + 4 * 3600)).toBe("3 д 4 ч");
  });

  it("ровно сутки — «1 д 0 ч»", () => {
    expect(formatSeasonLeft(DAY)).toBe("1 д 0 ч");
  });

  it("меньше суток — часы и минуты", () => {
    expect(formatSeasonLeft(5 * 3600 + 20 * 60)).toBe("5 ч 20 мин");
  });

  it("меньше часа — минуты", () => {
    expect(formatSeasonLeft(12 * 60)).toBe("12 мин");
  });

  it("меньше минуты — словами", () => {
    expect(formatSeasonLeft(30)).toBe("меньше минуты");
    expect(formatSeasonLeft(59.9)).toBe("меньше минуты");
  });

  it("время вышло — «Сезон закрывается…»", () => {
    expect(formatSeasonLeft(0)).toBe("Сезон закрывается…");
    expect(formatSeasonLeft(-5)).toBe("Сезон закрывается…");
  });

  it("не число (битый ответ) не показывается как NaN", () => {
    expect(formatSeasonLeft(Number.NaN)).toBe("Сезон закрывается…");
  });
});

describe("seasonLeftAt: время сервера плюс монотонные часы устройства", () => {
  it("вычитает прошедшее по монотонным часам, а не по часам телефона", () => {
    expect(seasonLeftAt(3600, 1_000, 61_000)).toBe(3540);
  });

  it("не уходит ниже нуля", () => {
    expect(seasonLeftAt(10, 0, 60_000)).toBe(0);
  });

  it("часы, пошедшие назад, не прибавляют времени", () => {
    expect(seasonLeftAt(100, 5_000, 1_000)).toBe(100);
  });
});

describe("seasonRangeLabel: даты сезона в UTC", () => {
  it("внутри месяца — «2–8 ноября»: последний день — воскресенье", () => {
    expect(seasonRangeLabel("2026-11-02T00:00:00Z", "2026-11-09T00:00:00Z")).toBe("2–8 ноября");
  });

  it("на стыке месяцев — оба месяца", () => {
    expect(seasonRangeLabel("2026-12-28T00:00:00Z", "2027-01-04T00:00:00Z")).toBe("28 декабря – 3 января");
  });

  it("часовой пояс устройства не двигает дату", () => {
    const before = process.env.TZ;
    try {
      for (const zone of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = zone;
        expect(seasonRangeLabel("2026-11-02T00:00:00Z", "2026-11-09T00:00:00Z")).toBe("2–8 ноября");
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("битая дата не роняет экран", () => {
    expect(seasonRangeLabel("не дата", "тоже")).toBe("");
  });
});

describe("seasonDateLabel: одна дата для «Первый сезон начнётся…»", () => {
  it("день и месяц в родительном падеже по UTC", () => {
    expect(seasonDateLabel("2026-11-02T00:00:00Z")).toBe("2 ноября");
    expect(seasonDateLabel("2026-11-01T23:59:59Z")).toBe("1 ноября");
  });
});

describe("thresholdProgress: порог недели", () => {
  it("игрока ещё не было — осталось всё", () => {
    expect(thresholdProgress(null, 180)).toEqual({ reached: false, leftSec: 180 });
  });

  it("на долю секунды меньше порога — не достигнут", () => {
    const progress = thresholdProgress(179.9, 180);
    expect(progress.reached).toBe(false);
    expect(progress.leftSec).toBeCloseTo(0.1, 5);
  });

  it("ровно порог — достигнут", () => {
    expect(thresholdProgress(180, 180)).toEqual({ reached: true, leftSec: 0 });
  });

  it("выше порога — достигнут, остатка нет", () => {
    expect(thresholdProgress(400, 180)).toEqual({ reached: true, leftSec: 0 });
  });
});

describe("ladderRows: лестница наград за места", () => {
  const LADDER = [
    { fromPlace: 1, toPlace: 1, coins: 1000, prestige: 100 },
    { fromPlace: 2, toPlace: 3, coins: 600, prestige: 50 },
    { fromPlace: 4, toPlace: 10, coins: 400, prestige: 25 },
    { fromPlace: 11, toPlace: 50, coins: 250, prestige: 10 },
  ];

  it("подписи мест склоняются: «1 место», «2–3 места», «4–10 мест», «11–50 мест»", () => {
    expect(ladderRows(LADDER, 1).map((row) => row.label)).toEqual(["1 место", "2–3 места", "4–10 мест", "11–50 мест"]);
  });

  it("множитель сложности 1.7 применяется к монетам и престижу", () => {
    const [first] = ladderRows(LADDER, 1.7);
    expect(first).toMatchObject({ coins: 1700, prestige: 170 });
  });

  it("округление — Math.round, как на сервере", () => {
    const rows = ladderRows(LADDER, 1.7);
    expect(rows[1]).toMatchObject({ coins: 1020, prestige: 85 });
    expect(rows[3]).toMatchObject({ coins: 425, prestige: 17 });
    expect(ladderRows([{ fromPlace: 1, toPlace: 1, coins: 5, prestige: 5 }], 1.3)[0]).toMatchObject({ coins: 7, prestige: 7 });
  });

  it("множитель 1 оставляет числа ступени как есть", () => {
    expect(ladderRows(LADDER, 1)[2]).toMatchObject({ coins: 400, prestige: 25 });
  });

  it("одиночное место склоняется по правилу «N мест»: 21 место, 22 места, 25 мест", () => {
    const label = (place: number): string => ladderRows([{ fromPlace: place, toPlace: place, coins: 1, prestige: 1 }], 1)[0]?.label ?? "";
    expect(label(1)).toBe("1 место");
    expect(label(2)).toBe("2 места");
    expect(label(5)).toBe("5 мест");
    expect(label(11)).toBe("11 мест");
    expect(label(21)).toBe("21 место");
    expect(label(22)).toBe("22 места");
    expect(label(25)).toBe("25 мест");
  });

  it("пустая лестница — пустой список", () => {
    expect(ladderRows([], 1.3)).toEqual([]);
  });
});

describe("pendingTotal: что ждёт в плашке «Забрать»", () => {
  it("пусто — нули", () => {
    expect(pendingTotal([])).toEqual({ coins: 0, prestige: 0 });
  });

  it("две записи складываются", () => {
    const entry = { seasonKey: "2026-10-26", kind: "place" as const, difficulty: "hard", place: 2, coins: 400, prestige: 25 };
    expect(pendingTotal([entry, { ...entry, seasonKey: "2026-10-19", kind: "threshold", difficulty: null, place: null, coins: 100, prestige: 5 }])).toEqual({
      coins: 500,
      prestige: 30,
    });
  });
});
