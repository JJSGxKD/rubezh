import { describe, expect, it } from "vitest";
import { actionTitle, auditChanges, auditMode, auditObject, auditValue, fetchAudit, fieldTitle, NO_AUDIT_FILTER, type AuditEntry } from "../src/api/audit";
import { AdminApi } from "../src/api/client";
import { formatDateTime, formatNumber } from "../src/format";
import { fakeFetch, json } from "./helpers";

const ACCOUNT = "3c8f3a52-2d4e-4c55-9d0e-6f3b2a1c0d9e";

function entry(patch: Partial<AuditEntry>): AuditEntry {
  return {
    entryId: "e1",
    actorAccountId: ACCOUNT,
    actorName: "Ира",
    action: "settings.save",
    target: null,
    targetName: null,
    before: null,
    after: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    ...patch,
  };
}

describe("журнал аудита", () => {
  it("отбор уходит серверу началами действий, человеком, объектом и курсором", async () => {
    const page = { entries: [entry({})], next: "2026-10-01T10:00:00.000Z_e1" };
    const { fetch, calls } = fakeFetch(json(200, { data: page }), json(200, { data: { entries: [], next: null } }));
    const api = new AdminApi(fetch);

    const first = await fetchAudit(api, NO_AUDIT_FILTER, null);
    expect(first.ok && first.data.next).toBe(page.next);
    expect(calls[0]?.url).toBe("/api/v1/admin/audit?limit=50");

    await fetchAudit(api, { area: "team", actor: { id: ACCOUNT, name: "Ира" }, target: { id: "team.chat", name: "настройка" } }, page.next);
    const query = new URLSearchParams(calls[1]?.url.split("?")[1]);
    expect(query.get("actions")).toBe("admin.,roles.");
    expect(query.get("actor")).toBe(ACCOUNT);
    expect(query.get("target")).toBe("team.chat");
    expect(query.get("before")).toBe(page.next);
  });

  it("действие — словами, незнакомое — как записано", () => {
    expect(actionTitle("players.ban")).toBe("Блокировка игрока");
    expect(actionTitle("broadcast.cancelled")).toBe("Отмена рассылки");
    expect(actionTitle("content.publish")).toBe("content.publish");
  });

  it("объект: имя и ссылка на его экран, а где экрана нет — без ссылки", () => {
    expect(auditObject(entry({ action: "players.ban", target: ACCOUNT, targetName: "Оля" }))).toEqual({ kind: "игрок", label: "Оля", route: { section: "players", id: ACCOUNT } });
    // Аккаунт удалён — имени нет, остаётся начало id.
    expect(auditObject(entry({ action: "roles.assign", target: ACCOUNT }))?.label).toBe("3c8f3a52");
    expect(auditObject(entry({ action: "partner.update", target: "p1", before: { name: "Старое" }, after: { name: "Канал" } }))).toMatchObject({ label: "Канал", route: { section: "partners", id: "p1" } });
    // Удалённый промокод не откроется — ссылки нет, название — из прежнего состояния.
    expect(auditObject(entry({ action: "promo.remove", target: "c1", before: { title: "Стрим" } }))).toEqual({ kind: "промокод", label: "Стрим", route: null });
    expect(auditObject(entry({ action: "players.pii.view", target: "report:r1" }))).toMatchObject({ kind: "отчёт диагностики", route: { section: "diagnostics", id: "r1" } });
    expect(auditObject(entry({ action: "players.pii.view", target: null, after: { query: "ann", found: 2 } }))).toMatchObject({ kind: "поиск", label: "«ann»" });
    expect(auditObject(entry({ action: "fx.manual_rate", target: "RUB:payout" }))?.label).toBe("RUB · payout");
    // Вход — сам в себя: объект повторил бы «Кто».
    expect(auditObject(entry({ action: "admin.login", target: ACCOUNT }))).toBeNull();
  });

  it("правка — только отличия, важное первым, служебное не показывается", () => {
    const changed = entry({
      action: "promo.update",
      before: { updatedAt: "2026-10-01T09:00:00.000Z", endsAt: null, title: "Стрим", maxRedemptions: 100 },
      after: { updatedAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-08T10:00:00.000Z", title: "Стрим 2", maxRedemptions: 100 },
    });
    expect(auditMode(changed)).toBe("update");
    expect(auditChanges(changed)).toEqual([
      { field: "title", before: "Стрим", after: "Стрим 2" },
      { field: "endsAt", before: null, after: "2026-10-08T10:00:00.000Z" },
    ]);
  });

  it("заведение — что задали, без пустых полей; удаление — что было", () => {
    const created = entry({ action: "partner.create", after: { name: "Канал", contact: null, note: "", platforms: [], partnerId: "p1" } });
    expect(auditMode(created)).toBe("create");
    expect(auditChanges(created)).toEqual([{ field: "name", before: null, after: "Канал" }]);

    const removed = entry({ action: "flags.remove", before: { enabled: true, percent: 50 }, after: null });
    expect(auditMode(removed)).toBe("remove");
    expect(auditChanges(removed).map((change) => change.field)).toEqual(["enabled", "percent"]);

    expect(auditChanges(entry({ action: "players.pii.view" }))).toEqual([]);
  });

  it("значения — для человека: даты, да/нет, роли, списки; длинное обрезается", () => {
    expect(auditValue(null)).toBe("—");
    expect(auditValue(true)).toBe("да");
    expect(auditValue(1500)).toBe(formatNumber(1500));
    expect(auditValue("2026-10-08T10:00:00.000Z")).toBe(formatDateTime("2026-10-08T10:00:00.000Z"));
    expect(auditValue("analyst", "role")).toBe("Аналитик");
    expect(auditValue(["owner", "marketer"], "roles")).toBe("Владелец, Маркетолог");
    expect(auditValue(["telegram", "vk"], "platforms")).toBe("Telegram, VK");
    expect(auditValue(["telegram", "vk"])).toBe("telegram, vk");
    expect(auditValue("batch", "kind")).toBe("пачка кодов");
    expect(auditValue("base", "source")).toBe("панель");
    expect(auditValue("tg_ads", "source")).toBe("tg_ads");
    expect(auditValue([])).toBe("—");
    expect(auditValue("x".repeat(100), "", 20)).toHaveLength(20);
    expect(auditValue({ gems: 0, coins: 1000, shard_common: 10 })).toBe(`Монеты ${formatNumber(1000)} · Осколки: обычные 10`);
    expect(auditValue({ coins: 0 })).toBe("ничего");
    expect(auditValue("gems", "resource")).toBe("Самоцветы");
    expect(auditValue({ list: { platform: "vk" } })).toBe('{"list":{"platform":"vk"}}');
    expect(fieldTitle("maxRedemptions")).toBe("лимит активаций");
    expect(fieldTitle("somethingNew")).toBe("somethingNew");
  });
});
