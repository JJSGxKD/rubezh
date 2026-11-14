import { describe, expect, it } from "vitest";
import { canCheckUserId } from "../src/modules/bot-mention/bot-mention-rules.js";
import { uniquePlatformUserId } from "./helpers/player-ids.js";

describe("уникальный platformUserId для тестов", () => {
  it("100 000 вызовов — без повторов", () => {
    const ids = Array.from({ length: 100_000 }, () => uniquePlatformUserId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("строка из 15 цифр без ведущего нуля: сервер пускает её к площадке, она укладывается в platform_user_id и не пересекается с короткими id тестов", () => {
    for (let i = 0; i < 1_000; i++) {
      const id = uniquePlatformUserId();
      expect(id).toMatch(/^[1-9]\d{14}$/u);
      expect(canCheckUserId(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(32);
    }
  });

  it("число без потерь: тот же id после Number и обратно — для площадок, где id читают числом", () => {
    for (let i = 0; i < 1_000; i++) {
      const id = uniquePlatformUserId();
      expect(Number.isSafeInteger(Number(id))).toBe(true);
      expect(String(Number(id))).toBe(id);
    }
  });
});
