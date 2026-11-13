import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENEMY_LOOKS, STALKER } from "@bh/core-game";
import { formatDuration, hasTranslation, t } from "../src/i18n";
// Словарь гайдбука приезжает вместе с его чанком — тест грузит его так же.
import "../src/i18n/guide";
import { eliteEnemies, regularEnemies, stalkerGuide, unkillableEnemies } from "../src/screens/guide/guide-data";
import { Enemies } from "../src/screens/guide/GuideScreen";

// Карачун в гайдбуке (tasks/T-0427, Р204, Р205): неубиваемый — отдельный блок после элиты, без строки статов.

describe("гайдбук: неубиваемые", () => {
  it("Карачун не среди обычных врагов и элиты, а в неубиваемых ровно один раз", () => {
    expect(regularEnemies().map((enemy) => enemy.def.id)).not.toContain("karachun");
    expect(eliteEnemies().map((enemy) => enemy.def.id)).not.toContain("karachun");
    expect(unkillableEnemies().filter((enemy) => enemy.def.id === "karachun")).toHaveLength(1);
  });

  it("знает все ключи текстов и подставляет время прихода из контента", () => {
    for (const key of ["guide.unkillable.title", "guide.unkillable.text", "guide.enemy.karachun.myth", "guide.enemy.karachun.when", "guide.enemy.karachun.omen"]) {
      expect(hasTranslation(key), key).toBe(true);
    }
    expect(stalkerGuide()).toEqual({ fromSec: STALKER.appear.fromSec });
    expect(formatDuration(STALKER.appear.fromSec)).toBe("4:00");
    expect(t("guide.enemy.karachun.when", { time: formatDuration(STALKER.appear.fromSec) })).toContain("после 4:00");
  });

  it("рисует блок после элиты: имя, миф и совет уходить", () => {
    const markup = renderToStaticMarkup(createElement(Enemies));
    expect(markup).toContain("Неубиваемые");
    expect(markup.indexOf("Неубиваемые")).toBeGreaterThan(markup.indexOf(t("guide.enemies.elite")));
    expect(markup).toContain("Карачун");
    expect(markup).toContain("Их нельзя убить — уходи");
    expect(markup).toContain("пришёл карачун");
  });

  it("фигура в блоке — «капюшон» цвета тела с канвы", () => {
    const markup = renderToStaticMarkup(createElement(Enemies));
    const block = markup.slice(markup.indexOf("Неубиваемые"));
    expect(ENEMY_LOOKS.stalker.shape).toBe("hood");
    expect(block).toContain(`fill="#${ENEMY_LOOKS.stalker.color.toString(16).padStart(6, "0")}"`);
    expect(block).toContain("<polygon");
  });
});
