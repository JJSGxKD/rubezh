import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LeaderboardEntry } from "@bh/shared-types";
import { LeaderboardRow } from "../src/screens/meta/rating";
import { leaderboardSchema } from "../src/state/runs-api";

// Значок «Рубеж взят» у имени в основной доске (tasks/T-0124): по флагу
// `rubezh` из ответа сервера, а не по догадке клиента.

const ENTRY: LeaderboardEntry = {
  rank: 3,
  name: "Мира",
  photoUrl: null,
  survivalSec: 700,
  level: 12,
  startingWeaponId: "spark",
  enemiesKilled: 900,
  isMe: false,
};

const row = (patch: Partial<LeaderboardEntry> = {}): string =>
  renderToStaticMarkup(createElement(LeaderboardRow, { entry: { ...ENTRY, ...patch }, index: 0 }));

describe("значок рубежа в рейтинге", () => {
  it("у строки с флагом — значок с подсказкой «Взял рубеж» и словами для скринридера", () => {
    const html = row({ rubezh: true });
    expect(html).toContain('title="Взял рубеж"');
    expect(html).toContain("Рубеж взят");
  });

  it("без флага значка нет", () => {
    const html = row();
    expect(html).not.toContain("Взял рубеж");
    expect(html).not.toContain("Рубеж взят");
  });

  it("значок не вытесняет имя и остальные метки", () => {
    const html = row({ rubezh: true, tester: true, prestige: 40, isMe: true });
    expect(html).toContain("Мира");
    expect(html).toContain("Тестер");
    expect(html).toContain("40");
    expect(html).toContain("Взял рубеж");
  });
});

describe("строка рейтинга на узком экране", () => {
  it("метки переносятся на вторую строку, а имя режется многоточием и не вытесняется", () => {
    const html = row({ rubezh: true, tester: true, prestige: 1240, isMe: true });
    // Не сжимающиеся метки без переноса выдавили бы имя в ноль на 320 px.
    expect(html).toMatch(/<p class="[^"]*\bflex-wrap\b[^"]*">/);
    expect(html).toContain('<span class="max-w-full truncate">Мира</span>');
  });
});

describe("схема ответа доски", () => {
  const board = (entry: Record<string, unknown>) => ({
    difficultyId: "normal",
    entries: [{ ...ENTRY, ...entry }],
    me: null,
    totalPlayers: 1,
  });

  it("принимает флаг rubezh: true и не требует его", () => {
    const withFlag = leaderboardSchema.safeParse(board({ rubezh: true }));
    expect(withFlag.success).toBe(true);
    expect(withFlag.success && withFlag.data.entries[0]?.rubezh).toBe(true);
    const without = leaderboardSchema.safeParse(board({}));
    expect(without.success && without.data.entries[0]?.rubezh).toBeUndefined();
  });

  it("не принимает rubezh: false — сервер шлёт только true или ничего", () => {
    expect(leaderboardSchema.safeParse(board({ rubezh: false })).success).toBe(false);
  });
});
