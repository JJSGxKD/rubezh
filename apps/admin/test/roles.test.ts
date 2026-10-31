import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { compactJson, fetchAssignments, fetchCandidate, grantRole, revokeRole, roleName, rolePurpose, roleTargetOf, sectionsOfRole, teamOf, ROLE_NAMES, type Assignment } from "../src/api/roles";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

describe("роли", () => {
  it("цель — uuid аккаунта или Telegram ID; прочее отклоняется до запроса", () => {
    expect(roleTargetOf(" 3C8F3A52-2D4E-4C55-9D0E-6F3B2A1C0D9E ")).toEqual({ accountId: "3c8f3a52-2d4e-4c55-9d0e-6f3b2a1c0d9e" });
    expect(roleTargetOf("555000111")).toEqual({ platformUserId: "555000111", platform: "telegram" });
    expect(roleTargetOf("@ann")).toBeNull();
    expect(roleTargetOf("")).toBeNull();
  });

  it("выдача и снятие несут цель и роль, изменяющий заголовок ставит клиент", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { granted: true, confirm: null } }), json(200, { data: { revoked: true, sessionsRevoked: 2 } }));
    const api = new AdminApi(fetch);
    await grantRole(api, { platformUserId: "555", platform: "telegram" }, "moderator");
    const revoked = await revokeRole(api, { accountId: "a1" }, "moderator");

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ platformUserId: "555", platform: "telegram", role: "moderator" });
    expect(calls[1]?.url).toBe("/api/v1/admin/roles/revoke");
    expect(revoked.ok && revoked.data.sessionsRevoked).toBe(2);
  });

  it("выдача owner и admin отвечает ссылкой на подтверждение в боте, остальные роли — confirm: null", async () => {
    const link = "https://t.me/rubezh_bot?start=role-AAAAAAAAAAAAAAAAAAAAAA";
    const { fetch } = fakeFetch(json(200, { data: { granted: false, confirm: { link, expiresAtMs: 1_790_000_000_000 } } }), json(200, { data: { granted: true, confirm: null } }), json(200, { data: { granted: true } }));
    const api = new AdminApi(fetch);
    const pending = await grantRole(api, { accountId: "a1" }, "admin");
    expect(pending.ok && pending.data).toEqual({ granted: false, confirm: { link, expiresAtMs: 1_790_000_000_000 } });
    const immediate = await grantRole(api, { accountId: "a1" }, "marketer");
    expect(immediate.ok && immediate.data).toEqual({ granted: true, confirm: null });
    // Ответ без поля confirm — не наш сервер: схема его не принимает.
    expect((await grantRole(api, { accountId: "a1" }, "marketer")).ok).toBe(false);
  });

  it("имена ролей и «было → стало» для таблицы", () => {
    expect(roleName("game_designer")).toBe("Геймдизайнер");
    expect(roleName("partner")).toBe("partner");
    expect(compactJson(undefined)).toBe("—");
    expect(compactJson({ roles: ["owner"] })).toBe('{"roles":["owner"]}');
    expect(compactJson({ text: "x".repeat(300) }, 20)).toHaveLength(20);
  });
});

describe("уровни ролей (T-0216)", () => {
  const entry = { accountId: "a", displayName: "Ира", role: "analyst", grantedBy: null, grantedByName: null, grantedAt: "2026-09-01T10:00:00.000Z" };

  it("сервер присылает, что можно выдать и снять; старый сервер без флагов — всё можно, отказ даст сам сервер", async () => {
    const { fetch } = fakeFetch(
      json(200, { data: { assignments: [{ ...entry, revocable: false }], roles: [{ role: "admin", permissions: [], grantable: false }, { role: "analyst", permissions: [], grantable: true }] } }),
      json(200, { data: { assignments: [entry], roles: [{ role: "admin", permissions: [] }] } }),
    );
    const api = new AdminApi(fetch);

    const levelled = await fetchAssignments(api);
    expect(levelled.ok && levelled.data.assignments[0]?.revocable).toBe(false);
    expect(levelled.ok && levelled.data.roles.map((role) => role.grantable)).toEqual([false, true]);

    const legacy = await fetchAssignments(api);
    expect(legacy.ok && legacy.data.assignments[0]?.revocable).toBe(true);
    expect(legacy.ok && legacy.data.roles[0]?.grantable).toBe(true);
  });
});

describe("команда", () => {
  const at = (day: number) => `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`;
  const row = (accountId: string, role: string, day: number): Assignment => ({ accountId, displayName: accountId, role, grantedBy: null, grantedByName: null, grantedAt: at(day), revocable: true });

  it("человек — одной строкой со всеми ролями; старшие роли и люди — первыми", () => {
    const team = teamOf([row("lena", "analyst", 20), row("ira", "marketer", 12), row("lena", "marketer", 10), row("ira", "owner", 15)]);
    expect(team.map((member) => member.accountId)).toEqual(["ira", "lena"]);
    expect(team[0]?.assignments.map((assignment) => assignment.role)).toEqual(["owner", "marketer"]);
    // В команде — с первой выдачи, а не с последней.
    expect(team[1]?.since).toBe(at(10));
  });

  it("у каждой роли есть объяснение, разделы считаются из прав", () => {
    for (const [id] of ROLE_NAMES) expect(rolePurpose(id), id).not.toBe("");
    expect(sectionsOfRole(["players.view"])).toBe("Игроки, Разбор забегов");
    expect(sectionsOfRole([])).toBe("в панели пока ни одного раздела");
  });

  it("кто это — запрос по Telegram ID, ненайденный — null", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { candidate: null } }));
    const result = await fetchCandidate(new AdminApi(fetch), { platformUserId: "555", platform: "telegram" });
    expect(result.ok && result.data.candidate).toBeNull();
    expect(calls[0]?.url).toBe("/api/v1/admin/roles/candidate?platformUserId=555&platform=telegram");
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
