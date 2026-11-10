import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Место блока «юзернейм бота» на экране «Задания» (tasks/T-0373, Р186): один
// раз, только на вкладке «День», после вкладок и раньше «Обновятся через …».

const source = readFileSync(new URL("../src/screens/meta/tasks.tsx", import.meta.url), "utf8");
const at = source.indexOf("<BotMentionRows");

describe("блок «юзернейм бота» в tasks.tsx", () => {
  it("встречается ровно один раз", () => {
    expect(source.split("<BotMentionRows").length - 1).toBe(1);
  });

  it("стоит под вкладками и раньше строки «Обновятся через …»", () => {
    expect(at).toBeGreaterThan(source.indexOf("<SegmentedControl"));
    expect(at).toBeLessThan(source.indexOf("<ResetLine"));
  });

  it("рисуется только на вкладке «День»", () => {
    const line = source.slice(source.lastIndexOf("\n", at) + 1, source.indexOf("\n", at));
    expect(line).toMatch(/view\s*===\s*"daily"/);
  });
});
