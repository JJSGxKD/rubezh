import { describe, expect, it } from "vitest";
import { uniquePlatformUserId } from "./helpers/player-ids.js";

describe("уникальный platformUserId для тестов", () => {
  it("100 000 вызовов — без повторов", () => {
    const ids = Array.from({ length: 100_000 }, () => uniquePlatformUserId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("строка из 16 цифр без ведущего нуля: укладывается в platform_user_id и не пересекается с короткими id тестов", () => {
    for (let i = 0; i < 1_000; i++) {
      const id = uniquePlatformUserId();
      expect(id).toMatch(/^[1-9]\d{15}$/u);
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
