import { describe, expect, it } from "vitest";
import {
  decodeQueryStatsResponse,
  encodeQueryStatsRequest,
  grpcFrame,
  grpcUnframe,
  STATS_SERVICE_PATH,
  trafficOfStats,
  XrayStatsFormatError,
} from "../src/xray-stats.js";

// Кодек статистики Xray (docs/35-stage4-plan.md Р192, tasks/T-0386): тело gRPC
// `StatsService/QueryStats` собирается и читается вручную, без protobuf-библиотеки.
// Сообщения: QueryStatsRequest { string pattern = 1; bool reset = 2; },
// QueryStatsResponse { repeated Stat stat = 1; }, Stat { string name = 1; int64 value = 2; }.

const text = new TextEncoder();

/** Варинт: младшие семь бит первыми, старший бит байта — «дальше есть». */
function varint(value: bigint): number[] {
  let rest = BigInt.asUintN(64, value);
  const bytes: number[] = [];
  do {
    const low = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest === 0n ? low : low | 0x80);
  } while (rest !== 0n);
  return bytes;
}

const lengthDelimited = (field: number, payload: readonly number[]): number[] => [(field << 3) | 2, ...varint(BigInt(payload.length)), ...payload];
const stat = (name: string, value: bigint): number[] => [...lengthDelimited(1, [...text.encode(name)]), (2 << 3) | 0, ...varint(value)];
const response = (...stats: number[][]): Uint8Array => Uint8Array.from(stats.flatMap((entry) => lengthDelimited(1, entry)));

describe("запрос QueryStats", () => {
  it("pattern и reset: байты как у настоящего protobuf", () => {
    expect([...encodeQueryStatsRequest({ pattern: "outbound>>>", reset: true })]).toEqual([0x0a, 0x0b, 0x6f, 0x75, 0x74, 0x62, 0x6f, 0x75, 0x6e, 0x64, 0x3e, 0x3e, 0x3e, 0x10, 0x01]);
  });

  it("reset: false — поле 2 не пишется (значение по умолчанию proto3)", () => {
    expect([...encodeQueryStatsRequest({ pattern: "outbound>>>", reset: false })]).toEqual([0x0a, 0x0b, 0x6f, 0x75, 0x74, 0x62, 0x6f, 0x75, 0x6e, 0x64, 0x3e, 0x3e, 0x3e]);
  });

  it("пустой pattern — поле 1 не пишется", () => {
    expect([...encodeQueryStatsRequest({ pattern: "", reset: true })]).toEqual([0x10, 0x01]);
    expect([...encodeQueryStatsRequest({ pattern: "", reset: false })]).toEqual([]);
  });

  it("pattern длиннее 127 байт — длина варинтом из двух байт; не ASCII — по байтам UTF-8", () => {
    const long = "a".repeat(200);
    const bytes = encodeQueryStatsRequest({ pattern: long, reset: false });
    expect([...bytes.subarray(0, 3)]).toEqual([0x0a, 0xc8, 0x01]);
    expect(bytes).toHaveLength(3 + 200);
    expect([...encodeQueryStatsRequest({ pattern: "й", reset: false })]).toEqual([0x0a, 0x02, 0xd0, 0xb9]);
  });
});

