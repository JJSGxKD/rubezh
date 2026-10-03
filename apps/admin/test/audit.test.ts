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
    // Блокировка целиком теперь — тоже ограничение (WP44); прежние записи остаются под старым именем.
    expect(actionTitle("players.restrict")).toBe("Ограничение игрока");
    expect(actionTitle("players.unrestrict")).toBe("Снятие ограничения");
    expect(actionTitle("broadcast.cancelled")).toBe("Отмена рассылки");
    expect(actionTitle("content.publish")).toBe("content.publish");
  });

  it("ограничение игрока — словами: что, до когда, почему и молча ли; снятие — с прежним и причиной", () => {
    const imposed = entry({
      action: "players.restrict",
      target: ACCOUNT,
      targetName: "Оля",
      before: { replaced: [{ restrictionId: "r0", kind: "promo_codes", endsAt: null, reason: "other", comment: null, notify: true }] },
      after: {
        restrictions: [
          { restrictionId: "r1", kind: "promo_codes", endsAt: "2026-10-06T12:00:00.000Z", reason: "promo_abuse", comment: "20 кодов за час", notify: true },
          { restrictionId: "r2", kind: "leaderboard", endsAt: null, reason: "leaderboard_cheat", comment: null, notify: false },
        ],
      },
    });
    const [restrictions, replaced] = auditChanges(imposed);
    expect(restrictions?.field).toBe("restrictions");
    expect(fieldTitle("restrictions")).toBe("ограничения");
    expect(auditValue(restrictions?.after, "restrictions", 400)).toBe(
      `промокоды до ${formatDateTime("2026-10-06T12:00:00.000Z")} — злоупотребление промокодами; рейтинг бессрочно — накрутка рейтинга, молча`,
    );
    expect(auditValue(replaced?.before, "replaced", 400)).toBe("промокоды бессрочно — другое");
    expect(auditObject(imposed)).toMatchObject({ kind: "игрок", label: "Оля" });

    const lifted = entry({ action: "players.unrestrict", target: ACCOUNT, before: { restrictionId: "r1", kind: "all", endsAt: null, reason: "abuse", comment: null, notify: true }, after: { comment: "разобрались" } });
    const shown = Object.fromEntries(auditChanges(lifted).map((change) => [change.field, auditValue(change.before ?? change.after, change.field)]));
    expect(shown).toMatchObject({ kind: "блокировка целиком", reason: "оскорбления или спам", comment: "разобрались" });
    // Свободная причина других действий — как записана.
    expect(auditValue("компенсация за сбой", "reason")).toBe("компенсация за сбой");
  });

  it("забег снят с рейтинга — какой: сложность, время, начало id; и почему", () => {
    const unranked = entry({ action: "players.run.unrank", target: ACCOUNT, targetName: "Оля", after: { runId: "9a1b2c3d-0000-4000-8000-000000000001", difficulty: "normal", survivalSec: 500, comment: "без урона 8 минут" } });
    expect(actionTitle("players.run.unrank")).toBe("Снятие забега с рейтинга");
    expect(actionTitle("players.run.rerank")).toBe("Возврат забега в рейтинг");
    expect(auditChanges(unranked).map((change) => [fieldTitle(change.field), auditValue(change.after, change.field)])).toEqual([
      ["забег", "9a1b2c3d"],
      ["сложность", "нормальная"],
      ["время в забеге", "8:20"],
      ["комментарий", "без урона 8 минут"],
    ]);
    expect(auditObject(unranked)).toMatchObject({ kind: "игрок", label: "Оля", route: { section: "players", id: ACCOUNT } });
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
