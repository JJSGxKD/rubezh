import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UpgradeChange, UpgradeOption } from "@bh/shared-types";
import { LIMITS } from "@bh/core-game";
import { hasTranslation, t } from "../src/i18n";
import "../src/i18n/run";
import "../src/i18n/guide";
import { ItemMedallion, ItemTile } from "../src/screens/item-icons";
import { kindOf } from "../src/screens/run/overlays";
import { cardTapAction, toolButtons } from "../src/screens/run/card-tools-rules";
import { formatChange } from "../src/screens/run/upgrade-format";

// Карточка «Предела» (tasks/T-0194): тексты, числа «было → стало», значок
// и то, что изгнать её нельзя.

const change = (patch: Partial<UpgradeChange>): UpgradeChange => ({
  labelKey: "x",
  from: null,
  to: 1,
  format: "value",
  lowerIsBetter: false,
  ...patch,
});

const limitOption = (id = "damage"): UpgradeOption => ({
  id: `limit:${id}`,
  kind: "limit",
  refId: id,
  level: 1,
  nameKey: `upgrade.limit.${id}.name`,
  descriptionKey: `upgrade.limit.${id}.description`,
  changes: [],
});

describe("тексты «Предела»", () => {
  it("у каждой записи контента есть название и описание", () => {
    expect(LIMITS.length).toBeGreaterThan(0);
    for (const def of LIMITS) {
      expect(hasTranslation(`upgrade.limit.${def.id}.name`), `${def.id}.name`).toBe(true);
      expect(hasTranslation(`upgrade.limit.${def.id}.description`), `${def.id}.description`).toBe(true);
      expect(t(def.nameKey)).toMatch(/^Предел: /);
    }
  });

  it("подпись параметра на карточке — та же, что у навыков", () => {
    for (const def of LIMITS) {
      const key = `upgrade.stat.passive.${def.stat}`;
      expect(hasTranslation(key), key).toBe(true);
    }
  });

  it("метка карточки в выборе уровня переведена", () => {
    expect(hasTranslation("run.levelUp.limit")).toBe(true);
    expect(t("run.levelUp.limit")).toBe("Предел");
  });
});

describe("числа на карточке «Предела»", () => {
  it("урон, площадь, скорость, притяжение: «+3%», перезарядка: «−2%»", () => {
    expect(formatChange(change({ from: 1, to: 1.03, format: "percent" }))).toEqual({ from: "0%", to: "+3%", better: true });
    expect(formatChange(change({ from: 1.06, to: 1.09, format: "percent" }))).toEqual({ from: "+6%", to: "+9%", better: true });
    expect(formatChange(change({ from: 1, to: 0.98, format: "percent", lowerIsBetter: true }))).toEqual({
      from: "0%",
      to: "−2%",
      better: true,
    });
  });

  it("здоровье «+10» и восстановление «+0,1»", () => {
    expect(formatChange(change({ from: 0, to: 10, format: "plus" }))).toEqual({ from: "0", to: "+10", better: true });
    expect(formatChange(change({ from: 0, to: 0.1, format: "plus" }))).toEqual({ from: "0", to: "+0,1", better: true });
  });
});

describe("вид карточки «Предела»", () => {
  it("kindOf отдаёт отдельный вид, а не пассивку", () => {
    expect(kindOf(limitOption())).toBe("limit");
    expect(kindOf({ ...limitOption(), kind: "heal" })).toBe("heal");
    expect(kindOf({ ...limitOption(), kind: "passive_new" })).toBe("passive");
  });

  it("значок — своя плитка и медальон с тоном info, не пассивка", () => {
    const tile = renderToStaticMarkup(createElement(ItemTile, { kind: "limit", id: "damage" }));
    expect(tile).toContain("bg-info/15");
    expect(tile).toContain("<svg");
    const medallion = renderToStaticMarkup(createElement(ItemMedallion, { kind: "limit", id: "damage" }));
    expect(medallion).toContain("ring-info");
    expect(medallion).not.toContain("ring-passive");
  });
});

describe("изгнание и «Предел»", () => {
  const tools = { reroll: 1, skip: 1, banish: 1 };

  it("тап по карточке «Предела» в режиме изгнания ничего не делает", () => {
    expect(cardTapAction("banish", limitOption())).toBe("ignore");
    expect(cardTapAction("choose", limitOption())).toBe("choose");
  });

  it("на одних карточках «Предела» изгнание и переброс серые, пропуск доступен", () => {
    const buttons = toolButtons({ left: tools, total: tools, canReroll: false, offers: [limitOption("damage"), limitOption("area")] });
    expect(buttons.map((button) => [button.id, button.disabled])).toEqual([
      ["reroll", true],
      ["skip", false],
      ["banish", true],
    ]);
  });
});

describe("рендер значка", () => {
  it("«Предел» без своего id в таблице значков получает значок, а не пустоту", () => {
    const markup = renderToStaticMarkup(createElement(ItemMedallion, { kind: "limit", id: "no_such_limit" }));
    expect(markup).toContain("<svg");
  });
});
