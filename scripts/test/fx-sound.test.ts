import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { encodeWav, findMarks, measure, parseArgs } from "../fx/sound-core.mjs";

// Команда нужна живому dev-серверу и браузеру, поэтому в гейт не входит;
// здесь — чистые части: замеры, пометки, WAV и флаги.

const RATE = 48_000;

function sine(amp: number, ms: number, hz = 1000): Float32Array {
  const out = new Float32Array(Math.round((RATE * ms) / 1000));
  for (let i = 0; i < out.length; i += 1) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

function fadeOut(samples: Float32Array): Float32Array {
  for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i] ?? 0) * (1 - i / samples.length) ** 3;
  return samples;
}

const RECIPE = { gap: 1, voices: 1, dur: 0.1 };

function marks(samples: Float32Array, recipe = RECIPE): Array<{ level: string; text: string }> {
  return findMarks(measure(samples, RATE), recipe);
}

describe("measure", () => {
  it("синус 1 кГц амплитудой 0,5: пик −6 dBFS, RMS −9 dBFS, длина 100 мс", () => {
    const m = measure(sine(0.5, 100), RATE);
    expect(m.peakDbfs).toBeCloseTo(-6.02, 1);
    expect(m.rmsDbfs).toBeCloseTo(-9.03, 1);
    expect(m.audibleMs).toBeGreaterThan(98);
    expect(m.audibleMs).toBeLessThanOrEqual(100);
    expect(m.clipped).toBe(0);
    expect(Math.abs(m.dcOffset)).toBeLessThan(0.001);
  });

  it("тишина: пик −∞, длина 0", () => {
    const m = measure(new Float32Array(4800), RATE);
    expect(m.peakDbfs).toBe(Number.NEGATIVE_INFINITY);
    expect(m.audibleMs).toBe(0);
  });

  it("хвост — от пика до спада ниже −60 dBFS", () => {
    const samples = new Float32Array(RATE / 10);
    samples[0] = 0.5;
    samples[2400] = 0.01; // −40 dBFS: последний слышимый отсчёт — на 50-й миллисекунде
    expect(measure(samples, RATE).tailMs).toBeCloseTo(50, 0);
  });
});

describe("findMarks", () => {
  it("чистый звук — без пометок", () => {
    expect(marks(fadeOut(sine(0.5, 100)))).toEqual([]);
  });

  it("тишина — ошибка «звук пустой»", () => {
    expect(marks(new Float32Array(4800))).toContainEqual({ level: "error", text: expect.stringContaining("звук пустой") });
  });

  it("один отсчёт 1,0 — «перегруз: 1 отсчёт», пять — «5 отсчётов»", () => {
    const one = sine(0.3, 100);
    one[100] = 1;
    expect(marks(one)).toContainEqual({ level: "error", text: "перегруз: 1 отсчёт" });
    const five = sine(0.3, 100);
    for (let i = 0; i < 5; i += 1) five[100 + i] = 1;
    expect(marks(five)).toContainEqual({ level: "error", text: "перегруз: 5 отсчётов" });
  });

  it("пик выше −1 dBFS — предупреждение о запасе", () => {
    expect(marks(sine(0.95, 100)).some((m) => m.level === "warning" && m.text.includes("нет запаса до перегруза"))).toBe(true);
  });

  it("последние 5 мс на −20 dBFS — «хвост обрезан»", () => {
    const samples = new Float32Array(RATE / 10);
    samples.set(sine(0.1, 5), samples.length - Math.round(RATE * 0.005));
    expect(marks(samples).some((m) => m.level === "warning" && m.text.includes("хвост обрезан"))).toBe(true);
  });

  it("gap 0,05 и voices 2 при звуке 150 мс — предупреждение про голоса", () => {
    const result = marks(fadeOut(sine(0.3, 150)), { gap: 0.05, voices: 2, dur: 0.15 });
    expect(result.some((m) => m.level === "warning" && m.text.includes("голоса"))).toBe(true);
  });

  it("смещение постоянной составляющей — предупреждение", () => {
    const samples = sine(0.3, 100);
    for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i] ?? 0) + 0.05;
    expect(marks(fadeOut(samples)).some((m) => m.text.includes("смещение постоянной составляющей"))).toBe(true);
  });

  it("звук вдвое короче буфера — заметка", () => {
    const samples = new Float32Array(RATE / 5);
    samples.set(fadeOut(sine(0.3, 50)));
    const result = marks(samples, { gap: 1, voices: 1, dur: 0.2 });
    expect(result.some((m) => m.level === "note" && m.text.includes("укоротить dur"))).toBe(true);
  });
});

describe("encodeWav", () => {
  it("3 отсчёта — 50 байт с верным заголовком", () => {
    const wav: Buffer = encodeWav(new Float32Array([0, 1, -1]), RATE);
    expect(wav.length).toBe(50);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(42);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.readInt16LE(44)).toBe(0);
    expect(wav.readInt16LE(46)).toBe(32767);
    expect(wav.readInt16LE(48)).toBe(-32768);
  });
});

describe("parseArgs", () => {
  const IDS = ["spark", "knife"];

  it("без звуков — все, вариант first", () => {
    const o = parseArgs([], IDS);
    expect(o.sounds).toEqual(IDS);
    expect(o.variant).toBe("first");
    expect(o.out).toBe("var/fx");
  });

  it("имена и флаги", () => {
    const o = parseArgs(["knife", "--variant", "all", "--out", "x"], IDS);
    expect(o.sounds).toEqual(["knife"]);
    expect(o.variant).toBe("all");
    expect(o.out).toBe("x");
  });

  it("неизвестный звук, флаг и вариант — ошибки", () => {
    expect(() => parseArgs(["nope"], IDS)).toThrow(/nope/);
    expect(() => parseArgs(["--zzz", "1"], IDS)).toThrow(/--zzz/);
    expect(() => parseArgs(["--variant", "x"], IDS)).toThrow(/--variant/);
  });
});
