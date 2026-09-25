import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { compactJson, fetchAudit, grantRole, revokeRole, roleName, roleTargetOf } from "../src/api/roles";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

describe("роли и аудит", () => {
  it("цель — uuid аккаунта или Telegram ID; прочее отклоняется до запроса", () => {
    expect(roleTargetOf(" 3C8F3A52-2D4E-4C55-9D0E-6F3B2A1C0D9E ")).toEqual({ accountId: "3c8f3a52-2d4e-4c55-9d0e-6f3b2a1c0d9e" });
    expect(roleTargetOf("555000111")).toEqual({ platformUserId: "555000111", platform: "telegram" });
    expect(roleTargetOf("@ann")).toBeNull();
    expect(roleTargetOf("")).toBeNull();
  });

  it("выдача и снятие несут цель и роль, изменяющий заголовок ставит клиент", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { granted: true } }), json(200, { data: { revoked: true, sessionsRevoked: 2 } }));
    const api = new AdminApi(fetch);
    await grantRole(api, { platformUserId: "555", platform: "telegram" }, "moderator");
    const revoked = await revokeRole(api, { accountId: "a1" }, "moderator");

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ platformUserId: "555", platform: "telegram", role: "moderator" });
    expect(calls[1]?.url).toBe("/api/v1/admin/roles/revoke");
    expect(revoked.ok && revoked.data.sessionsRevoked).toBe(2);
  });

  it("журнал: запись без «было» и действие системы разбираются", async () => {
    const entry = { entryId: "e1", actorAccountId: null, action: "roles.grant", target: "a1", after: { role: "owner" }, createdAt: "2026-09-25T10:00:00.000Z" };
    const { fetch } = fakeFetch(json(200, { data: { entries: [entry] } }));
    const result = await fetchAudit(new AdminApi(fetch));
    expect(result.ok && result.data.entries[0]?.actorAccountId).toBeNull();
  });

  it("имена ролей и «было → стало» для таблицы", () => {
    expect(roleName("game_designer")).toBe("Геймдизайнер");
    expect(roleName("partner")).toBe("partner");
    expect(compactJson(undefined)).toBe("—");
    expect(compactJson({ roles: ["owner"] })).toBe('{"roles":["owner"]}');
    expect(compactJson({ text: "x".repeat(300) }, 20)).toHaveLength(20);
  });
});

describe("меню разделов", () => {
  it("у каждого раздела своё право и свой идентификатор", () => {
    const ids = SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.fromEntries(SECTIONS.map((section) => [section.id, section.permission]))).toMatchObject({
      funnel: "analytics.gameplay.view",
      roles: "roles.assign",
      audit: "audit.view",
    });
  });
});
