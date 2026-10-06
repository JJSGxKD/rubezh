import { describe, expect, it } from "vitest";
import { shadowLayout } from "../src/game/render/shadow-layout";

// Тень запечена в текстуру вокруг тела: поле под неё, тело в центре, точка
// привязки не двигается (tasks/T-0014).

describe("раскладка тени в текстуре", () => {
  for (const radius of [8, 12, 30]) {
    describe(`радиус ${String(radius)}`, () => {
      const layout = shadowLayout(radius);

      it("поле — ceil(0,4·r) со всех сторон, размер — тело плюс поля", () => {
        const pad = Math.ceil(radius * 0.4);
        expect(layout.size).toBe(Math.ceil(radius * 2) + pad * 2);
        expect(layout.bodyX).toBe(pad + radius);
        expect(layout.bodyY).toBe(pad + radius);
      });

      it("тело целиком внутри текстуры", () => {
        expect(layout.bodyX - radius).toBeGreaterThanOrEqual(0);
        expect(layout.bodyX + radius).toBeLessThanOrEqual(layout.size);
        expect(layout.bodyY - radius).toBeGreaterThanOrEqual(0);
        expect(layout.bodyY + radius).toBeLessThanOrEqual(layout.size);
      });

      it("тень целиком внутри текстуры и ниже центра тела", () => {
        expect(layout.shadowX - layout.shadowRx).toBeGreaterThanOrEqual(0);
        expect(layout.shadowX + layout.shadowRx).toBeLessThanOrEqual(layout.size);
        expect(layout.shadowY - layout.shadowRy).toBeGreaterThanOrEqual(0);
        expect(layout.shadowY + layout.shadowRy).toBeLessThanOrEqual(layout.size);
        expect(layout.shadowY).toBeGreaterThan(layout.bodyY);
        expect(layout.shadowX).toBe(layout.bodyX);
      });

      it("полуоси тени — 0,9·r и 0,38·r, центр — на 0,75·r ниже тела", () => {
        expect(layout.shadowRx).toBeCloseTo(radius * 0.9, 9);
        expect(layout.shadowRy).toBeCloseTo(radius * 0.38, 9);
        expect(layout.shadowY - layout.bodyY).toBeCloseTo(radius * 0.75, 9);
      });

      it("точка привязки — середина: тело в центре текстуры", () => {
        expect(layout.originX).toBe(0.5);
        expect(layout.originY).toBe(0.5);
        expect(layout.bodyX).toBe(layout.size / 2);
        expect(layout.bodyY).toBe(layout.size / 2);
      });

      it("текстура больше тела, и обратный масштаб возвращает её к 2·r", () => {
        const factor = layout.size / (2 * radius);
        expect(factor).toBeGreaterThan(1);
        expect(layout.size * (1 / factor)).toBeCloseTo(2 * radius, 9);
      });
    });
  }
});
