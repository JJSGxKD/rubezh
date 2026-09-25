import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/ports/clock.js";
import { MemoryRateCache } from "../src/ports/cache.js";
import { MemoryLock } from "../src/ports/lock.js";
import { MemoryRateStore } from "../src/ports/memory-store.js";
import { describeRateStoreContract } from "./contracts/rate-store.contract.js";

describeRateStoreContract("память", () => new MemoryRateStore());

describe("кеш в памяти", () => {
  it("забывает значение по сроку жизни", async () => {
    const clock = new FixedClock(1000);
    const cache = new MemoryRateCache(clock);
    await cache.set("k", "v", 500);
    expect(await cache.get("k")).toBe("v");
    clock.advance(499);
    expect(await cache.get("k")).toBe("v");
    clock.advance(1);
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", "v2", 500);
    await cache.delete("k");
    expect(await cache.get("k")).toBeNull();
  });
});

describe("лок в памяти", () => {
  it("не пускает второго, пока первый держит, и считает просроченный потерянным", async () => {
    const clock = new FixedClock(0);
    const lock = new MemoryLock(() => clock.now());
    let heldInside: boolean | null = null;

    const first = lock.withLock("k", 1000, async (held) => {
      const second = await lock.withLock("k", 1000, async () => "второй");
      expect(second.acquired).toBe(false);
      heldInside = held();
      clock.advance(1001);
      return held();
    });
    const outcome = await first;
    expect(outcome).toEqual({ acquired: true, result: false });
    expect(heldInside).toBe(true);

    const after = await lock.withLock("k", 1000, async () => "снова");
    expect(after).toEqual({ acquired: true, result: "снова" });
  });
});
