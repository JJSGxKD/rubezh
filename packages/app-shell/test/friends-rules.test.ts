import { describe, expect, it } from "vitest";
import { bonusTrack, friendsLayout, giftAllCount } from "../src/screens/meta/friends-rules";

// Правила экрана друзей (tasks/T-0048): кому подарит «Подарить всем», как
// заливается полоса бонуса и что стоит на экране первым.

const STEPS = [1, 3, 5, 10, 20].map((friends) => ({ friends }));

describe("«Подарить всем»", () => {
  it("дарит друзьям, которым сегодня ещё не дарили", () => {
    expect(giftAllCount(["a", "b", "c", "d"], ["b"])).toBe(3);
  });

  it("всем подарено — ноль, друзей нет — тоже ноль", () => {
    expect(giftAllCount(["a", "b"], ["a", "b"])).toBe(0);
    expect(giftAllCount([], [])).toBe(0);
  });

  it("подарок тому, кого в друзьях уже нет, счёт не меняет", () => {
    expect(giftAllCount(["a"], ["a", "ушедший"])).toBe(0);
    expect(giftAllCount(["a", "b"], ["ушедший"])).toBe(2);
  });
});

describe("полоса бонуса", () => {
  it("никого не засчитано — пустая полоса, до первого шага один друг", () => {
    expect(bonusTrack(0, STEPS)).toEqual({ fill: 0, next: 1, left: 1 });
  });

  it("шаги равными промежутками: между третьим и пятым — на половине", () => {
    expect(bonusTrack(4, STEPS)).toEqual({ fill: (1 + 0.5) / 4, next: 5, left: 1 });
  });

  it("ровно на шаге — полоса до него, следующий — через промежуток", () => {
    expect(bonusTrack(5, STEPS)).toEqual({ fill: 0.5, next: 10, left: 5 });
    expect(bonusTrack(1, STEPS)).toEqual({ fill: 0, next: 3, left: 2 });
  });

  it("все пройдены — полная, следующего нет", () => {
    expect(bonusTrack(20, STEPS)).toEqual({ fill: 1, next: null, left: null });
    expect(bonusTrack(25, STEPS)).toEqual({ fill: 1, next: null, left: null });
  });

  it("шагов нет или один — без деления на ноль", () => {
    expect(bonusTrack(3, [])).toEqual({ fill: 0, next: null, left: null });
    expect(bonusTrack(0, [{ friends: 2 }])).toEqual({ fill: 0, next: 2, left: 2 });
    expect(bonusTrack(2, [{ friends: 2 }])).toEqual({ fill: 1, next: null, left: null });
  });
});

describe("порядок экрана", () => {
  it("друзей нет — приглашение первым, друзья есть — список", () => {
    expect(friendsLayout(0)).toBe("invite-first");
    expect(friendsLayout(1)).toBe("list-first");
  });
});