describe("ответ QueryStats", () => {
  it("две записи по порядку; имя и значение читаются", () => {
    const decoded = decodeQueryStatsResponse(response(stat("outbound>>>out-main-0123456789abcdef>>>traffic>>>uplink", 1234n), stat("outbound>>>block>>>traffic>>>downlink", 7n)));
    expect(decoded).toEqual([
      { name: "outbound>>>out-main-0123456789abcdef>>>traffic>>>uplink", value: 1234n },
      { name: "outbound>>>block>>>traffic>>>downlink", value: 7n },
    ]);
  });

  it("значение больше 2^53 — bigint без потери", () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1: в number это уже 2^53
    const decoded = decodeQueryStatsResponse(response(stat("a", big), stat("b", 9_223_372_036_854_775_807n)));
    expect(decoded[0]?.value).toBe(big);
    expect(decoded[1]?.value).toBe(9_223_372_036_854_775_807n);
  });

  it("отрицательное int64 (десять байт варинта) читается со знаком", () => {
    const decoded = decodeQueryStatsResponse(response(stat("a", -5n)));
    expect(decoded[0]?.value).toBe(-5n);
  });

  it("пустой ответ — пустой список; запись без значения — ноль, без имени — пустая строка", () => {
    expect(decodeQueryStatsResponse(new Uint8Array())).toEqual([]);
    expect(decodeQueryStatsResponse(Uint8Array.from(lengthDelimited(1, [...lengthDelimited(1, [...text.encode("x")])])))).toEqual([{ name: "x", value: 0n }]);
    expect(decodeQueryStatsResponse(Uint8Array.from(lengthDelimited(1, [(2 << 3) | 0, 9])))).toEqual([{ name: "", value: 9n }]);
  });

  it("незнакомые поля всех допустимых типов пропускаются: и в ответе, и внутри записи", () => {
    const unknownInStat = [
      (3 << 3) | 0, ...varint(300n), // поле 3, варинт
      (4 << 3) | 1, 1, 2, 3, 4, 5, 6, 7, 8, // поле 4, 64 бита
      (5 << 3) | 2, 2, 0xaa, 0xbb, // поле 5, строка
      (6 << 3) | 5, 1, 2, 3, 4, // поле 6, 32 бита
    ];
    const withUnknown = Uint8Array.from([
      ...lengthDelimited(1, [...stat("x", 5n), ...unknownInStat]),
      (3 << 3) | 0, 7, // поле 3 ответа — пропуск
      ...lengthDelimited(1, stat("y", 6n)),
    ]);
    expect(decodeQueryStatsResponse(withUnknown)).toEqual([
      { name: "x", value: 5n },
      { name: "y", value: 6n },
    ]);
  });

  it("обрыв посреди строки, посреди варинта и посреди записи — XrayStatsFormatError", () => {
    const whole = response(stat("outbound>>>out-main-0123456789abcdef>>>traffic>>>uplink", 1234n));
    for (const cut of [1, 2, 5, whole.length - 3, whole.length - 1]) {
      expect(() => decodeQueryStatsResponse(whole.subarray(0, cut)), `обрезано до ${cut}`).toThrow(XrayStatsFormatError);
    }
    // Варинт длины, который не кончается: все байты с продолжением.
    expect(() => decodeQueryStatsResponse(Uint8Array.from([0x0a, 0x80, 0x80]))).toThrow(XrayStatsFormatError);
    expect(() => decodeQueryStatsResponse(Uint8Array.from([0x0a, ...new Array<number>(11).fill(0xff), 0x01]))).toThrow(XrayStatsFormatError);
  });

  it("длина за концом данных — XrayStatsFormatError, а не чтение чужой памяти", () => {
    expect(() => decodeQueryStatsResponse(Uint8Array.from([0x0a, 0x7f, 0x01, 0x02]))).toThrow(XrayStatsFormatError);
    expect(() => decodeQueryStatsResponse(Uint8Array.from(lengthDelimited(1, [0x0a, 0x20, 0x41])))).toThrow(XrayStatsFormatError);
  });

  it("тип провода 3 и 4 (группы) и 6, 7 — XrayStatsFormatError", () => {
    for (const wire of [3, 4, 6, 7]) {
      expect(() => decodeQueryStatsResponse(Uint8Array.from([(3 << 3) | wire, 0x00])), `тип ${wire}`).toThrow(XrayStatsFormatError);
    }
    expect(() => decodeQueryStatsResponse(Uint8Array.from(lengthDelimited(1, [(3 << 3) | 3, 0x00])))).toThrow(XrayStatsFormatError);
  });

  it("поле 1 ответа не строкой, а числом (неверный тип провода у известного поля) — XrayStatsFormatError", () => {
    expect(() => decodeQueryStatsResponse(Uint8Array.from([(1 << 3) | 0, 0x05]))).toThrow(XrayStatsFormatError);
    expect(() => decodeQueryStatsResponse(Uint8Array.from(lengthDelimited(1, [(1 << 3) | 0, 0x05])))).toThrow(XrayStatsFormatError);
  });

  it("имя не UTF-8 — XrayStatsFormatError", () => {
    expect(() => decodeQueryStatsResponse(Uint8Array.from(lengthDelimited(1, lengthDelimited(1, [0xff, 0xfe]))))).toThrow(XrayStatsFormatError);
  });

  it("ошибка формата помнит своё имя и наследует Error", () => {
    try {
      decodeQueryStatsResponse(Uint8Array.from([0x0a, 0x7f, 0x42]));
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(XrayStatsFormatError);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("XrayStatsFormatError");
    }
  });
});

