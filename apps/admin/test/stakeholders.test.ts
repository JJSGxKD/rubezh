import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { canManageShares, consequenceText, loadStakeholders, monthLabel, monthOptions, setShare, shareAtMonth, shareProblem, stakeholdersViewSchema, type StakeholdersView } from "../src/api/stakeholders";
import type { SessionView } from "../src/state/session";
import { fakeFetch, json } from "./helpers";

const IVAN = {
  accountId: "a1",
  name: "Иван",
  hasRole: true,
  current: { sharePercent: 30, fromMonth: "2026-11" },
  next: { sharePercent: 20, fromMonth: "2027-01" },
  history: [
    { sharePercent: 20, fromMonth: "2027-01", note: "пересмотр", setBy: "Владелец", setAt: "2026-11-02T10:00:00.000Z" },
    { sharePercent: 30, fromMonth: "2026-11", note: "старт", setBy: "Владелец", setAt: "2026-10-30T10:00:00.000Z" },
  ],
};

const VIEW: StakeholdersView = {
  month: "2026-11",
  ownerSharePercent: 70,
  participants: [IVAN, { accountId: "a2", name: "Мария", hasRole: false, current: null, next: null, history: [] }],
};

function ready(permissions: string[]): SessionView {
  return { status: "ready", identity: { account: { accountId: "x", platform: "telegram", displayName: "Я", photoUrl: null }, roles: [], permissions } } as SessionView;
}

describe("ответ сервера об участниках", () => {
  it("лишнее поле не ломает разбор", () => {
    expect(stakeholdersViewSchema.safeParse({ ...VIEW, extra: 1 }).success).toBe(true);
  });

  it("нехватка поля — ошибка", () => {
    const broken: Record<string, unknown> = { ...VIEW };
    delete broken["ownerSharePercent"];
    expect(stakeholdersViewSchema.safeParse(broken).success).toBe(false);
  });

  it("причина и автор необязательны: финансы и участник видят историю по-разному", () => {
    const view = { ...VIEW, participants: [{ ...IVAN, history: [{ sharePercent: 30, fromMonth: "2026-11", setAt: "2026-10-30T10:00:00.000Z" }] }] };
    expect(stakeholdersViewSchema.safeParse(view).success).toBe(true);
  });

  it("loadStakeholders читает GET, setShare шлёт PUT с телом", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: VIEW }), json(200, { data: VIEW }));
    const api = new AdminApi(fetch);
    expect((await loadStakeholders(api)).ok).toBe(true);
    expect((await setShare(api, "a1", { sharePercent: 25, fromMonth: "2026-12", note: "пересмотр" })).ok).toBe(true);
    expect(calls[0]?.url).toContain("/admin/stakeholders");
    expect(calls[1]?.url).toContain("/admin/stakeholders/a1/share");
    expect(calls[1]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ sharePercent: 25, fromMonth: "2026-12", note: "пересмотр" });
  });
});

describe("окно «Изменить долю»", () => {
  it("месяцы: текущий и 12 следующих, по-русски", () => {
    const months = monthOptions("2026-11");
    expect(months).toHaveLength(13);
    expect(months[0]).toEqual({ value: "2026-11", label: "ноябрь 2026" });
    expect(months[2]).toEqual({ value: "2027-01", label: "январь 2027" });
    expect(months[12]).toEqual({ value: "2027-11", label: "ноябрь 2027" });
    expect(monthLabel("2026-12")).toBe("декабрь 2026");
  });

  it("доля участника на месяц берётся из истории", () => {
    expect(shareAtMonth(IVAN.history, "2026-11")).toBe(30);
    expect(shareAtMonth(IVAN.history, "2026-12")).toBe(30);
    expect(shareAtMonth(IVAN.history, "2027-01")).toBe(20);
    expect(shareAtMonth(IVAN.history, "2026-10")).toBe(0);
  });

  it("владельцу останется остаток; сумма больше 100 % — отказ до отправки", () => {
    expect(shareProblem(VIEW, "a2", 60, "2026-11")).toEqual({ ownerLeft: 10, problem: null });
    expect(shareProblem(VIEW, "a2", 85, "2027-01")).toEqual({ ownerLeft: -5, problem: "Сумма долей дала бы 105 % — больше 100 %" });
    expect(shareProblem(VIEW, "a1", 100, "2026-11")).toEqual({ ownerLeft: 0, problem: null });
  });

  it("доля вне 0…100 или с тремя знаками не годится", () => {
    expect(shareProblem(VIEW, "a1", -1, "2026-11").problem).not.toBeNull();
    expect(shareProblem(VIEW, "a1", 101, "2026-11").problem).not.toBeNull();
    expect(shareProblem(VIEW, "a1", 12.345, "2026-11").problem).not.toBeNull();
    expect(shareProblem(VIEW, "a1", 12.34, "2026-11").problem).toBeNull();
  });

  it("строка последствий", () => {
    expect(consequenceText("Иван", 25, "2026-12")).toBe("С декабря 2026 доля Иван — 25 %. Прошлые месяцы не меняются.");
    expect(consequenceText("Иван", 0, "2026-12")).toBe("С декабря 2026 Иван больше не получает долю.");
  });
});

describe("права на кнопку", () => {
  it("«Изменить долю» — только с stakeholders.manage", () => {
    expect(canManageShares(ready(["revenue.split.view", "stakeholders.manage"]))).toBe(true);
    expect(canManageShares(ready(["revenue.split.view"]))).toBe(false);
    expect(canManageShares({ status: "loading" })).toBe(false);
  });
});
