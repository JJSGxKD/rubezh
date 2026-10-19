import { describe, expect, it } from "vitest";
import type { AdContinueStage } from "../src/state/ad-continue";
import { adButtonLook } from "../src/screens/run/ad-continue-look";

// Образцы стадий — те же, что в витрине компонентов (screens/gallery.tsx), но
// литералами: витрина тянет React-компоненты, которых в среде `node` нет.
const IDLE: AdContinueStage = { kind: "idle" };
const CHECKING: AdContinueStage = { kind: "checking" };
const READY: AdContinueStage = { kind: "ready", pass: false, notice: null };
const READY_VIP: AdContinueStage = { kind: "ready", pass: true, notice: null };
const WATCHING: AdContinueStage = { kind: "watching", pass: false };
const WATCHING_VIP: AdContinueStage = { kind: "watching", pass: true };
const CLOSED: AdContinueStage = { kind: "ready", pass: false, notice: "closed" };
const UNAVAILABLE: AdContinueStage = { kind: "unavailable", reason: "daily_cap" };

const NOT_LOCKED = { locked: false, wide: false };

describe("вид кнопки второго шанса за рекламу", () => {
  it("нет рекламы — кнопки нет", () => {
    expect(adButtonLook(UNAVAILABLE, NOT_LOCKED)).toBeNull();
  });

  it("ожидание — главная кнопка, неактивна", () => {
    expect(adButtonLook(IDLE, NOT_LOCKED)).toMatchObject({ variant: "primary", loading: false, disabled: true });
  });

  it("проверка рекламы — спиннер на главной кнопке", () => {
    expect(adButtonLook(CHECKING, NOT_LOCKED)).toMatchObject({ variant: "primary", loading: true, disabled: true });
  });

  it("ролик доступен, рядом со звёздами — короткая подпись", () => {
    expect(adButtonLook(READY, NOT_LOCKED)).toEqual({
      variant: "primary",
      loading: false,
      disabled: false,
      pass: false,
      labelKey: "run.continue.ad.short",
      ariaKey: "run.continue.ad",
    });
  });

  it("ролик доступен, кнопка одна — полная подпись", () => {
    expect(adButtonLook(READY, { locked: false, wide: true })).toMatchObject({ labelKey: "run.continue.ad" });
  });

  it("идёт покупка звёзд — кнопка ролика неактивна", () => {
    expect(adButtonLook(READY, { locked: true, wide: false })).toMatchObject({ loading: false, disabled: true });
  });

  it("после отказа показа кнопка снова активна", () => {
    expect(adButtonLook(CLOSED, NOT_LOCKED)).toMatchObject({ disabled: false });
  });

  it("VIP рядом со звёздами — корона и короткая подпись", () => {
    expect(adButtonLook(READY_VIP, NOT_LOCKED)).toEqual({
      variant: "primary",
      loading: false,
      disabled: false,
      pass: true,
      labelKey: "run.continue.vip.short",
      ariaKey: "run.continue.vip",
    });
  });

  it("VIP одна — полная подпись", () => {
    expect(adButtonLook(READY_VIP, { locked: false, wide: true })).toMatchObject({ labelKey: "run.continue.vip.wide" });
  });

  it("просмотр ролика — спиннер и неактивна, без VIP и с VIP", () => {
    expect(adButtonLook(WATCHING, NOT_LOCKED)).toMatchObject({ loading: true, disabled: true, pass: false });
    expect(adButtonLook(WATCHING_VIP, NOT_LOCKED)).toMatchObject({ loading: true, disabled: true, pass: true });
  });

  it("во всех стадиях, где кнопка есть, она главная", () => {
    const stages = [IDLE, CHECKING, READY, READY_VIP, WATCHING, WATCHING_VIP, CLOSED];
    for (const stage of stages) {
      expect(adButtonLook(stage, NOT_LOCKED)?.variant).toBe("primary");
    }
  });
});
