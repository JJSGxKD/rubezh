/**
 * Кодек статистики Xray: тело gRPC `StatsService/QueryStats` без protobuf-библиотеки
 * (docs/35-stage4-plan.md Р192, tasks/T-0386). Сообщений три, и все плоские:
 *
 *   QueryStatsRequest  { string pattern = 1; bool reset = 2; }
 *   QueryStatsResponse { repeated Stat stat = 1; }
 *   Stat               { string name = 1; int64 value = 2; }
 *
 * Чистые функции без сети и времени: адрес, соединение и таймаут — дело вызывающего.
 * Ответ приходит с границы системы, поэтому разбор строгий: обрыв, неверный тип
 * провода у известного поля и длина за концом данных — `XrayStatsFormatError`, а не
 * обрезанный список, который выглядел бы как «трафика не было».
 */

/** Метод службы статистики в `:path` запроса gRPC. */
export const STATS_SERVICE_PATH = "/xray.app.stats.command.StatsService/QueryStats";

/** Ответ или рамка не по формату: байтов ответа в тексте нет. */
export class XrayStatsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XrayStatsFormatError";
  }
}

export interface StatEntry {
  /** `outbound>>>(тег)>>>traffic>>>(uplink|downlink)` */
  name: string;
  /** int64: байты бывают больше 2^53, поэтому `bigint` */
  value: bigint;
}

/** Типы провода protobuf, которые умеем пропускать. */
const WIRE = { varint: 0, fixed64: 1, bytes: 2, fixed32: 5 } as const;
/** uint64 занимает не больше десяти байт варинта. */
const VARINT_BYTES_MAX = 10;
const FRAME_HEADER = 5;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function varintBytes(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

/** Запрос: `pattern` и `reset`; поля со значениями по умолчанию proto3 (пустая строка, false) не пишутся. */
export function encodeQueryStatsRequest(request: { pattern: string; reset: boolean }): Uint8Array {
  const pattern = encoder.encode(request.pattern);
  const bytes: number[] = [];
  if (pattern.length > 0) bytes.push(0x0a, ...varintBytes(pattern.length), ...pattern);
  if (request.reset) bytes.push(0x10, 0x01);
  return Uint8Array.from(bytes);
}

/** Читатель байтов с границами: выйти за конец данных нельзя. */
class Reader {
  private position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.position >= this.bytes.length;
  }

  varint(): bigint {
    let value = 0n;
    for (let index = 0; index < VARINT_BYTES_MAX; index++) {
      const byte = this.bytes[this.position];
      if (byte === undefined) throw new XrayStatsFormatError("Ответ Xray оборван посреди числа");
      this.position += 1;
      value |= BigInt(byte & 0x7f) << BigInt(7 * index);
      if ((byte & 0x80) === 0) return BigInt.asUintN(64, value);
    }
    throw new XrayStatsFormatError("Число в ответе Xray длиннее десяти байт");
  }

  /** Следующие `length` байт; длина за концом данных — ошибка. */
  take(length: bigint | number): Uint8Array {
    const wanted = typeof length === "bigint" ? length : BigInt(length);
    if (wanted > BigInt(this.bytes.length - this.position)) throw new XrayStatsFormatError("Длина поля в ответе Xray больше самого ответа");
    const size = Number(wanted);
    const slice = this.bytes.subarray(this.position, this.position + size);
    this.position += size;
    return slice;
  }

  /** Номер поля и тип провода следующего поля. */
  tag(): { field: number; wire: number } {
    const tag = this.varint();
    const field = Number(tag >> 3n);
    if (field === 0) throw new XrayStatsFormatError("Поле с номером 0 в ответе Xray");
    return { field, wire: Number(tag & 7n) };
  }

  /** Незнакомое поле пропускается по типу провода; группы и неизвестные типы — ошибка. */
  skip(wire: number): void {
    switch (wire) {
      case WIRE.varint:
        this.varint();
        return;
      case WIRE.fixed64:
        this.take(8);
        return;
      case WIRE.bytes:
        this.take(this.varint());
        return;
      case WIRE.fixed32:
        this.take(4);
        return;
      default:
        throw new XrayStatsFormatError(`Тип провода ${wire} в ответе Xray не поддерживается`);
    }
  }
}

