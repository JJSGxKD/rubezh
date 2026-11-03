import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEAPON_TITLES } from "../src/api/tasks";

// Панель не зависит от core-game, поэтому список оружия для фильтра заданий
// сверяем с контентом как с текстом: новое оружие без строки в панели должно
// уронить CI, а не молча пропасть из фильтра.

const WEAPONS_SRC = fileURLToPath(
  new URL(
    "../../../packages/core-game/src/content/weapons.ts",
    import.meta.url,
  ),
);
const RU_JSON = fileURLToPath(
  new URL("../../../packages/app-shell/src/i18n/ru.json", import.meta.url),
);

/** Записи оружия — блоки, которые начинаются строкой `  {` на верхнем уровне массива. */
function weaponBlocks(source: string): { id: string; evolved: boolean }[] {
  return source
    .split("\n  {\n")
    .slice(1)
    .map((block) => ({
      id: /^\s*id: "([a-z_]+)"/m.exec(block)?.[1] ?? "",
      evolved: /^\s*evolvedFrom:/m.test(block),
    }));
}

describe("оружие в панели совпадает с контентом", () => {
  const blocks = weaponBlocks(readFileSync(WEAPONS_SRC, "utf8"));
  const base = blocks
    .filter((block) => !block.evolved)
    .map((block) => block.id);
  const ru = JSON.parse(readFileSync(RU_JSON, "utf8")) as Record<
    string,
    string
  >;

  it("в контенте есть базовое оружие", () => {
    expect(base.length).toBeGreaterThan(0);
  });

  it("список фильтра содержит ровно базовое оружие: эволюции в него не входят", () => {
    const panel = Object.keys(WEAPON_TITLES);
    const missing = base.filter((id) => !panel.includes(id));
    const extra = panel.filter((id) => !base.includes(id));
    expect(
      missing,
      `нет в WEAPON_TITLES (apps/admin/src/api/tasks.ts): ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      extra,
      `лишние в WEAPON_TITLES (apps/admin/src/api/tasks.ts): ${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("название в панели — то же, что видит игрок", () => {
    for (const id of base) {
      const title = WEAPON_TITLES[id];
      const playerName = ru[`weapon.${id}.name`];
      expect(
        title,
        `название «${id}» в WEAPON_TITLES расходится с weapon.${id}.name`,
      ).toBe(playerName);
    }
  });
});
