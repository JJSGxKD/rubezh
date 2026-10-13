import { describe, expect, it } from "vitest";
import { statusBadges } from "../src/screens/players/list-status";

// Бейджи столбца «Статус» в списке игроков (docs/35-stage4-plan.md WP32): пусто —
// значит у игрока нет ни блокировки, ни ограничений, и карточка не рисует подпись.

const kindTitle = (kind: string) => `<${kind}>`;
const BANNED = { at: "2026-10-01T00:00:00.000Z", reason: null };

describe("бейджи статуса игрока", () => {
  it("без блокировки и ограничений — пусто", () => {
    expect(statusBadges({ banned: null, restrictions: [] }, kindTitle)).toEqual([]);
  });

  it("блокировка без ограничений — один бейдж «заблокирован»", () => {
    expect(statusBadges({ banned: BANNED, restrictions: [] }, kindTitle)).toEqual([{ tone: "danger", text: "заблокирован" }]);
  });

  it("два вида ограничений без блокировки — один бейдж «закрыто» со всеми видами", () => {
    expect(statusBadges({ banned: null, restrictions: ["A", "B"] }, kindTitle)).toEqual([{ tone: "warning", text: "закрыто: <A>, <B>" }]);
  });

  it("блокировка и ограничения — два бейджа, первым «заблокирован»", () => {
    expect(statusBadges({ banned: BANNED, restrictions: ["A"] }, kindTitle)).toEqual([
      { tone: "danger", text: "заблокирован" },
      { tone: "warning", text: "закрыто: <A>" },
    ]);
  });

  it("вид «all» бейджем не рисуется — без блокировки пусто", () => {
    expect(statusBadges({ banned: null, restrictions: ["all"] }, kindTitle)).toEqual([]);
  });

  it("блокировка и «all» — только бейдж «заблокирован»", () => {
    expect(statusBadges({ banned: BANNED, restrictions: ["all"] }, kindTitle)).toEqual([{ tone: "danger", text: "заблокирован" }]);
  });
});
