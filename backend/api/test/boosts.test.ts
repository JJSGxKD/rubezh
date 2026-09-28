import { describe, expect, it } from "vitest";
import { BOOSTS, MAX_BOOSTS_PER_RUN as ENGINE_MAX_BOOSTS } from "../../../packages/core-game/src/content/boosts";
import { BOOST_IDS, BOOST_PRICES, MAX_BOOSTS_PER_RUN, priceOf } from "../src/modules/boosts/boost-catalog.js";
import { boostActivateSchema } from "../src/modules/boosts/dto/boosts.dto.js";
import { RunLoadouts } from "../src/modules/runs/run-loadouts.js";
import { EXCHANGE_RESOURCES } from "../src/modules/wallet/wallet-limits.js";

// Бусты на сервере (docs/35-stage4-plan.md §3.5, Р39): продаётся ровно то,
// что умеет движок, цена — целая и положительная, набор разбирается строго.
// Покупка и возврат — на живом Postgres, `boosts.integration.test.ts`.

describe("каталог бустов", () => {
  it("продаётся ровно то, что умеет движок, и потолок на забег у них один", () => {
    expect([...BOOST_IDS].sort()).toEqual(BOOSTS.map((boost) => boost.id).sort());
    expect(MAX_BOOSTS_PER_RUN).toBe(ENGINE_MAX_BOOSTS);
  });

  it("цены — целые больше нуля, в монетах или самоцветах; возврат — тем же, чем оплачено", () => {
    for (const price of Object.values(BOOST_PRICES)) {
      expect(Number.isInteger(price.amount) && price.amount > 0).toBe(true);
      expect(EXCHANGE_RESOURCES.boost_refund).toContain(price.resource);
    }
  });

  it("цена набора — по ресурсам; незнакомый буст — набор не продаётся", () => {
    expect(priceOf(["fury", "aegis", "head_start"])).toEqual({ coins: 270, gems: 4 });
    expect(priceOf(["fury", "nope"])).toBeNull();
  });

  it("набор: от одного до потолка, без повторов", () => {
    const runId = "run-00000001";
    expect(boostActivateSchema.safeParse({ runId, boosts: ["fury"] }).success).toBe(true);
    expect(boostActivateSchema.safeParse({ runId, boosts: [] }).success).toBe(false);
    expect(boostActivateSchema.safeParse({ runId, boosts: ["fury", "fury"] }).success).toBe(false);
    expect(boostActivateSchema.safeParse({ runId, boosts: ["fury", "aegis", "lure", "bulwark"] }).success).toBe(false);
  });
});

describe("сверка бустов в итоге забега", () => {
  it("забег без бустов к покупкам не ходит, а без проверки заявленным бустам не верят", async () => {
    const loadouts = new RunLoadouts();
    const asked: string[] = [];
    expect(await loadouts.checkBoosts("acc", "run-1", ["fury"])).toBe("unpaid");

    loadouts.provideBoosts({
      check: async (_accountId, runId) => {
        asked.push(runId);
        return "paid";
      },
    });
    expect(await loadouts.checkBoosts("acc", "run-1", [])).toBe("none");
    expect(asked).toEqual([]);
    expect(await loadouts.checkBoosts("acc", "run-2", ["fury"])).toBe("paid");
    expect(asked).toEqual(["run-2"]);
  });
});
