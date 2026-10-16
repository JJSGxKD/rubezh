import { describe, expect, it } from "vitest";
import { schemaOf } from "../src/infra/database.js";

// Схема из адреса базы: локальные исполнители гоняют интеграционные тесты в своей
// схеме одной тестовой базы (`?schema=t0104`), и адаптер обязан её услышать —
// иначе все ходят в `public` и чистят таблицы друг другу.
describe("схема из адреса базы", () => {
  const base = "postgresql://u:p@localhost:5432/rubezh_test";

  it("без параметра и с public — схема по умолчанию", () => {
    expect(schemaOf(base)).toBeNull();
    expect(schemaOf(`${base}?schema=public`)).toBeNull();
    expect(schemaOf(`${base}?schema=`)).toBeNull();
  });

  it("своя схема читается из адреса", () => {
    expect(schemaOf(`${base}?schema=t0104`)).toBe("t0104");
    expect(schemaOf(`${base}?sslmode=disable&schema=t_0110`)).toBe("t_0110");
  });

  it("имя схемы с недопустимыми знаками — ошибка, а не строка в search_path", () => {
    expect(() => schemaOf(`${base}?schema=t0104;drop`)).toThrow("схемы");
    expect(() => schemaOf(`${base}?schema=T0104`)).toThrow("схемы");
    expect(() => schemaOf(`${base}?schema=${"a".repeat(64)}`)).toThrow("схемы");
  });
});
