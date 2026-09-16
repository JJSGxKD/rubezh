import { describe, expect, it } from "vitest";
import { FrameClock } from "../src/game/diagnostics/frame-clock";
import { estimateDisplayHz } from "../src/game/diagnostics/frame-stats";

describe("часы кадров", () => {
  it("меряют по сырым меткам, а первый кадр — по дельте", () => {
    const clock = new FrameClock();
    expect(clock.frame(1000, 16)).toBe(16);
    expect(clock.frame(1017, 16.6)).toBe(17);
    expect(clock.frame(1050, 16.6)).toBe(33);
  });

  it("не верят кадрам в фоне и трём первым после возврата, считают прерывания", () => {
    const clock = new FrameClock();
    clock.frame(0, 16);
    clock.hide();
    expect(clock.frame(5000, 16)).toBeNull();
    clock.show();
    // Кадр возврата несёт секунды простоя — он не должен попасть в замер.
    expect([clock.frame(9000, 16), clock.frame(9016, 16), clock.frame(9033, 16)]).toEqual([null, null, null]);
    expect(clock.frame(9050, 16)).toBe(17);
    expect(clock.interruptions).toBe(1);
  });

  it("повторный показ без сворачивания прерыванием не считается", () => {
    const clock = new FrameClock();
    clock.show();
    expect(clock.interruptions).toBe(0);
    expect(clock.frame(10, 10)).toBe(10);
  });
});

describe("оценка частоты экрана", () => {
  it("берёт медиану после прогрева и не сбивается долгим кадром", () => {
    const frames = new Float32Array(300).fill(1000 / 120);
    frames[40] = 500;
    expect(estimateDisplayHz(frames)).toBe(120);
  });
});
