import { describe, expect, it } from "vitest";
import { actionTitle, auditChanges, auditObject, auditValue, type AuditEntry } from "../src/api/audit";
import { AdminApi } from "../src/api/client";
import { checkSecret, fetchSecrets, groupSecrets, resetSecret, saveSecret, secretProblem, secretState, type SecretRow } from "../src/api/secrets";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Ключи интеграций в панели (docs/35-stage4-plan.md Р84, WP46): форма
// проверяет вид ключа тем же правилом, что сервер; значение уходит только
// при записи и проверке; журнал показывает последние знаки, а не ключ.

const PRO: SecretRow = {
  key: "fx.coingecko-pro",
  service: "Курсы валют · CoinGecko",
  title: "Платный ключ CoinGecko",
  hint: "Курсы TON и USDT с платного тарифа",
  cabinetUrl: "https://www.coingecko.com/en/developers/dashboard",
  example: "CG-AbCdEfGh1234567890",
  pattern: "^CG-[A-Za-z0-9]{8,64}$",
  checkable: true,
  source: "base",
  fingerprint: "••••2345",
  envSet: true,
  unreadable: false,
  updatedBy: "00000000-0000-4000-8000-000000000001",
  updatedByName: "Владелец",
  updatedAt: "2026-10-02T01:00:00.000Z",
};
const DEMO: SecretRow = { ...PRO, key: "fx.coingecko-demo", title: "Демо-ключ CoinGecko", source: "none", fingerprint: null, envSet: false, updatedBy: null, updatedByName: null, updatedAt: null };

describe("ключи интеграций в панели", () => {
  it("список, запись без пробелов по краям, проверка и сброс по имени ключа", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { enabled: true, secrets: [PRO, DEMO] } }),
      json(200, { data: PRO }),
      json(200, { data: { ok: true, message: "CoinGecko принял ключ" } }),
      json(200, { data: { ok: false, message: "CoinGecko не принял ключ (401)" } }),
      json(200, { data: { ...PRO, source: "env" } }),
    );
    const api = new AdminApi(fetch);

    const list = await fetchSecrets(api);
    expect(list.ok && list.data.enabled).toBe(true);

    await saveSecret(api, "fx.coingecko-pro", "  CG-New1234567890 ");
    expect(calls[1]?.url).toBe("/api/v1/admin/secrets/fx.coingecko-pro");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ value: "CG-New1234567890" });

    // Действующим ключом — пустое тело: значение у сервера, панель его не знает.
    await checkSecret(api, "fx.coingecko-pro", null);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({});
    const candidate = await checkSecret(api, "fx.coingecko-pro", " CG-Candidate123 ");
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ value: "CG-Candidate123" });
    expect(candidate.ok && candidate.data.ok).toBe(false);

    const reset = await resetSecret(api, "fx.coingecko-pro");
    expect(reset.ok && reset.data.source).toBe("env");
    expect(calls[4]?.url).toBe("/api/v1/admin/secrets/fx.coingecko-pro/reset");
  });

  it("форма проверяет ключ так же, как сервер", () => {
    expect(secretProblem(PRO, "CG-AbCdEfGh1234567890")).toBeNull();
    expect(secretProblem(PRO, "  CG-AbCdEfGh1234567890\n")).toBeNull();
    expect(secretProblem(PRO, "")).toBe("Вставьте ключ");
    expect(secretProblem(PRO, "CG-Ab Cd")).toMatch(/без пробелов/);
    expect(secretProblem(PRO, "abcdefghijkl")).toBe("Платный ключ CoinGecko выглядит как «CG-AbCdEfGh1234567890»");
  });

  it("состояние словами: откуда ключ и что будет после сброса", () => {
    expect(secretState(PRO)).toMatchObject({ label: "Из панели", detail: expect.stringContaining("«Сбросить» вернёт его") });
    expect(secretState({ ...PRO, envSet: false })).toMatchObject({ detail: expect.stringContaining("останется без ключа") });
    expect(secretState({ ...PRO, source: "env" })).toMatchObject({ label: "Из окружения" });
    expect(secretState(DEMO)).toMatchObject({ label: "Не задан" });
    expect(secretState({ ...PRO, source: "env", unreadable: true })).toMatchObject({ tone: "danger", label: "Не расшифровывается", detail: expect.stringContaining("Задайте ключ заново") });
    expect(groupSecrets([PRO, DEMO, { ...PRO, key: "x", service: "AdsGram" }]).map((group) => [group.service, group.rows.length])).toEqual([
      ["Курсы валют · CoinGecko", 2],
      ["AdsGram", 1],
    ]);
    expect(SECTIONS.find((section) => section.id === "secrets")?.permission).toBe("secrets.view");
  });

  it("журнал: замена ключа — словами и последними знаками", () => {
    const entry: AuditEntry = {
      entryId: "e1",
      actorAccountId: null,
      actorName: "Владелец",
      action: "secrets.save",
      target: "fx.coingecko-pro",
      targetName: null,
      before: { title: "Платный ключ CoinGecko", source: "env", fingerprint: "••••ent1" },
      after: { title: "Платный ключ CoinGecko", source: "base", fingerprint: "••••2345" },
      createdAt: "2026-10-02T01:00:00.000Z",
    };
    expect(actionTitle(entry.action)).toBe("Замена ключа интеграции");
    expect(auditObject(entry)).toEqual({ kind: "ключ", label: "Платный ключ CoinGecko", route: { section: "secrets", id: null } });
    expect(auditChanges(entry).map((change) => change.field)).toEqual(["fingerprint", "source"]);
    expect(auditValue("none", "source")).toBe("не задан");
  });
});