describe("рамка gRPC", () => {
  it("туда и обратно: пять байт префикса — флаг 0 и длина uint32 big-endian", () => {
    const message = Uint8Array.from([1, 2, 3, 4, 5]);
    const framed = grpcFrame(message);
    expect([...framed.subarray(0, 5)]).toEqual([0, 0, 0, 0, 5]);
    expect([...framed.subarray(5)]).toEqual([1, 2, 3, 4, 5]);
    expect([...grpcUnframe(framed)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("пустое сообщение — рамка из пяти нулей; читается обратно пустым", () => {
    expect([...grpcFrame(new Uint8Array())]).toEqual([0, 0, 0, 0, 0]);
    expect(grpcUnframe(Uint8Array.from([0, 0, 0, 0, 0]))).toHaveLength(0);
  });

  it("длина больше 255 — старшие байты длины заняты", () => {
    const message = new Uint8Array(70_000).fill(7);
    const framed = grpcFrame(message);
    expect([...framed.subarray(0, 5)]).toEqual([0, 0, 1, 0x11, 0x70]);
    expect(grpcUnframe(framed)).toHaveLength(70_000);
  });

  it("флаг сжатия 1 — XrayStatsFormatError: сжатие не договаривалось", () => {
    expect(() => grpcUnframe(Uint8Array.from([1, 0, 0, 0, 1, 0xff]))).toThrow(XrayStatsFormatError);
  });

  it("рамка короче заявленной и неполный префикс — XrayStatsFormatError", () => {
    expect(() => grpcUnframe(Uint8Array.from([0, 0, 0, 0, 5, 1, 2]))).toThrow(XrayStatsFormatError);
    expect(() => grpcUnframe(Uint8Array.from([0, 0, 0]))).toThrow(XrayStatsFormatError);
    expect(() => grpcUnframe(new Uint8Array())).toThrow(XrayStatsFormatError);
  });

  it("лишние байты после рамки — XrayStatsFormatError: ответ на унарный вызов — одно сообщение", () => {
    expect(() => grpcUnframe(Uint8Array.from([0, 0, 0, 0, 1, 9, 0]))).toThrow(XrayStatsFormatError);
  });

  it("длина, которую не вместить в память, — XrayStatsFormatError без выделения", () => {
    expect(() => grpcUnframe(Uint8Array.from([0, 0xff, 0xff, 0xff, 0xff, 1]))).toThrow(XrayStatsFormatError);
  });

  it("путь метода — QueryStats службы StatsService", () => {
    expect(STATS_SERVICE_PATH).toBe("/xray.app.stats.command.StatsService/QueryStats");
  });
});

describe("счётчики узлов из имён Xray", () => {
  const KEY = "0123456789abcdef";

  it("outbound>>>out-<подписка>-<узел>>>>traffic>>>uplink — отдано (up), downlink — получено (down)", () => {
    expect(
      trafficOfStats([
        { name: `outbound>>>out-main-${KEY}>>>traffic>>>uplink`, value: 100n },
        { name: `outbound>>>out-a1b2c3d4e5f6-${KEY}>>>traffic>>>downlink`, value: 2n ** 60n },
      ]),
    ).toEqual([
      { group: "main", nodeKey: KEY, direction: "up", bytes: 100n },
      { group: "a1b2c3d4e5f6", nodeKey: KEY, direction: "down", bytes: 2n ** 60n },
    ]);
  });

  it("чужие и служебные имена пропускаются: block, api, выход с суффиксом, inbound, user, мусор", () => {
    expect(
      trafficOfStats([
        { name: "outbound>>>block>>>traffic>>>uplink", value: 1n },
        { name: "outbound>>>api>>>traffic>>>downlink", value: 1n },
        { name: `outbound>>>out-main-${KEY}-dial>>>traffic>>>uplink`, value: 1n },
        { name: `inbound>>>in-0>>>traffic>>>uplink`, value: 1n },
        { name: `user>>>someone>>>traffic>>>uplink`, value: 1n },
        { name: `outbound>>>out-main-${KEY}>>>traffic>>>sideways`, value: 1n },
        { name: `outbound>>>out-main-${KEY}>>>traffic`, value: 1n },
        { name: `outbound>>>out-main-${KEY}>>>traffic>>>uplink>>>x`, value: 1n },
        { name: `outbound>>>out-MAIN-${KEY}>>>traffic>>>uplink`, value: 1n },
        { name: `outbound>>>out-main-0123456789ABCDEF>>>traffic>>>uplink`, value: 1n },
        { name: `outbound>>>out-main-0123456789abcde>>>traffic>>>uplink`, value: 1n },
        { name: `outbound>>>out-${"a".repeat(17)}-${KEY}>>>traffic>>>uplink`, value: 1n },
        { name: "", value: 1n },
      ]),
    ).toEqual([]);
  });

  it("отрицательное значение пропускается, ноль остаётся", () => {
    expect(
      trafficOfStats([
        { name: `outbound>>>out-main-${KEY}>>>traffic>>>uplink`, value: -1n },
        { name: `outbound>>>out-main-${KEY}>>>traffic>>>downlink`, value: 0n },
      ]),
    ).toEqual([{ group: "main", nodeKey: KEY, direction: "down", bytes: 0n }]);
  });
});
