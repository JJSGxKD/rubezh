import { describe, expect, it } from "vitest";
import { SEED_AT, mergeSettings, readStored, type AccountSettingValues } from "../src/modules/account-settings/account-settings.catalog.js";
import type { AccountSettingsRepository, StoredAccountSettings } from "../src/modules/account-settings/account-settings.repository.js";
import { AccountSettingsService } from "../src/modules/account-settings/account-settings.service.js";

/**
 * Настройки аккаунта (docs/35-stage4-plan.md WP29): слияние ключ за ключом,
 * побеждает выбранное позже по часам сервера — устройство присылает возраст
 * выбора, а не своё время; засев прежних значений занимает только пустой
 * ключ; усвоенные подсказки складываются; неизвестное и битое пропускается.
 */

const NOW = Date.UTC(2026, 8, 29, 12);
const account = { accountId: "00000000-0000-4000-8000-000000000001", platform: "telegram" as const, platformUserId: "7" };

describe("слияние настроек", () => {
  it("побеждает выбранное позже, ключ за ключом", () => {
    const stored: AccountSettingValues = { "combat.telegraphs": { value: true, at: NOW - 60_000 }, "testing.enabled": { value: false, at: NOW - 1_000 } };
    const { values } = mergeSettings(stored, { "combat.telegraphs": { value: false, ageMs: 5_000 }, "testing.enabled": { value: true, ageMs: 10_000 } }, NOW);
    expect(values["combat.telegraphs"]).toEqual({ value: false, at: NOW - 5_000 });
    expect(values["testing.enabled"]).toEqual({ value: false, at: NOW - 1_000 });
  });

  it("время выбора ставит сервер: часы устройства в будущем или в прошлом ничего не решают", () => {
    // Выбор, сделанный секунду назад, новее выбора минуту назад — какие бы
    // часы ни стояли на устройствах: присылается только возраст.
    const stored: AccountSettingValues = { "combat.damageNumbers": { value: true, at: NOW - 60_000 } };
    expect(mergeSettings(stored, { "combat.damageNumbers": { value: false, ageMs: 1_000 } }, NOW).values["combat.damageNumbers"]).toEqual({ value: false, at: NOW - 1_000 });
    // Возраст больше возраста сервера и отрицательный не выводят время за края.
    expect(mergeSettings({}, { "combat.damageNumbers": { value: false, ageMs: NOW * 2 } }, NOW).values["combat.damageNumbers"]?.at).toBe(SEED_AT + 1);
    expect(mergeSettings({}, { "combat.damageNumbers": { value: false, ageMs: -5 } }, NOW).values["combat.damageNumbers"]?.at).toBe(NOW);
  });

  it("выбор, сделанный без сети давно, не перебивает выбранное позже на другом устройстве", () => {
    const stored: AccountSettingValues = { "combat.telegraphs": { value: true, at: NOW - 3_600_000 } };
    const { values } = mergeSettings(stored, { "combat.telegraphs": { value: false, ageMs: 86_400_000 } }, NOW);
    expect(values["combat.telegraphs"]).toEqual({ value: true, at: NOW - 3_600_000 });
  });

  it("засев занимает только пустой ключ и проигрывает любому выбору и другому засеву", () => {
    const stored: AccountSettingValues = { "combat.telegraphs": { value: false, at: NOW - 1_000 }, "testing.enabled": { value: true, at: SEED_AT } };
    const { values } = mergeSettings(
      stored,
      { "combat.telegraphs": { value: true, seed: true }, "testing.enabled": { value: false, seed: true }, "combat.damageNumbers": { value: false, seed: true } },
      NOW,
    );
    expect(values["combat.telegraphs"]).toEqual({ value: false, at: NOW - 1_000 });
    expect(values["testing.enabled"]).toEqual({ value: true, at: SEED_AT });
    expect(values["combat.damageNumbers"]).toEqual({ value: false, at: SEED_AT });
  });

  it("усвоенные подсказки складываются, даже если список пришёл с опозданием", () => {
    const stored: AccountSettingValues = { "hints.seen": { value: ["move", "gems", "dodge"], at: NOW - 1_000 } };
    expect(mergeSettings(stored, { "hints.seen": { value: ["move"], ageMs: 500 } }, NOW).values["hints.seen"]).toEqual({ value: ["move", "gems", "dodge"], at: NOW - 500 });
    const partial: AccountSettingValues = { "hints.seen": { value: ["move"], at: NOW - 1_000 } };
    expect(mergeSettings(partial, { "hints.seen": { value: ["gems"], ageMs: 60_000 } }, NOW).values["hints.seen"]).toEqual({ value: ["move", "gems"], at: NOW - 1_000 });
  });

  it("«показать подсказки заново» сбрасывает список, а усвоенное до сброса его не возвращает", () => {
    const stored: AccountSettingValues = { "hints.seen": { value: ["move", "gems"], at: NOW - 60_000 } };
    const reset = mergeSettings(stored, { "hints.seen": { value: [], ageMs: 1_000 } }, NOW).values;
    expect(reset["hints.seen"]).toEqual({ value: [], at: NOW - 1_000 });
    expect(mergeSettings(reset, { "hints.seen": { value: ["dodge"], ageMs: 30_000 } }, NOW).values["hints.seen"]).toEqual({ value: [], at: NOW - 1_000 });
    expect(mergeSettings(reset, { "hints.seen": { value: ["dodge"], ageMs: 100 } }, NOW).values["hints.seen"]).toEqual({ value: ["dodge"], at: NOW - 100 });
  });

  it("неизвестный ключ, значение не по схеме и запись без времени пропускаются и называются", () => {
    const { values, ignored } = mergeSettings(
      {},
      { "graphics.volume": { value: 50, ageMs: 1 }, "testing.enabled": { value: "да", ageMs: 1 }, "hints.seen": { value: ["Move!"], ageMs: 1 }, "combat.telegraphs": { value: true } },
      NOW,
    );
    expect(values).toEqual({});
    expect(ignored.sort()).toEqual(["combat.telegraphs", "graphics.volume", "hints.seen", "testing.enabled"]);
  });

  it("ключ с именем метода прототипа пропускается, а не роняет слияние", () => {
    const incoming = JSON.parse('{"constructor":{"value":true,"ageMs":1},"toString":{"value":true,"ageMs":1},"__proto__":{"value":true,"ageMs":1}}') as Record<string, { value: unknown; ageMs: number }>;
    const { values, ignored } = mergeSettings({}, incoming, NOW);
    expect(Object.keys(values)).toEqual([]);
    expect(ignored).toEqual(expect.arrayContaining(["constructor", "toString"]));
    expect(readStored(JSON.parse('{"constructor":{"value":true,"at":1}}'))).toEqual({});
  });

  it("битое в базе не роняет чтение: ключ, которого код больше не знает, пропускается", () => {
    expect(readStored({ "testing.enabled": { value: true, at: 5 }, "old.key": { value: 1, at: 1 }, "combat.telegraphs": { value: "x", at: 1 } })).toEqual({ "testing.enabled": { value: true, at: 5 } });
    expect(readStored("не объект")).toEqual({});
    expect(readStored(null)).toEqual({});
  });
});

class MemorySettings implements AccountSettingsRepository {
  row: StoredAccountSettings | null = null;
  async get(): Promise<StoredAccountSettings | null> {
    return this.row;
  }
  async update(_accountId: string, merge: (current: StoredAccountSettings | null) => { version: number; values: AccountSettingValues }) {
    const next = merge(this.row);
    this.row = next;
    return next;
  }
}

describe("настройки аккаунта в сервисе", () => {
  it("с ПК на телефон: выбранное на одном устройстве читает другое", async () => {
    const service = new AccountSettingsService(new MemorySettings());
    expect(await service.get(account)).toEqual({ version: 1, values: {} });
    await service.merge(account, { version: 1, values: { "combat.damageNumbers": { value: false, ageMs: 1000 } } }, NOW);
    expect((await service.get(account)).values["combat.damageNumbers"]).toEqual({ value: false, at: NOW - 1000 });
  });

  it("версия — самая новая из виденных: старый клиент её не откатывает", async () => {
    const repository = new MemorySettings();
    const service = new AccountSettingsService(repository);
    await service.merge(account, { version: 3, values: {} }, NOW);
    await service.merge(account, { version: 1, values: {} }, NOW);
    expect(repository.row?.version).toBe(3);
  });
});
