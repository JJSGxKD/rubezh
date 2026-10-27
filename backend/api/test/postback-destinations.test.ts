import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NO_TOKEN_RECHECK_MIN, PAYMENT_CURRENCY } from "../src/modules/ad-conversions/conversion-rules.js";
import type { DueConversion } from "../src/modules/ad-conversions/conversions.repository.js";
import { AdsgramDestination } from "../src/modules/ad-conversions/destinations/adsgram.destination.js";
import { DESTINATION_KINDS, POSTBACK_DESTINATIONS } from "../src/modules/ad-conversions/destinations/destination.js";
import { TARGETS_CTE } from "../src/modules/ad-conversions/destinations/destination-targets.js";
import { EVENT_GOAL, POSTBACK_EVENTS, eventOfGoal } from "../src/modules/ad-conversions/postback-events.js";
import type { SecretDefinition } from "../src/modules/secrets/secret-catalog.js";
import type { SecretsReader } from "../src/modules/secrets/secrets.service.js";

/**
 * Слой «событие → назначение» постбэков (tasks/T-0069, docs/35-stage4-plan.md
 * Р86, Р96, WP43): коды событий, назначение AdsGram и точка, где проходу
 * сказано, кому что отправлять. Отправку, повторы и журнал проверяет
 * ad-conversions.test.ts, таблицу — ad-conversions.integration.test.ts.
 */

const TOKEN = "tok_abc12345";

function secretsWith(token: string | null): SecretsReader {
  return { get: (secret: SecretDefinition) => (secret.key === "adsgram.conversion-token" ? token : null) };
}

function due(patch: Partial<DueConversion> = {}): DueConversion {
  return {
    conversionId: "c1",
    destination: "adsgram",
    event: "registration",
    attempts: 0,
    params: { record: "7f3a1b6c", campaign: "55" },
    telegramId: "790807933",
    purchase: null,
    ...patch,
  };
}

describe("события постбэков", () => {
  it("код из базы — событие: 1, 2, 3 как goaltype AdsGram, 4 — возврат на следующий день", () => {
    expect(eventOfGoal(1)).toBe("registration");
    expect(eventOfGoal(2)).toBe("purchase_first");
    expect(eventOfGoal(3)).toBe("purchase_repeat");
    expect(eventOfGoal(4)).toBe("d1_return");
  });

  it("неизвестный код — ошибка, а не «регистрация»", () => {
    for (const goal of [0, 5, -1, 1.5, Number.NaN, 1_000]) {
      expect(() => eventOfGoal(goal), String(goal)).toThrow(/код события/);
    }
  });

  it("события и коды взаимно однозначны: каждый код читается обратно в то же событие", () => {
    expect([...POSTBACK_EVENTS]).toEqual(["registration", "purchase_first", "purchase_repeat", "d1_return"]);
    for (const event of POSTBACK_EVENTS) expect(eventOfGoal(EVENT_GOAL[event])).toBe(event);
    expect(new Set(Object.values(EVENT_GOAL)).size).toBe(POSTBACK_EVENTS.length);
  });

  it("назначения: AdsGram, S2S и партнёр; валюта платежа — звёзды без пересчёта", () => {
    expect([...DESTINATION_KINDS]).toEqual(["adsgram", "s2s", "partner"]);
    expect(typeof POSTBACK_DESTINATIONS).toBe("symbol");
    expect(PAYMENT_CURRENCY).toBe("XTR");
  });
});

