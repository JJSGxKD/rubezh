import { describe, expect, it } from "vitest";
import { MAX_SHARE_BP, monthKey, overLimit, parseMonth, percentToBp, shareAt, type ShareRecord } from "../src/modules/stakeholders/stakeholder-rules.js";
import { stakeholdersView } from "../src/modules/stakeholders/stakeholder-view.js";
import type { ParticipantRow, StoredShare } from "../src/modules/stakeholders/stakeholders.repository.js";

/**
 * Доли участников проекта (docs/35-stage4-plan.md Р217, tasks/T-0452): чистые правила без базы — месяц,
 * доля на месяц, предел суммы, перевод процентов — и сборка ответа панели из строк хранилища.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const share = (accountId: string, fromMonth: string, shareBp: number): ShareRecord => ({ accountId, fromMonth, shareBp });

describe("месяц: monthKey и parseMonth", () => {
  it("monthKey берёт месяц по UTC, а не по часовому поясу машины", () => {
    expect(monthKey(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
    expect(monthKey(new Date("2026-11-30T23:59:59.999Z"))).toBe("2026-11");
    expect(monthKey(new Date(Date.UTC(2027, 0, 15, 12)))).toBe("2027-01");
  });

  it("parseMonth отдаёт первое число месяца 00:00 UTC", () => {
    expect(parseMonth("2026-12").toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(parseMonth("2027-01").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("parseMonth не принимает неверную строку", () => {
    for (const bad of ["2026-13", "2026-1", "2026-00", "abc", "", "2026-12-01", " 2026-12", "26-12"]) {
      expect(() => parseMonth(bad), bad).toThrow();
    }
  });

  it("monthKey и parseMonth обратимы", () => {
    expect(monthKey(parseMonth("2026-02"))).toBe("2026-02");
  });
});

describe("shareAt: доля на месяц", () => {
  it("нет записей — ноль", () => {
    expect(shareAt([], "2026-11")).toBe(0);
  });

  it("запись в будущем на текущий месяц ещё не действует", () => {
    expect(shareAt([{ fromMonth: "2026-12", shareBp: 2_550 }], "2026-11")).toBe(0);
  });

  it("запись действует с месяца начала, включая его", () => {
    expect(shareAt([{ fromMonth: "2026-12", shareBp: 2_550 }], "2026-12")).toBe(2_550);
    expect(shareAt([{ fromMonth: "2026-12", shareBp: 2_550 }], "2027-05")).toBe(2_550);
  });

  it("две записи — берётся последняя не позже месяца, порядок в списке не важен", () => {
    const history = [
      { fromMonth: "2027-02", shareBp: 0 },
      { fromMonth: "2026-12", shareBp: 2_550 },
      { fromMonth: "2027-01", shareBp: 3_000 },
    ];
    expect(shareAt(history, "2026-12")).toBe(2_550);
    expect(shareAt(history, "2027-01")).toBe(3_000);
    expect(shareAt(history, "2027-02")).toBe(0);
    expect(shareAt(history, "2030-01")).toBe(0);
  });
});

describe("overLimit: сумма долей не больше 100 % ни на одном месяце", () => {
  it("предел — 10 000 базисных пунктов", () => {
    expect(MAX_SHARE_BP).toBe(10_000);
  });

  it("двое по 50 % — в пределе", () => {
    const all = [share(A, "2026-12", 5_000)];
    expect(overLimit(all, share(B, "2026-12", 5_000))).toBeNull();
  });

  it("третий с 1 % с того же месяца — превышение с этого месяца и суммой", () => {
    const all = [share(A, "2026-12", 5_000), share(B, "2026-12", 5_000)];
    expect(overLimit(all, share(C, "2026-12", 100))).toEqual({ month: "2026-12", totalBp: 10_100 });
  });

  it("превышение на месяце, где уже есть запись другого участника, находится на этой границе", () => {
    const all = [share(A, "2026-12", 6_000), share(B, "2027-02", 3_000)];
    // С 2027-02 у A 60 %, у B 30 %, новый C с 2026-12 берёт 20 %: на границе 2027-02 выходит 110 %
    expect(overLimit(all, share(C, "2026-12", 2_000))).toEqual({ month: "2027-02", totalBp: 11_000 });
  });

  it("будущая запись одного участника снижает долю — превышение только до неё", () => {
    const all = [share(A, "2026-12", 6_000), share(A, "2027-02", 0)];
    // С февраля доля A — ноль, поэтому B с 50 % с февраля ничего не нарушает
    expect(overLimit(all, share(B, "2027-02", 5_000))).toBeNull();
    // а с января A ещё держит 60 %: 60 + 50
    expect(overLimit(all, share(B, "2027-01", 5_000))).toEqual({ month: "2027-01", totalBp: 11_000 });
  });

  it("запись, которая снижает долю, не даёт превышения там, где его не было", () => {
    const all = [share(A, "2026-12", 5_000), share(B, "2026-12", 5_000)];
    expect(overLimit(all, share(A, "2027-01", 1_000))).toBeNull();
  });

  it("замена записи того же участника и месяца не считается дважды", () => {
    const all = [share(A, "2026-12", 5_000), share(B, "2026-12", 5_000)];
    expect(overLimit(all, share(A, "2026-12", 5_000))).toBeNull();
    expect(overLimit(all, share(A, "2026-12", 5_001))).toEqual({ month: "2026-12", totalBp: 10_001 });
    const lowered = [share(A, "2026-12", 6_000), share(B, "2026-12", 4_000)];
    expect(overLimit(lowered, share(A, "2026-12", 5_000))).toBeNull();
  });

  it("первая граница с превышением — ответ, даже если дальше сумма больше", () => {
    const all = [share(A, "2026-12", 6_000), share(B, "2027-03", 3_000)];
    expect(overLimit(all, share(C, "2026-12", 5_000))?.month).toBe("2026-12");
  });

  it("записи раньше изменяемого месяца не проверяются: прошлое не пересчитывается", () => {
    const all = [share(A, "2026-10", 9_000), share(B, "2026-11", 2_000)];
    // на 2026-11 уже 110 %, но новая запись с 2026-12 меняет только 2026-12 и дальше
    expect(overLimit(all, share(A, "2026-12", 5_000))).toBeNull();
  });
});

describe("percentToBp: проценты в базисные пункты", () => {
  it("целые и дробные проценты без ошибок плавающей точки", () => {
    expect(percentToBp(25.5)).toBe(2_550);
    expect(percentToBp(33.33)).toBe(3_333);
    expect(percentToBp(0.1 + 0.2)).toBe(30);
    expect(percentToBp(0)).toBe(0);
    expect(percentToBp(100)).toBe(10_000);
    expect(percentToBp(0.07)).toBe(7);
    expect(percentToBp(1.15)).toBe(115);
  });

  it("больше двух знаков и вне 0…100 — исключение", () => {
    expect(() => percentToBp(100.001)).toThrow();
    expect(() => percentToBp(12.345)).toThrow();
    expect(() => percentToBp(-1)).toThrow();
    expect(() => percentToBp(100.01)).toThrow();
    expect(() => percentToBp(Number.NaN)).toThrow();
    expect(() => percentToBp(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("stakeholdersView: ответ панели", () => {
  const owner = "Владелец";
  const participants: ParticipantRow[] = [
    { accountId: A, displayName: "Анна", hasRole: true },
    { accountId: B, displayName: "Борис", hasRole: true },
    { accountId: C, displayName: "Вера", hasRole: false },
  ];
  const stored = (accountId: string, fromMonth: string, shareBp: number, patch: Partial<StoredShare> = {}): StoredShare => ({
    accountId,
    fromMonth,
    shareBp,
    note: "договорённость",
    setBy: "44444444-4444-4444-8444-444444444444",
    setByName: owner,
    setAt: new Date(Date.UTC(2026, 10, 1, 9)),
    ...patch,
  });

  it("доля на текущий месяц, ближайшая будущая запись и доля владельца — остаток", () => {
    const history = [stored(A, "2026-10", 2_000), stored(A, "2026-12", 2_550), stored(B, "2026-11", 3_000)];
    const view = stakeholdersView({ month: "2026-11", participants, history, detailed: true });

    expect(view.month).toBe("2026-11");
    const anna = view.participants.find((p) => p.accountId === A);
    expect(anna).toMatchObject({ name: "Анна", hasRole: true, current: { sharePercent: 20, fromMonth: "2026-10" }, next: { sharePercent: 25.5, fromMonth: "2026-12" } });
    const boris = view.participants.find((p) => p.accountId === B);
    expect(boris).toMatchObject({ current: { sharePercent: 30, fromMonth: "2026-11" }, next: null });
    expect(view.ownerSharePercent).toBe(50);
  });

  it("нулевая доля на текущий месяц — current null; будущий ноль — это next (конец участия)", () => {
    const history = [stored(A, "2026-09", 1_000), stored(A, "2026-11", 0), stored(B, "2026-10", 4_000), stored(B, "2027-01", 0)];
    const view = stakeholdersView({ month: "2026-11", participants, history, detailed: true });

    expect(view.participants.find((p) => p.accountId === A)).toMatchObject({ current: null, next: null });
    expect(view.participants.find((p) => p.accountId === B)).toMatchObject({ current: { sharePercent: 40, fromMonth: "2026-10" }, next: { sharePercent: 0, fromMonth: "2027-01" } });
    expect(view.ownerSharePercent).toBe(60);
  });

  it("участник без строк долей остаётся в списке: роль есть, доли нет", () => {
    const view = stakeholdersView({ month: "2026-11", participants, history: [], detailed: true });
    expect(view.participants).toHaveLength(3);
    expect(view.participants.find((p) => p.accountId === B)).toMatchObject({ current: null, next: null, history: [] });
    expect(view.ownerSharePercent).toBe(100);
  });

  it("снявшие роль участники с долями остаются с hasRole false", () => {
    const view = stakeholdersView({ month: "2026-11", participants, history: [stored(C, "2026-11", 1_000)], detailed: true });
    expect(view.participants.find((p) => p.accountId === C)).toMatchObject({ hasRole: false, current: { sharePercent: 10, fromMonth: "2026-11" } });
  });

  it("история — новые месяцы сверху, с причиной, автором и временем для тех, кто видит детали", () => {
    const history = [stored(A, "2026-10", 2_000, { note: "первая" }), stored(A, "2026-12", 2_550, { note: "вторая", setByName: "Ирина" })];
    const entries = stakeholdersView({ month: "2026-11", participants, history, detailed: true }).participants.find((p) => p.accountId === A)?.history;

    expect(entries?.map((entry) => entry.fromMonth)).toEqual(["2026-12", "2026-10"]);
    expect(entries?.[0]).toEqual({ sharePercent: 25.5, fromMonth: "2026-12", note: "вторая", setBy: "Ирина", setAt: "2026-11-01T09:00:00.000Z" });
  });

  it("участнику причина и автор в истории не отдаются — самих полей нет", () => {
    const history = [stored(A, "2026-10", 2_000, { note: "тайная причина" })];
    const entries = stakeholdersView({ month: "2026-11", participants, history, detailed: false }).participants.find((p) => p.accountId === A)?.history;

    expect(entries).toEqual([{ sharePercent: 20, fromMonth: "2026-10", setAt: "2026-11-01T09:00:00.000Z" }]);
    expect(JSON.stringify(entries)).not.toContain("тайная причина");
    expect(entries?.[0]).not.toHaveProperty("note");
    expect(entries?.[0]).not.toHaveProperty("setBy");
  });

  it("порядок — по текущей доле от большей, затем по имени", () => {
    const history = [stored(A, "2026-10", 1_000), stored(B, "2026-10", 3_000)];
    const view = stakeholdersView({ month: "2026-11", participants, history, detailed: true });
    expect(view.participants.map((p) => p.name)).toEqual(["Борис", "Анна", "Вера"]);
  });

  it("доля владельца без ошибок плавающей точки", () => {
    const history = [stored(A, "2026-10", 3_333), stored(B, "2026-10", 3_333), stored(C, "2026-10", 3_333)];
    expect(stakeholdersView({ month: "2026-11", participants, history, detailed: true }).ownerSharePercent).toBe(0.01);
  });
});
