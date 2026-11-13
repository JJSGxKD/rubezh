import { describe, expect, it } from "vitest";
import { friendsNotice } from "../src/screens/meta/rating-season";
import type { SeasonBoard } from "../src/state/seasons-api";

// Таблица друзей недели (T-0448, Р213): «нет друзей» — только когда их правда нет.

const entry = (isMe: boolean) => ({ isMe }) as SeasonBoard["entries"][number];
const board = (extra: Partial<SeasonBoard>): SeasonBoard => ({ seasonKey: "2026-11-02", difficulty: "hard", total: 1, entries: [entry(true)], me: null, ...extra });

describe("friendsNotice", () => {
  it("друзья есть, в таблице только я: idle", () => {
    expect(friendsNotice(board({ friendCount: 2 }))).toBe("idle");
  });

  it("друзья есть, таблица пуста: idle", () => {
    expect(friendsNotice(board({ friendCount: 2, entries: [] }))).toBe("idle");
  });

  it("друзей нет: none", () => {
    expect(friendsNotice(board({ friendCount: 0 }))).toBe("none");
  });

  it("поля нет (старый сервер), в таблице только я: none", () => {
    expect(friendsNotice(board({}))).toBe("none");
  });

  it("в таблице есть друг: без блока", () => {
    expect(friendsNotice(board({ friendCount: 1, entries: [entry(true), entry(false)] }))).toBeNull();
  });
});
