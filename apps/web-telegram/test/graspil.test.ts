import { describe, expect, it } from "vitest";
import { GRASPIL_SCRIPT, graspilAllowed } from "../src/graspil";

// Сниппет кабинета Graspil грузит скрипт с `?l=<имя очереди>`: по нему скрипт
// находит очередь с ключом. Без параметра ключа он не видит, и его сервер
// отвечает 401 «check the key».
describe("GRASPIL_SCRIPT", () => {
  it("несёт имя очереди, как сниппет кабинета", () => {
    expect(GRASPIL_SCRIPT).toBe("https://w.graspil.com?l=graspil");
  });
});

// Graspil грузится только по явному «да» сервера (tasks/T-0055): сбой и
// непонятный ответ — не грузим, аналитика необязательна, а выключатель на то и
// нужен, чтобы не тянуть скрипт в сомнении.

describe("graspilAllowed", () => {
  it("явное «да» — грузить", () => {
    expect(graspilAllowed({ data: { graspil: true } })).toBe(true);
  });

  it("явное «нет» — не грузить", () => {
    expect(graspilAllowed({ data: { graspil: false } })).toBe(false);
  });

  it("всё остальное — не грузить", () => {
    expect(graspilAllowed(null)).toBe(false);
    expect(graspilAllowed(undefined)).toBe(false);
    expect(graspilAllowed({})).toBe(false);
    expect(graspilAllowed({ data: {} })).toBe(false);
    expect(graspilAllowed({ data: { graspil: "yes" } })).toBe(false);
    expect(graspilAllowed({ data: { graspil: 1 } })).toBe(false);
    expect(graspilAllowed("true")).toBe(false);
  });
});
