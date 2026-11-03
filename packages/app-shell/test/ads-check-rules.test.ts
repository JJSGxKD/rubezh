import { describe, expect, it } from "vitest";
import "../src/i18n/team";
import {
  adsCheckView,
  groupCatalog,
  outcomeLabel,
  showRequestOf,
  testResultOf,
  testedEventOf,
  type AdsCheckBlock,
  type AdsCheckNetwork,
} from "../src/screens/ads-check-rules";

// Проверка рекламы командой (tasks/T-0334, Р165): чистые правила экрана —
// запрос показа, исход строкой, тело отчёта и событие, группы каталога.

const NETWORK: AdsCheckNetwork = { network: "adsgram", name: "AdsGram", active: true, keys: { pubId: "1" }, formats: ["rewarded", "interstitial"] };
const block = (patch: Partial<AdsCheckBlock> = {}): AdsCheckBlock => ({
  blockId: "b1",
  network: "adsgram",
  place: "wheel_spin",
  format: "rewarded",
  externalId: "123",
  active: true,
  platforms: ["telegram"],
  ...patch,
});

describe("исход строкой", () => {
  it("секунды с одним знаком, причина — кодом как есть", () => {
    expect(outcomeLabel({ kind: "completed" }, 14_200)).toBe("Досмотрел · 14,2 с");
    expect(outcomeLabel({ kind: "closed" }, 3000)).toBe("Закрыл · 3,0 с");
    expect(outcomeLabel({ kind: "failed", reason: "no_fill" }, 800)).toBe("Нет рекламы · 0,8 с");
    expect(outcomeLabel({ kind: "failed", reason: "sdk_error" }, 3100)).toBe("Ошибка: sdk_error · 3,1 с");
    expect(outcomeLabel({ kind: "failed", reason: "busy" }, 0)).toBe("Ошибка: busy · 0,0 с");
  });
});

describe("запрос показа", () => {
  it("тестовый — debug, боевой — без; блок сети и ключи берутся из каталога", () => {
    expect(showRequestOf(block(), NETWORK, { live: false, startLike: false })).toEqual({ network: "adsgram", blockId: "123", format: "rewarded", keys: { pubId: "1" }, debug: true });
    expect(showRequestOf(block(), NETWORK, { live: true, startLike: false }).debug).toBe(false);
    expect(showRequestOf(block({ externalId: null }), NETWORK, { live: false, startLike: false }).blockId).toBeNull();
  });

  it("readyWithinMs — только у межстраничной при галочке; иначе ключа нет вовсе", () => {
    const interstitial = block({ format: "interstitial" });
    expect(showRequestOf(interstitial, NETWORK, { live: false, startLike: true }).readyWithinMs).toBe(2000);
    expect("readyWithinMs" in showRequestOf(interstitial, NETWORK, { live: false, startLike: false })).toBe(false);
    expect("readyWithinMs" in showRequestOf(block(), NETWORK, { live: false, startLike: true })).toBe(false);
  });
});

describe("отчёт и событие", () => {
  it("причина — только у отказа, без ключа у остальных", () => {
    const ok = testResultOf(block(), { kind: "completed" }, false, 900);
    expect(ok).toEqual({ network: "adsgram", format: "rewarded", blockId: "b1", live: false, outcome: "completed", ms: 900 });
    expect("reason" in ok).toBe(false);
    expect(testResultOf(block(), { kind: "failed", reason: "no_fill" }, true, 900)).toMatchObject({ outcome: "failed", reason: "no_fill", live: true });
    expect("reason" in testedEventOf(block(), { kind: "closed" }, false, 5)).toBe(false);
    expect(testedEventOf(block(), { kind: "failed", reason: "late" }, false, 5)).toEqual({ network: "adsgram", format: "rewarded", live: false, outcome: "failed", reason: "late", ms: 5 });
  });

  it("ms округляется и зажимается в 0…600000", () => {
    expect(testResultOf(block(), { kind: "closed" }, false, 700_000).ms).toBe(600_000);
    expect(testResultOf(block(), { kind: "closed" }, false, -5).ms).toBe(0);
    expect(testResultOf(block(), { kind: "closed" }, false, 1234.6).ms).toBe(1235);
    expect(testedEventOf(block(), { kind: "closed" }, false, 700_000)["ms"]).toBe(600_000);
  });
});

describe("группы каталога", () => {
  it("порядок сетей как в ответе, блоки по месту и id; блок без сети пропущен, пустая сеть и выключенные остаются", () => {
    const sonar: AdsCheckNetwork = { ...NETWORK, network: "adsonar", name: "AdSonar", active: false };
    const empty: AdsCheckNetwork = { ...NETWORK, network: "richads", name: "RichAds" };
    const groups = groupCatalog(
      [sonar, NETWORK, empty],
      [block({ blockId: "z", place: "wheel_spin" }), block({ blockId: "a", place: "wheel_spin" }), block({ blockId: "m", place: "second_chance" }), block({ blockId: "s", network: "adsonar", active: false }), block({ blockId: "x", network: "unknown" })],
    );
    expect(groups.map((group) => group.network.network)).toEqual(["adsonar", "adsgram", "richads"]);
    expect(groups[0]?.blocks.map((item) => item.blockId)).toEqual(["s"]);
    expect(groups[1]?.blocks.map((item) => item.blockId)).toEqual(["m", "a", "z"]);
    expect(groups[2]?.blocks).toEqual([]);
  });
});

describe("вид экрана", () => {
  it("права, потом площадка, потом состояние каталога", () => {
    expect(adsCheckView(false, true, "ready")).toBe("denied");
    expect(adsCheckView(true, false, "ready")).toBe("unsupported");
    for (const load of ["loading", "error", "empty", "ready"] as const) expect(adsCheckView(true, true, load)).toBe(load);
  });
});
