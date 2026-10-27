import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Место блока «юзернейм бота» на экране «Задания» (tasks/T-0337, Р167):
// один раз, между заголовком экрана и вкладками, без условий по вкладке.

const source = readFileSync(new URL("../src/screens/meta/tasks.tsx", import.meta.url), "utf8");
const at = source.indexOf("<BotMentionRows");

describe("блок «юзернейм бота» в tasks.tsx", () => {
  it("встречается ровно один раз", () => {
    expect(source.split("<BotMentionRows").length - 1).toBe(1);
  });

  it("стоит раньше вкладок и позже заголовка экрана", () => {
    expect(at).toBeGreaterThan(source.indexOf("<PageTitle"));
    expect(at).toBeLessThan(source.indexOf("<SegmentedControl"));
  });

  it("не зависит от вкладки и от загрузки списка", () => {
    const line = source.slice(source.lastIndexOf("\n", at) + 1, source.indexOf("\n", at));
    expect(line).not.toMatch(/view\s*===|state\.status/);
  });
});
