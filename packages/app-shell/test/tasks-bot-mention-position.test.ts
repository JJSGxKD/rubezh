import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Место блока «юзернейм бота» на экране «Задания» (tasks/T-0337, Р167, Р185):
// один раз, сразу под вкладками и над их содержимым, без условий по вкладке.

const source = readFileSync(new URL("../src/screens/meta/tasks.tsx", import.meta.url), "utf8");
const at = source.indexOf("<BotMentionRows");

describe("блок «юзернейм бота» в tasks.tsx", () => {
  it("встречается ровно один раз", () => {
    expect(source.split("<BotMentionRows").length - 1).toBe(1);
  });

  it("стоит под вкладками и раньше содержимого вкладки", () => {
    expect(at).toBeGreaterThan(source.indexOf("<SegmentedControl"));
    expect(at).toBeLessThan(source.indexOf("<Achievements"));
    expect(at).toBeLessThan(source.indexOf("<ResetLine"));
  });

  it("не зависит от вкладки и от загрузки списка", () => {
    const line = source.slice(source.lastIndexOf("\n", at) + 1, source.indexOf("\n", at));
    expect(line).not.toMatch(/view\s*===|state\.status/);
  });
});
