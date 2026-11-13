import { describe, expect, it } from "vitest";
import type { UpgradeOption } from "@bh/shared-types";
import { adRerollButton, cardTapAction, toolButtons } from "../src/screens/run/card-tools-rules";
import { boostIcon } from "../src/screens/boost-icons";
import ruBoosts from "../src/i18n/ru-boosts.json";
import ruRun from "../src/i18n/ru-run.json";

// Ряд действий на выборе улучшения (tasks/T-0101): какие кнопки есть, какие
// серые и что делает тап по карточке. Вся логика — чистые функции.

const option = (kind: UpgradeOption["kind"], id = `${kind}:x:1`): UpgradeOption => ({
  id,
  kind,
  refId: kind === "heal" ? "" : "x",
  level: 1,
  nameKey: "n",
  descriptionKey: "d",
  changes: [],
});

const cards = [option("weapon_new"), option("passive_new"), option("weapon_level")];
const heal = [option("heal", "heal")];
const tools = (reroll: number, skip: number, banish: number) => ({ reroll, skip, banish });

describe("кнопки действий", () => {
  it("вида, которого нет за весь забег, нет и в ряду", () => {
    expect(toolButtons({ left: tools(0, 0, 0), total: tools(0, 0, 0), canReroll: true, offers: cards })).toEqual([]);
    expect(toolButtons({ left: tools(1, 0, 0), total: tools(1, 0, 0), canReroll: true, offers: cards }).map((button) => button.id)).toEqual(["reroll"]);
  });

  it("порядок — переброс, пропуск, изгнание, со счётчиком остатка", () => {
    const buttons = toolButtons({ left: tools(2, 1, 1), total: tools(3, 1, 2), canReroll: true, offers: cards });
    expect(buttons).toEqual([
      { id: "reroll", left: 2, disabled: false },
      { id: "skip", left: 1, disabled: false },
      { id: "banish", left: 1, disabled: false },
    ]);
  });

  it("заряды кончились — кнопка остаётся серой «0», а не пропадает", () => {
    const buttons = toolButtons({ left: tools(0, 1, 1), total: tools(2, 1, 1), canReroll: true, offers: cards });
    expect(buttons[0]).toEqual({ id: "reroll", left: 0, disabled: true });
    expect(buttons[1].disabled).toBe(false);
  });

  it("нет альтернатив — отключён только переброс", () => {
    const buttons = toolButtons({ left: tools(2, 1, 1), total: tools(2, 1, 1), canReroll: false, offers: cards });
    expect(buttons.map((button) => button.disabled)).toEqual([true, false, false]);
  });

  it("все карточки — лечение: переброс и изгнание отключены, пропуск доступен", () => {
    const buttons = toolButtons({ left: tools(2, 1, 1), total: tools(2, 1, 1), canReroll: true, offers: heal });
    expect(buttons.map((button) => button.disabled)).toEqual([true, false, true]);
  });

  it("лечение среди обычных карточек изгнание не отключает", () => {
    const mixed = [option("weapon_new"), option("heal", "heal")];
    const buttons = toolButtons({ left: tools(0, 0, 1), total: tools(0, 0, 1), canReroll: true, offers: mixed });
    expect(buttons).toEqual([{ id: "banish", left: 1, disabled: false }]);
  });

  it("нет карточек вовсе (пропуск уже сработал) — всё отключено", () => {
    const buttons = toolButtons({ left: tools(1, 1, 1), total: tools(1, 1, 1), canReroll: true, offers: [] });
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });
});

describe("кнопка переброса за рекламу (tasks/T-0199)", () => {
  const ready = { kind: "ready", pass: false } as const;
  const base = { left: tools(0, 0, 0), canAdReroll: true, stage: ready, banishing: false };

  it("зарядов переброса нет, движок обещает переброс, стадия готова — кнопка есть; у VIP — с пометкой пропуска", () => {
    expect(adRerollButton(base)).toEqual({ kind: "ready", pass: false });
    expect(adRerollButton({ ...base, stage: { kind: "ready", pass: true } })).toEqual({ kind: "ready", pass: true });
    // Заряды пропуска и изгнания кнопку не прячут: прячет только заряд переброса.
    expect(adRerollButton({ ...base, left: tools(0, 2, 1) })).toEqual({ kind: "ready", pass: false });
  });

  it("пока идёт ролик — кнопка занята", () => {
    expect(adRerollButton({ ...base, stage: { kind: "watching", pass: false } })).toEqual({ kind: "busy" });
    expect(adRerollButton({ ...base, stage: { kind: "watching", pass: true } })).toEqual({ kind: "busy" });
  });

  it("есть заряд переброса, движок не обещает переброса, режим изгнания, стадии idle, checking и gone — кнопки нет", () => {
    expect(adRerollButton({ ...base, left: tools(1, 0, 0) })).toEqual({ kind: "hidden" });
    expect(adRerollButton({ ...base, canAdReroll: false })).toEqual({ kind: "hidden" });
    expect(adRerollButton({ ...base, banishing: true })).toEqual({ kind: "hidden" });
    for (const kind of ["idle", "checking", "gone"] as const) expect(adRerollButton({ ...base, stage: { kind } }), kind).toEqual({ kind: "hidden" });
    // Идёт ролик, а режим изгнания включён: кнопки в режиме изгнания нет и тогда.
    expect(adRerollButton({ ...base, stage: { kind: "watching", pass: false }, banishing: true })).toEqual({ kind: "hidden" });
  });
});

describe("тап по карточке", () => {
  it("обычный режим — выбор", () => {
    expect(cardTapAction("choose", option("weapon_new"))).toBe("choose");
    expect(cardTapAction("choose", option("heal", "heal"))).toBe("choose");
  });

  it("режим изгнания — изгнание предмета, лечение не реагирует", () => {
    expect(cardTapAction("banish", option("passive_new"))).toBe("banish");
    expect(cardTapAction("banish", option("weapon_level"))).toBe("banish");
    expect(cardTapAction("banish", option("heal", "heal"))).toBe("ignore");
  });
});

describe("тексты и значок", () => {
  it("ключи действий и буста есть в словарях", () => {
    for (const key of [
      "run.tools.reroll",
      "run.tools.skip",
      "run.tools.banish",
      "run.tools.banish.hint",
      "run.tools.banish.cancel",
      "run.tools.caption",
      "run.tools.left",
      "run.tools.rerollAd",
      "run.tools.rerollAd.short",
      "run.tools.rerollAd.pass",
      "run.tools.rerollAd.pass.short",
      "run.tools.rerollAd.once",
      "run.tools.rerollAd.notice.closed",
      "run.tools.rerollAd.notice.failed",
      "run.tools.rerollAd.notice.claim_failed",
      "run.tools.rerollAd.notice.restricted",
    ]) {
      expect(ruRun, key).toHaveProperty([key]);
    }
    expect(ruBoosts).toHaveProperty(["boost.control.name"], "Контроль");
    expect(ruBoosts).toHaveProperty(["boost.control.description"]);
  });

  it("у «Контроля» свой значок, а не общий", () => {
    expect(boostIcon("control")).not.toBe(boostIcon("нет-такого-буста"));
  });
});