describe("назначение AdsGram", () => {
  it("принимает три события, возврат на следующий день не получает никогда", () => {
    const destination = new AdsgramDestination(secretsWith(TOKEN));
    expect(destination.kind).toBe("adsgram");
    expect([...destination.accepts]).toEqual(["registration", "purchase_first", "purchase_repeat"]);
    expect(destination.accepts).not.toContain("d1_return");
  });

  it("токен и макросы есть — запрос с целью по событию; в лог адрес без токена", async () => {
    const destination = new AdsgramDestination(secretsWith(TOKEN));
    const goals: [DueConversion["event"], number][] = [
      ["registration", 1],
      ["purchase_first", 2],
      ["purchase_repeat", 3],
    ];
    for (const [event, goal] of goals) {
      const prepared = await destination.prepare(due({ event }));
      if (prepared.kind !== "request") throw new Error(`ждали запрос, получили ${prepared.kind}`);
      expect(prepared.url.toString()).toBe(`https://api.adsgram.ai/confirm_conversion?token=${TOKEN}&record=7f3a1b6c&goaltype=${String(goal)}`);
      expect(prepared.logUrl).toBe(`https://api.adsgram.ai/confirm_conversion?token=***&record=7f3a1b6c&goaltype=${String(goal)}`);
      expect(prepared.logUrl).not.toContain(TOKEN);
    }
  });

  it("сеть подставила только кампанию — вариант ссылок Telegram", async () => {
    const prepared = await new AdsgramDestination(secretsWith(TOKEN)).prepare(due({ params: { campaign: "55" } }));
    expect(prepared.kind === "request" ? prepared.url.toString() : prepared.kind).toBe(
      `https://api.adsgram.ai/confirm_conversion?token=${TOKEN}&tgid=790807933&campaignid=55&goaltype=1`,
    );
  });

  it("токена нет — ждать и проверить снова через пять минут, попытка не тратится", async () => {
    const prepared = await new AdsgramDestination(secretsWith(null)).prepare(due());
    expect(prepared).toEqual({ kind: "wait", reason: "no_token", recheckMin: NO_TOKEN_RECHECK_MIN });
    expect(NO_TOKEN_RECHECK_MIN).toBe(5);
  });

  it("токен есть, макросов нет — пропустить: сеть не узнает, чья это конверсия", async () => {
    const destination = new AdsgramDestination(secretsWith(TOKEN));
    expect(await destination.prepare(due({ params: null }))).toEqual({ kind: "skip", reason: "no_macros" });
    expect(await destination.prepare(due({ params: { campaign: "55" }, telegramId: null }))).toEqual({ kind: "skip", reason: "no_macros" });
  });

  it("токен идёт раньше макросов: без токена ждут даже конверсию без макросов", async () => {
    expect(await new AdsgramDestination(secretsWith(null)).prepare(due({ params: null }))).toMatchObject({ kind: "wait", reason: "no_token" });
  });

  it("событие, которого назначение не принимает, не уходит в сеть целью регистрации", async () => {
    const prepared = await new AdsgramDestination(secretsWith(TOKEN)).prepare(due({ event: "d1_return" }));
    expect(prepared).toEqual({ kind: "skip", reason: "unknown_network" });
  });
});

describe("кому и что отправлять", () => {
  it("ветка AdsGram отдаёт те события, что принимает назначение", () => {
    const arrays = [...TARGETS_CTE.sql.matchAll(/ARRAY\[([^\]]*)\]/g)];
    expect(arrays).toHaveLength(1);
    const events = [...(arrays[0]?.[1] ?? "").matchAll(/'([a-z_0-9]+)'/g)].map((match) => match[1]);
    expect(events).toEqual([...new AdsgramDestination(secretsWith(TOKEN)).accepts]);
    expect(TARGETS_CTE.sql).toContain("'adsgram'");
    expect(TARGETS_CTE.sql).toContain("-infinity");
  });

  it("CTE названа и устроена так, как её ждут запросы прохода: targets(link_code, destination, events, since)", () => {
    expect(TARGETS_CTE.sql.replace(/\s+/g, " ").trim()).toMatch(/^targets\(link_code, destination, events, since\) AS \(/);
    expect(TARGETS_CTE.values).toEqual([]);
  });

  it("сервис не знает про AdsGram: адрес и токен — дело назначения", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/modules/ad-conversions/conversions.service.ts", import.meta.url)), "utf8");
    expect(source).not.toContain("adsgramPostbackUrl");
    expect(source).not.toContain("SECRETS");
    expect(source).not.toContain("redacted(");
  });
});
