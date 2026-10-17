import { describe, expect, it } from "vitest";
import { NodePool, POOL_DEFAULTS } from "../src/pool.js";

// Пул узлов: проверка здоровья и выбор. Время приходит аргументом.

const T0 = 1_000_000;
const { probeIntervalMs, retryAfterFailMs, maxBackoffMs } = POOL_DEFAULTS;

function pool(): NodePool {
  const created = new NodePool();
  created.sync(
    [
      { key: "aaa", country: "DE" },
      { key: "bbb", country: "NL" },
      { key: "ccc", country: null },
    ],
    T0,
  );
  return created;
}

function entry(source: NodePool, key: string) {
  const found = source.snapshot().find((item) => item.key === key);
  if (found === undefined) throw new Error(`нет узла ${key}`);
  return found;
}

describe("новые узлы", () => {
  it("unknown, в due сразу, в pick нет", () => {
    const source = pool();
    expect(entry(source, "aaa")).toMatchObject({ state: "unknown", failures: 0, latencyMs: null, lastProbeAt: null, nextProbeAt: T0 });
    expect(source.due(T0)).toEqual(["aaa", "bbb", "ccc"]);
    expect(source.pick({ limit: 10 })).toEqual([]);
  });

  it("due: только дошедшие до срока, по возрастанию срока, затем по ключу", () => {
    const source = pool();
    source.record("bbb", { ok: true, latencyMs: 100 }, T0);
    source.record("aaa", { ok: true, latencyMs: 100 }, T0 + 1000);
    expect(source.due(T0)).toEqual(["ccc"]);
    expect(source.due(T0 + probeIntervalMs)).toEqual(["ccc", "bbb"]);
    expect(source.due(T0 + 1000 + probeIntervalMs)).toEqual(["ccc", "bbb", "aaa"]);
  });
});

describe("успех", () => {
  it("healthy, отказы обнулены, следующая проверка через probeIntervalMs", () => {
    const source = pool();
    source.record("aaa", { ok: false }, T0);
    source.record("aaa", { ok: true, latencyMs: 200 }, T0 + 10);
    expect(entry(source, "aaa")).toMatchObject({ state: "healthy", failures: 0, latencyMs: 200, lastProbeAt: T0 + 10, nextProbeAt: T0 + 10 + probeIntervalMs });
    expect(source.pick({ limit: 5 })).toEqual(["aaa"]);
  });

  it("задержка — скользящее среднее: первая как есть, дальше alpha × новая + (1 − alpha) × прежняя", () => {
    const source = pool();
    source.record("aaa", { ok: true, latencyMs: 100 }, T0);
    source.record("aaa", { ok: true, latencyMs: 200 }, T0 + 1);
    expect(entry(source, "aaa").latencyMs).toBeCloseTo(0.3 * 200 + 0.7 * 100, 6);
  });

  it("свой alpha", () => {
    const source = new NodePool({ latencyAlpha: 1 });
    source.sync([{ key: "aaa", country: null }], T0);
    source.record("aaa", { ok: true, latencyMs: 100 }, T0);
    source.record("aaa", { ok: true, latencyMs: 400 }, T0 + 1);
    expect(entry(source, "aaa").latencyMs).toBe(400);
  });
});

