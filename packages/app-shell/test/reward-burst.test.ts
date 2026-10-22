import { describe, expect, it } from "vitest";
import { burstVectors, COIN_BURST, mainResource } from "../src/screens/reward-burst-rules";

// Забор награды — событие, а не строка текста (design/art/ui-ux.md, U-16):
// значки вылетают веером из места награды и всплывает сумма.
describe("выброс монет при заборе", () => {
  it("веер вверх в обе стороны, одинаковый при каждом показе", () => {
    const burst = burstVectors(COIN_BURST.coins);
    expect(burst).toHaveLength(COIN_BURST.coins);
    expect(burstVectors(COIN_BURST.coins)).toEqual(burst);
    for (const coin of burst) expect(coin.y).toBeLessThan(-30);
    expect(burst.some((coin) => coin.x < -20)).toBe(true);
    expect(burst.some((coin) => coin.x > 20)).toBe(true);
  });

  it("монеты вылетают не пачкой, а за доли секунды, и выброс короче секунды", () => {
    const delays = new Set(burstVectors(COIN_BURST.coins).map((coin) => coin.delayMs));
    expect(delays.size).toBeGreaterThan(1);
    expect(Math.max(...delays) + COIN_BURST.flyMs).toBeLessThanOrEqual(1000);
  });
});

describe("чем выстреливает награда задания", () => {
  it("самоцветы ценнее монет, монеты — осколков: вылетает самое ценное", () => {
    expect(mainResource({ coins: 100, gems: 5, shards: 0 })).toEqual({ icon: "gem", amount: 5 });
    expect(mainResource({ coins: 100, gems: 0, shards: 3 })).toEqual({ icon: "coin", amount: 100 });
    expect(mainResource({ coins: 0, gems: 0, shards: 3 })).toEqual({ icon: "shard", amount: 3 });
  });

  it("пустая награда — без выброса", () => {
    expect(mainResource({ coins: 0, gems: 0, shards: 0 })).toBeNull();
  });
});
