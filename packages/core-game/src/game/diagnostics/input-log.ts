import { DIRECTION_CODES, IDLE_CODE } from "../sim/input-code";

/**
 * Лог ввода забега (docs/28-diagnostics.md §3.4): код направления на каждый
 * шаг симуляции, серии одинаковых значений свёрнуты.
 *
 * Серии бывают двух видов, и от этого зависит размер лога:
 *
 * - **короткий поворот** — один байт `1ddddlll`: направление сдвинулось от
 *   прошлого на 1–8 кодов в любую сторону (`dddd`) и держалось 1–8 шагов
 *   (`lll`). Так кодируется кругование вокруг толпы — частый приём жанра, при
 *   котором код меняется каждый тик. Без этого вида десять минут кругов не
 *   влезли бы в бюджет лога;
 * - **любая другая серия** — байт `0icLLLLL`: покой (`i`), младшие пять бит
 *   длины без единицы и признак продолжения длины (`c`) — тогда за байтом
 *   следует остаток длины числом переменной длины; если это не покой — затем
 *   байт направления.
 *
 * Байты уходят строкой base64: отчёт — JSON. Буфер выделяется один раз на
 * забег: в кадре запись не аллоцирует.
 */

export const INPUT_LOG_ENCODING = "rle-v1";

/**
 * Потолок лога в байтах: 64 КБ строкой base64 (docs/28-diagnostics.md §3.5).
 * Лог, упёршийся в потолок, дописывать нельзя — повтор по обрезку разошёлся
 * бы, — поэтому он помечается обрезанным, и забег честно не повторяется.
 */
export const INPUT_LOG_MAX_BYTES = 48_000;

export interface EncodedInputLog {
  encoding: typeof INPUT_LOG_ENCODING;
  /** сколько шагов симуляции описано */
  ticks: number;
  data: string;
  /** лог не влез в потолок — повтор невозможен */
  truncated: boolean;
}

export class InputLogError extends Error {
  constructor(reason: string) {
    super(`лог ввода не читается: ${reason}`);
    this.name = "InputLogError";
  }
}

const SHORT_TOKEN = 0x80;
const IDLE_FLAG = 0x40;
const LENGTH_CONTINUES = 0x20;
const LENGTH_LOW_BITS = 0x1f;
const SHORT_MAX_DELTA = 8;
const SHORT_MAX_RUN = 8;
/** Самая длинная серия — байт заголовка, пять байт длины и байт направления. */
const MAX_TOKEN_BYTES = 7;
const MAX_VARINT_BYTES = 5;
const NO_RUN = -2;

export class InputLogWriter {
  private readonly bytes: Uint8Array;
  private length = 0;
  /** код прошлой записанной серии: от него считается короткий поворот */
  private previousCode = IDLE_CODE;
  private runCode = NO_RUN;
  private runLength = 0;
  private ticks = 0;
  private overflowed = false;

  constructor(maxBytes = INPUT_LOG_MAX_BYTES) {
    this.bytes = new Uint8Array(maxBytes);
  }

  get truncated(): boolean {
    return this.overflowed;
  }

  /** код одного шага симуляции: 0–255 или `IDLE_CODE` */
  push(code: number): void {
    this.ticks++;
    if (this.overflowed) return;
    const normalized = code >= 0 && code < DIRECTION_CODES ? code : IDLE_CODE;
    if (normalized === this.runCode) {
      this.runLength++;
      return;
    }
    this.flushRun();
    this.runCode = normalized;
    this.runLength = 1;
  }

  finish(): EncodedInputLog {
    this.flushRun();
    this.runCode = NO_RUN;
    return {
      encoding: INPUT_LOG_ENCODING,
      ticks: this.ticks,
      data: this.overflowed ? "" : encodeBase64(this.bytes.subarray(0, this.length)),
      truncated: this.overflowed,
    };
  }

  private flushRun(): void {
    if (this.runLength === 0 || this.overflowed) return;
    if (this.length + MAX_TOKEN_BYTES > this.bytes.length) {
      this.overflowed = true;
      return;
    }

    const code = this.runCode;
    const delta = code === IDLE_CODE || this.previousCode === IDLE_CODE ? 0 : circularDelta(this.previousCode, code);
    if (delta !== 0 && Math.abs(delta) <= SHORT_MAX_DELTA && this.runLength <= SHORT_MAX_RUN) {
      const nibble = delta > 0 ? delta - 1 : delta + 16;
      this.bytes[this.length++] = SHORT_TOKEN | (nibble << 3) | (this.runLength - 1);
    } else {
      const rest = this.runLength - 1;
      const high = Math.floor(rest / (LENGTH_LOW_BITS + 1));
      this.bytes[this.length++] =
        (code === IDLE_CODE ? IDLE_FLAG : 0) | (high > 0 ? LENGTH_CONTINUES : 0) | (rest & LENGTH_LOW_BITS);
      if (high > 0) this.writeVarint(high);
      if (code !== IDLE_CODE) this.bytes[this.length++] = code;
    }
    this.previousCode = code;
    this.runLength = 0;
  }

