import { describe, expect, it } from "vitest";
import { pulseParts, pulseResponseSchema } from "../src/api/pulse";

// Строка «пульса» в шапке (tasks/T-0360): части и их адреса.

describe("пульс в шапке", () => {
  it("все части null — частей нет", () => {
    expect(pulseParts({ online: null, broadcast: null, csp: null })).toEqual([]);
  });

  it("CSP с нулём адресов части не даёт", () => {
    expect(pulseParts({ online: null, broadcast: null, csp: { hosts: 0 } })).toEqual([]);
  });

  it("тексты и адреса частей", () => {
    expect(pulseParts({ online: { total: 128 }, broadcast: { id: "b1", percent: 40 }, csp: { hosts: 3 } })).toEqual([
      { key: "online", text: "128 онлайн", route: { section: "online", id: null }, dot: true },
      { key: "broadcast", text: "рассылка 40%", route: { section: "broadcasts", id: "b1" }, dot: false },
      { key: "csp", text: "CSP 3 за час", route: { section: "csp", id: null }, dot: false },
    ]);
  });

  it("ноль онлайн показывается: тишина в игре — тоже новость", () => {
    expect(pulseParts({ online: { total: 0 }, broadcast: null, csp: null })).toHaveLength(1);
  });

  it("схема разбирает ответ сервера и отвергает мусор", () => {
    expect(pulseResponseSchema.parse({ online: { total: 1 }, broadcast: null, csp: null }).online?.total).toBe(1);
    expect(pulseResponseSchema.safeParse({ online: { total: "1" }, broadcast: null, csp: null }).success).toBe(false);
  });
});
