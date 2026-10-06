import type { AdCreative } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { readyCreative, secondsLeft, showCreative } from "../src/ads/ad-creative";
import { hasTranslation, t } from "../src/i18n";

/**
 * Наш рекламный блок (docs/35-stage4-plan.md WP12, часть 9): отсчёт по
 * часам, картинки — заранее, объявление без того, что показать, — отказ.
 * Сам блок проверяется глазами в витрине компонентов.
 */

const AD: AdCreative = {
  id: "taddy-ad-1",
  title: "Рубеж держит",
  description: null,
  text: "Текст",
  image: "https://cdn.example/ad.png",
  icon: "https://cdn.example/icon.png",
  button: null,
  link: "https://t.me/example_bot?start=taddy",
  advertiser: "Taddy",
};

describe("рекламный блок", () => {
  it("отсчёт — целыми секундами вверх, по часам: «1» до самого конца, ушёл и вернулся — время шло", () => {
    expect(secondsLeft(0, 10, 0)).toBe(10);
    expect(secondsLeft(0, 10, 9_001)).toBe(1);
    expect(secondsLeft(0, 10, 10_000)).toBe(0);
    expect(secondsLeft(0, 10, 60_000)).toBe(0);
  });

  it("картинки грузятся заранее; не пришла — блок без неё, если есть заголовок", async () => {
    const loaded = await readyCreative(AD, async () => true);
    expect(loaded).toEqual(AD);
    const noIcon = await readyCreative(AD, async (url: string) => url === AD.image);
    expect(noIcon).toEqual({ ...AD, icon: null });
    expect(await readyCreative(AD, async () => false)).toEqual({ ...AD, image: null, icon: null });
  });

  it("без заголовка и без картинки показывать нечего — отказ, а не пустая рамка", async () => {
    expect(await readyCreative({ ...AD, title: null }, async () => false)).toBeNull();
    expect(await readyCreative({ ...AD, title: null, image: null, icon: null }, async () => true)).toBeNull();
  });

  it("срок подготовки вышел ещё до картинок — отказ «не успел», блок не появляется", async () => {
    const hooks = { onShown: () => undefined, onClick: () => undefined };
    expect(await showCreative({ ad: AD, viewSec: 5, rewarded: false, readyWithinMs: 0 }, hooks)).toEqual({ kind: "failed", reason: "late" });
    expect(await showCreative({ ad: AD, viewSec: 5, rewarded: false, readyWithinMs: -40 }, hooks)).toEqual({ kind: "failed", reason: "late" });
  });

  it("подписи блока — в его чанке, первая загрузка за них не платит", async () => {
    // Модуль блока уже подгрузил свой словарь — ключ на месте и подставляет сеть.
    expect(hasTranslation("ads.label")).toBe(true);
    expect(t("ads.label", { advertiser: "Taddy" })).toBe("Реклама · Taddy");
    expect(t("ads.rewardIn", { seconds: 7 })).toBe("Досмотрите — награда через 7 с");
  });
});
