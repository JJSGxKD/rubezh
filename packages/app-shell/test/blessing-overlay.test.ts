import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BlessingDef } from "@bh/shared-types";
import { describe, expect, it, vi } from "vitest";
import { BlessingOverlay, blessingCards, blessingGains } from "../src/screens/run/BlessingOverlay";
import { t } from "../src/i18n";
import "../src/i18n/run";

// Окно «Выбери благословение» (docs/35-stage4-plan.md, Р153; tasks/T-0260): три
// карточки, как у выбора улучшения; выбор зовёт `chooseBlessing` с id, а
// прибавка читается строкой из модификатора.

/** Набор капища из `core-game/src/content/secrets.ts`: движок отдаёт оболочке именно такие определения. */
const ALL: readonly BlessingDef[] = [
  { id: "fury", nameKey: "blessing.fury", modifiers: { damage: 0.1 } },
  { id: "wind", nameKey: "blessing.wind", modifiers: { moveSpeed: 0.08 } },
  { id: "harvest", nameKey: "blessing.harvest", modifiers: { pickupRadius: 0.2 } },
  { id: "fortress", nameKey: "blessing.fortress", modifiers: { maxHp: 10 } },
  { id: "keen", nameKey: "blessing.keen", modifiers: { cooldown: 0.08 } },
  { id: "flame", nameKey: "blessing.flame", modifiers: { statusChance: 0.1 } },
];
const THREE: readonly BlessingDef[] = ALL.slice(0, 3);

describe("карточки благословений", () => {
  it("по карточке на предложение, в порядке движка; название — из словаря", () => {
    const cards = blessingCards(THREE, () => undefined);
    expect(cards.map((card) => card.id)).toEqual(THREE.map((blessing) => blessing.id));
    expect(cards.map((card) => card.title)).toEqual(["Ярость", "Ветер", "Жатва"]);
  });

  it("выбор карточки зовёт chooseBlessing с её id, один раз", () => {
    const choose = vi.fn();
    const cards = blessingCards(THREE, choose);

    cards[1]?.pick();

    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith(THREE[1]?.id);
  });

  it("прибавка — строкой из модификатора: долями в процентах, здоровье — числом", () => {
    expect(blessingGains({ damage: 0.1 })).toEqual(["Урон +10 %"]);
    expect(blessingGains({ moveSpeed: 0.08 })).toEqual(["Скорость бега +8 %"]);
    expect(blessingGains({ pickupRadius: 0.2 })).toEqual(["Радиус подбора +20 %"]);
    expect(blessingGains({ maxHp: 10 })).toEqual(["Здоровье +10"]);
    expect(blessingGains({ cooldown: 0.08 })).toEqual(["Скорость перезарядки +8 %"]);
  });

  it("благословение с несколькими прибавками — строка на каждую; пустой модификатор — без строк", () => {
    expect(blessingGains({ damage: 0.1, moveSpeed: 0.05 })).toEqual(["Урон +10 %", "Скорость бега +5 %"]);
    expect(blessingGains({})).toEqual([]);
  });

  it("весь набор контента читается: у каждого благословения есть название и хотя бы одна строка", () => {
    for (const blessing of ALL) {
      const card = blessingCards([blessing], () => undefined)[0];
      expect(card?.title, blessing.id).not.toBe(blessing.nameKey);
      expect(card?.gains.length, blessing.id).toBeGreaterThan(0);
    }
  });

  it("нечего предлагать — карточек нет", () => {
    expect(blessingCards([], () => undefined)).toEqual([]);
  });
});

describe("окно", () => {
  it("заголовок «Выбери благословение» и три названия в разметке", () => {
    const html = renderToStaticMarkup(createElement(BlessingOverlay, { options: THREE, onChoose: () => undefined }));
    expect(html).toContain(t("blessing.title"));
    expect(t("blessing.title")).toBe("Выбери благословение");
    for (const title of ["Ярость", "Ветер", "Жатва"]) expect(html).toContain(title);
    expect(html).toContain("Урон +10 %");
  });

  it("имена всех тайников и благословений заведены в словаре", () => {
    for (const kind of ["shrine", "hoard", "tree", "rift", "stone", "wisp"]) expect(t(`secret.${kind}.name`)).not.toBe(`secret.${kind}.name`);
    for (const id of ["fury", "wind", "harvest", "fortress", "keen", "flame"]) expect(t(`blessing.${id}`)).not.toBe(`blessing.${id}`);
  });
});
