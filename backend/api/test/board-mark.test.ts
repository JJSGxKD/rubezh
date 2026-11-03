import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { BOARD_MARK_LABEL, NO_BOARD_MARK, boardMark, markedInWindow } from "../src/modules/restrictions/board-mark.js";

/**
 * Метка «Отдельная доска» в отчётах (docs/35-stage4-plan.md Р104, T-0115):
 * правило окна и подпись. Запросы — в `board-mark.integration.test.ts`.
 */

const FROM = new Date("2026-10-10T00:00:00Z");
const TO = new Date("2026-10-11T00:00:00Z");
const HOUR = 3_600_000;
const at = (offset: number) => new Date(FROM.getTime() + offset);
const view = (patch: Partial<Parameters<typeof markedInWindow>[0]>) => ({ startsAt: at(-5 * HOUR), endsAt: null, liftedAt: null, settledAt: null, ...patch });

describe("окно метки", () => {
  it("бессрочный действующий вид помечает", () => {
    expect(markedInWindow(view({}), FROM, TO)).toBe(true);
  });

  it("вид, кончившийся ровно в начале окна, не помечает; на миг позже — помечает", () => {
    expect(markedInWindow(view({ endsAt: FROM }), FROM, TO)).toBe(false);
    expect(markedInWindow(view({ endsAt: at(1) }), FROM, TO)).toBe(true);
  });

  it("конец — самое раннее из срока, снятия и расчёта", () => {
    expect(markedInWindow(view({ endsAt: at(10 * HOUR), liftedAt: at(-HOUR) }), FROM, TO)).toBe(false);
    expect(markedInWindow(view({ endsAt: at(10 * HOUR), settledAt: at(-HOUR) }), FROM, TO)).toBe(false);
    expect(markedInWindow(view({ endsAt: at(-HOUR), liftedAt: at(2 * HOUR) }), FROM, TO)).toBe(false);
    expect(markedInWindow(view({ liftedAt: at(2 * HOUR) }), FROM, TO)).toBe(true);
  });

  it("вид, начавшийся внутри окна, помечает; начавшийся ровно в конце окна — нет", () => {
    expect(markedInWindow(view({ startsAt: at(HOUR) }), FROM, TO)).toBe(true);
    expect(markedInWindow(view({ startsAt: TO }), FROM, TO)).toBe(false);
  });
});

describe("подпись", () => {
  it("нейтральная: в ней нет слов, которыми называют людей под видом", () => {
    expect(BOARD_MARK_LABEL).toBe("Отдельная доска");
    expect(BOARD_MARK_LABEL).not.toMatch(/читер|нарушител|контур|изоляц|бан/i);
  });
});

describe("счёт без помеченных", () => {
  it("пустой список — нули и один запрос: к сессиям и забегам не ходит", async () => {
    const queries: string[] = [];
    const prisma = {
      $queryRaw: async (strings: TemplateStringsArray) => {
        queries.push(strings.join("?"));
        return [];
      },
    } as unknown as PrismaClient;

    expect(await boardMark(prisma, { from: FROM, to: TO })).toEqual(NO_BOARD_MARK);
    expect(NO_BOARD_MARK).toEqual({ marked: 0, active: 0, newAccounts: 0, runs: 0 });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("account_restriction");
    expect(queries.join(" ")).not.toMatch(/account_session|FROM run/);
  });
});