function decodeStat(bytes: Uint8Array): StatEntry {
  const reader = new Reader(bytes);
  let name = "";
  let value = 0n;
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) {
      if (wire !== WIRE.bytes) throw new XrayStatsFormatError("Имя счётчика в ответе Xray не строка");
      try {
        name = decoder.decode(reader.take(reader.varint()));
      } catch (error: unknown) {
        if (error instanceof XrayStatsFormatError) throw error;
        throw new XrayStatsFormatError("Имя счётчика в ответе Xray не UTF-8");
      }
    } else if (field === 2) {
      if (wire !== WIRE.varint) throw new XrayStatsFormatError("Значение счётчика в ответе Xray не число");
      value = BigInt.asIntN(64, reader.varint());
    } else {
      reader.skip(wire);
    }
  }
  return { name, value };
}

/** Ответ: список счётчиков по порядку Xray. Пустое сообщение — пустой список. */
export function decodeQueryStatsResponse(bytes: Uint8Array): StatEntry[] {
  const reader = new Reader(bytes);
  const stats: StatEntry[] = [];
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field !== 1) {
      reader.skip(wire);
      continue;
    }
    if (wire !== WIRE.bytes) throw new XrayStatsFormatError("Запись счётчика в ответе Xray не сообщение");
    stats.push(decodeStat(reader.take(reader.varint())));
  }
  return stats;
}

/** Рамка gRPC: флаг сжатия (0) и длина сообщения uint32 big-endian, затем сообщение. */
export function grpcFrame(message: Uint8Array): Uint8Array {
  if (message.length > 0xffff_ffff) throw new RangeError("Сообщение gRPC длиннее 4 ГиБ");
  const framed = new Uint8Array(FRAME_HEADER + message.length);
  new DataView(framed.buffer).setUint32(1, message.length);
  framed.set(message, FRAME_HEADER);
  return framed;
}

/**
 * Сообщение из рамки. Ответ на унарный вызов — ровно одна несжатая рамка:
 * сжатие не договаривалось, а лишние байты — не тот ответ, который ждали.
 */
export function grpcUnframe(bytes: Uint8Array): Uint8Array {
  if (bytes.length < FRAME_HEADER) throw new XrayStatsFormatError("Рамка gRPC неполная");
  if (bytes[0] !== 0) throw new XrayStatsFormatError("Рамка gRPC со сжатием: сжатие не договаривалось");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  const available = bytes.length - FRAME_HEADER;
  if (available < length) throw new XrayStatsFormatError("Рамка gRPC короче заявленной");
  if (available > length) throw new XrayStatsFormatError("После рамки gRPC лишние байты");
  return bytes.subarray(FRAME_HEADER);
}

/** Тег выхода узла: `out-<ключ подписки>-<ключ узла>` (`outboundTag` в `xray-config.ts`, ключ узла — 16 hex). */
const NODE_OUTBOUND_TAG = /^out-([a-z0-9]{1,16})-([0-9a-f]{16})$/;

export interface NodeTraffic {
  /** ключ подписки */
  group: string;
  nodeKey: string;
  /** `up` — uplink, от нас к узлу; `down` — downlink, от узла к нам */
  direction: "up" | "down";
  bytes: bigint;
}

/**
 * Счётчики узлов из ответа Xray. Берутся только имена
 * `outbound>>>out-<подписка>-<узел>>>>traffic>>>(uplink|downlink)`: выход `block`,
 * служебные выходы с суффиксом (они повторили бы байты своего узла), входы,
 * пользователи и отрицательные значения пропускаются.
 */
export function trafficOfStats(stats: readonly StatEntry[]): NodeTraffic[] {
  const traffic: NodeTraffic[] = [];
  for (const { name, value } of stats) {
    if (value < 0n) continue;
    const parts = name.split(">>>");
    if (parts.length !== 4 || parts[0] !== "outbound" || parts[2] !== "traffic") continue;
    const direction = parts[3] === "uplink" ? "up" : parts[3] === "downlink" ? "down" : null;
    if (direction === null) continue;
    const match = NODE_OUTBOUND_TAG.exec(parts[1] ?? "");
    if (match === null) continue;
    traffic.push({ group: match[1] ?? "", nodeKey: match[2] ?? "", direction, bytes: value });
  }
  return traffic;
}
