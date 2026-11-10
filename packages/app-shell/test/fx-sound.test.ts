import { describe, expect, it } from "vitest";
import { fft, hann } from "../src/dev/fx-sound";

describe("БПФ спектрограммы", () => {
  it("синус на 12-й корзине из 1024 даёт максимум в корзине 12", () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i += 1) re[i] = Math.sin((2 * Math.PI * 12 * i) / n);
    fft(re, im);
    let best = 1;
    for (let k = 1; k < n / 2; k += 1) {
      if (Math.hypot(re[k] ?? 0, im[k] ?? 0) > Math.hypot(re[best] ?? 0, im[best] ?? 0)) best = k;
    }
    expect(best).toBe(12);
  });

  it("окно Ханна на краях — 0, в середине — 1", () => {
    const w = hann(1024);
    expect(w[0]).toBe(0);
    expect(w[512]).toBeCloseTo(1, 6);
  });
});