describe("отказ", () => {
  it("первый отказ у здорового узла: состояние прежнее, повторная проверка через retryAfterFailMs", () => {
    const source = pool();
    source.record("aaa", { ok: true, latencyMs: 100 }, T0);
    source.record("aaa", { ok: false }, T0 + 5);
    expect(entry(source, "aaa")).toMatchObject({ state: "healthy", failures: 1, nextProbeAt: T0 + 5 + retryAfterFailMs });
    expect(source.pick({ limit: 5 })).toEqual(["aaa"]);
  });

  it("первый отказ у нового узла: остаётся unknown и в pick не попадает", () => {
    const source = pool();
    source.record("aaa", { ok: false }, T0);
    expect(entry(source, "aaa").state).toBe("unknown");
  });

  it("второй отказ — down, из pick ушёл, пауза — probeIntervalMs", () => {
    const source = pool();
    source.record("aaa", { ok: true, latencyMs: 100 }, T0);
    source.record("aaa", { ok: false }, T0 + 1);
    source.record("aaa", { ok: false }, T0 + 2);
    expect(entry(source, "aaa")).toMatchObject({ state: "down", failures: 2, nextProbeAt: T0 + 2 + probeIntervalMs });
    expect(source.pick({ limit: 5 })).toEqual([]);
  });

  it("серия отказов растит паузу вдвое до maxBackoffMs", () => {
    const source = pool();
    const pauses: number[] = [];
    let now = T0;
    for (let i = 0; i < 10; i++) {
      source.record("aaa", { ok: false }, now);
      const after = entry(source, "aaa");
      if (after.state === "down") pauses.push(after.nextProbeAt - now);
      now = after.nextProbeAt;
    }
    expect(pauses[0]).toBe(probeIntervalMs);
    expect(pauses[1]).toBe(probeIntervalMs * 2);
    expect(pauses[2]).toBe(probeIntervalMs * 4);
    expect(Math.max(...pauses)).toBe(maxBackoffMs);
    expect(pauses.at(-1)).toBe(maxBackoffMs);
  });

  it("успех после down возвращает узел в pick", () => {
    const source = pool();
    source.record("aaa", { ok: false }, T0);
    source.record("aaa", { ok: false }, T0 + 1);
    source.record("aaa", { ok: true, latencyMs: 80 }, T0 + 2);
    expect(entry(source, "aaa")).toMatchObject({ state: "healthy", failures: 0 });
    expect(source.pick({ limit: 5 })).toEqual(["aaa"]);
  });

  it("результат по неизвестному ключу ничего не делает", () => {
    const source = pool();
    expect(() => source.record("zzz", { ok: true, latencyMs: 1 }, T0)).not.toThrow();
    expect(source.snapshot()).toHaveLength(3);
  });
});

describe("выбор", () => {
  function healthy(): NodePool {
    const source = pool();
    source.record("aaa", { ok: true, latencyMs: 300 }, T0);
    source.record("bbb", { ok: true, latencyMs: 100 }, T0);
    source.record("ccc", { ok: true, latencyMs: 100 }, T0);
    return source;
  }

  it("порядок по задержке, при равной — по ключу; limit", () => {
    const source = healthy();
    expect(source.pick({ limit: 10 })).toEqual(["bbb", "ccc", "aaa"]);
    expect(source.pick({ limit: 2 })).toEqual(["bbb", "ccc"]);
    expect(source.pick({ limit: 0 })).toEqual([]);
  });

  it("countries: только узлы этой страны; узел без страны подходит лишь без фильтра", () => {
    const source = healthy();
    expect(source.pick({ countries: ["DE"], limit: 10 })).toEqual(["aaa"]);
    expect(source.pick({ countries: ["DE", "NL"], limit: 10 })).toEqual(["bbb", "aaa"]);
    expect(source.pick({ countries: ["FR"], limit: 10 })).toEqual([]);
    expect(source.pick({ limit: 10 })).toContain("ccc");
  });
});

describe("sync", () => {
  it("пропавшие забываются, оставшиеся сохраняют состояние, новые — unknown, страна обновляется", () => {
    const source = pool();
    source.record("aaa", { ok: true, latencyMs: 100 }, T0);
    source.sync(
      [
        { key: "aaa", country: "FR" },
        { key: "ddd", country: "US" },
      ],
      T0 + 50,
    );
    expect(source.snapshot().map((item) => item.key).sort()).toEqual(["aaa", "ddd"]);
    expect(entry(source, "aaa")).toMatchObject({ state: "healthy", latencyMs: 100, country: "FR" });
    expect(entry(source, "ddd")).toMatchObject({ state: "unknown", nextProbeAt: T0 + 50 });
  });
});

describe("снимок и восстановление", () => {
  it("snapshot → restore даёт тот же pick и тот же due", () => {
    const source = pool();
    source.record("aaa", { ok: true, latencyMs: 300 }, T0);
    source.record("bbb", { ok: true, latencyMs: 100 }, T0);
    source.record("ccc", { ok: false }, T0);

    const restored = new NodePool(undefined, source.snapshot());
    expect(restored.pick({ limit: 5 })).toEqual(source.pick({ limit: 5 }));
    expect(restored.due(T0 + 60_000)).toEqual(source.due(T0 + 60_000));
    expect(restored.snapshot()).toEqual(source.snapshot());
  });

  it("снимок — копия: правка его не меняет пул", () => {
    const source = pool();
    const snap = source.snapshot();
    snap[0] = { ...snap[0]!, state: "down" };
    expect(source.snapshot()[0]?.state).toBe("unknown");
  });
});
