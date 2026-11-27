import { describe, expect, it, vi } from "vitest";
import { answerOf, CARD_FLAGS, encodeState, parseQueryData, pacedJobId, stateHash } from "../src/modules/bot-cards/bot-card-protocol.js";

/**
 * Протокол живой карточки (docs/35-stage4-plan.md Р199, tasks/T-0395): запрос
 * `v<версия>:<действие>[:<аргумент>]` и состояние до 1024 байт с `v: 1`.
 * Чистые функции: данные из карточки приходят от клиента, поэтому разбор строг.
 */

describe("parseQueryData", () => {
  it("v1:r — обновление, без аргумента", () => {
    expect(parseQueryData("v1:r")).toEqual({ version: 1, action: "r", arg: null });
  });

  it("v1:claim_tasks:abc-1 — действие с аргументом", () => {
    expect(parseQueryData("v1:claim_tasks:abc-1")).toEqual({ version: 1, action: "claim_tasks", arg: "abc-1" });
  });

  it("версия из двух цифр разбирается числом", () => {
    expect(parseQueryData("v12:r")).toEqual({ version: 12, action: "r", arg: null });
  });

  it.each([
    ["без v", "1:r"],
    ["действие заглавными", "v1:R"],
    ["пустой аргумент", "v1:r:"],
    ["пустое действие", "v1:"],
    ["пустая строка", ""],
    ["третья секция лишняя", "v1:r:a:b"],
    ["аргумент с пробелом", "v1:r:a b"],
    ["аргумент длиннее 32 знаков", `v1:r:${"a".repeat(33)}`],
    ["действие длиннее 24 знаков", `v1:${"a".repeat(25)}`],
    ["версия из трёх цифр", "v123:r"],
    ["перевод строки в конце", "v1:r\n"],
  ])("мусор не разбирается: %s", (_name, data) => {
    expect(parseQueryData(data)).toBeNull();
  });

  it("строка из 65 байт — null, даже если выглядит как запрос", () => {
    const data = `v1:${"a".repeat(24)}:${"b".repeat(32)}`;
    expect(Buffer.byteLength(data)).toBe(60);
    expect(parseQueryData(data)).not.toBeNull();
    const tooLong = `${data}${"c".repeat(5)}`;
    expect(Buffer.byteLength(tooLong)).toBe(65);
    expect(parseQueryData(tooLong)).toBeNull();
  });

  it("многобайтовые знаки не проходят: кириллица в аргументе — мусор", () => {
    expect(parseQueryData("v1:r:привет")).toBeNull();
  });
});

describe("CARD_FLAGS", () => {
  it("флаги состояния: перенесена, выключено, устарело и закрыта (x)", () => {
    expect(CARD_FLAGS).toEqual({ moved: "moved", off: "off", stale: "stale", closed: "x" });
  });
});

describe("encodeState", () => {
  it("ставит v: 1 первым полем", () => {
    expect(encodeState({ week: "2026-W46", place: 3 })).toBe('{"v":1,"week":"2026-W46","place":3}');
  });

  it("чужое v заменяется: состояние всегда версии 1 и v остаётся первым", () => {
    expect(encodeState({ place: 3, v: 7 })).toBe('{"v":1,"place":3}');
  });

  it("ровно 1024 байта проходят, 1025 — RangeError", () => {
    const base = '{"v":1,"t":""}';
    const fill = (bytes: number): Record<string, unknown> => ({ t: "a".repeat(bytes - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(encodeState(fill(1024)))).toBe(1024);
    expect(() => encodeState(fill(1025))).toThrow(RangeError);
  });

  it("предел считается в байтах, а не в знаках: кириллица занимает два байта", () => {
    expect(() => encodeState({ t: "я".repeat(600) })).toThrow(RangeError);
  });
});

describe("stateHash", () => {
  it("sha256 в hex: одинаковая строка — одинаковый хэш, другая — другой", () => {
    expect(stateHash('{"v":1}')).toMatch(/^[0-9a-f]{64}$/);
    expect(stateHash('{"v":1}')).toBe(stateHash('{"v":1}'));
    expect(stateHash('{"v":1}')).not.toBe(stateHash('{"v":1,"a":1}'));
  });
});

describe("answerOf", () => {
  it("короткий ответ — строка с v: 1 первым полем", () => {
    expect(answerOf({ res: "ok", coins: 20 })).toBe('{"v":1,"res":"ok","coins":20}');
  });

  it("длиннее 1024 байт — {\"v\":1,\"err\":\"big\"} и сигнал для лога", () => {
    const onTooBig = vi.fn();
    expect(answerOf({ t: "a".repeat(1100) }, onTooBig)).toBe('{"v":1,"err":"big"}');
    expect(onTooBig).toHaveBeenCalledOnce();
  });

  it("обычный ответ сигнал не подаёт", () => {
    const onTooBig = vi.fn();
    answerOf({ res: "ok" }, onTooBig);
    expect(onTooBig).not.toHaveBeenCalled();
  });
});

describe("pacedJobId", () => {
  it("склеивает части через дефис: двоеточие BullMQ в идентификаторе не пропускает", () => {
    expect(pacedJobId("card-edit", "3f2a")).toBe("card-edit-3f2a");
    expect(pacedJobId("card-send", "acc", "season", "2026-W46")).toBe("card-send-acc-season-2026-W46");
  });

  it("лишние знаки части заменяются подчёркиванием, а пустая часть — none", () => {
    expect(pacedJobId("card-send", "acc", "daily", "2026:11:15")).toBe("card-send-acc-daily-2026_11_15");
    expect(pacedJobId("card-send", "acc", "daily", "")).toBe("card-send-acc-daily-none");
    expect(pacedJobId("card-send", "acc", "daily", "a b")).not.toContain(":");
  });
});