  private writeVarint(value: number): void {
    let rest = value;
    while (rest >= 0x80) {
      this.bytes[this.length++] = (rest % 0x80) | 0x80;
      rest = Math.floor(rest / 0x80);
    }
    this.bytes[this.length++] = rest;
  }
}

/** Коды всех шагов. Лог, описывающий не `ticks` шагов, — битый, а не короткий. */
export function decodeInputLog(log: Pick<EncodedInputLog, "encoding" | "ticks" | "data">): Int16Array {
  if (log.encoding !== INPUT_LOG_ENCODING) throw new InputLogError(`кодировка ${log.encoding}`);
  if (!Number.isSafeInteger(log.ticks) || log.ticks < 0) throw new InputLogError("число шагов");
  const bytes = decodeBase64(log.data);
  const codes = new Int16Array(log.ticks);
  let offset = 0;
  let tick = 0;
  let previous = IDLE_CODE;

  while (offset < bytes.length) {
    const head = bytes[offset++];
    let code: number;
    let length: number;
    if ((head & SHORT_TOKEN) !== 0) {
      if (previous === IDLE_CODE) throw new InputLogError("поворот без направления");
      const nibble = (head >> 3) & 0x0f;
      const delta = nibble < SHORT_MAX_DELTA ? nibble + 1 : nibble - 16;
      code = (previous + delta + DIRECTION_CODES) % DIRECTION_CODES;
      length = (head & 0x07) + 1;
    } else {
      let rest = head & LENGTH_LOW_BITS;
      if ((head & LENGTH_CONTINUES) !== 0) {
        let high = 0;
        let scale = 1;
        for (let read = 0; ; read++) {
          if (offset >= bytes.length || read >= MAX_VARINT_BYTES) throw new InputLogError("оборванная длина серии");
          const byte = bytes[offset++];
          high += (byte & 0x7f) * scale;
          scale *= 0x80;
          if (byte < 0x80) break;
        }
        rest += high * (LENGTH_LOW_BITS + 1);
      }
      length = rest + 1;
      if ((head & IDLE_FLAG) !== 0) {
        code = IDLE_CODE;
      } else {
        if (offset >= bytes.length) throw new InputLogError("нет направления серии");
        code = bytes[offset++];
      }
    }
    if (tick + length > codes.length) throw new InputLogError("серий больше, чем шагов");
    codes.fill(code, tick, tick + length);
    tick += length;
    previous = code;
  }
  if (tick !== codes.length) throw new InputLogError(`описано ${tick} шагов из ${codes.length}`);
  return codes;
}

/** Кратчайший поворот от одного кода к другому, от −128 до 127. */
function circularDelta(from: number, to: number): number {
  const forward = (to - from + DIRECTION_CODES) % DIRECTION_CODES;
  return forward >= DIRECTION_CODES / 2 ? forward - DIRECTION_CODES : forward;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Свой base64, а не `btoa`: тот работает со строками из байтов, и на лог в
 * десятки килобайт пришлось бы собирать промежуточную строку символ за символом.
 */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    chunk +=
      ALPHABET[(triple >> 18) & 63] +
      ALPHABET[(triple >> 12) & 63] +
      (i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 63] : "=") +
      (i + 2 < bytes.length ? ALPHABET[triple & 63] : "=");
    if (chunk.length >= 4096) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}

export function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new InputLogError("длина base64");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let out = 0;
  for (let i = 0; i < text.length; i += 4) {
    let triple = 0;
    for (let j = 0; j < 4; j++) {
      const char = text[i + j];
      const index = char === "=" && i + j >= text.length - padding ? 0 : ALPHABET.indexOf(char);
      if (index < 0) throw new InputLogError("символ вне base64");
      triple = (triple << 6) | index;
    }
    if (out < bytes.length) bytes[out++] = (triple >> 16) & 255;
    if (out < bytes.length) bytes[out++] = (triple >> 8) & 255;
    if (out < bytes.length) bytes[out++] = triple & 255;
  }
  return bytes;
}
