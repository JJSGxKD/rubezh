import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { customProblem, DEFAULT_PRESET, PERIOD_PRESETS, PeriodPicker, periodLabel, presetDates } from "../src/ui/period-picker";

// Общий выбор периода (tasks/T-0053, AD-02): чипы пресетов, подпись `ДД.ММ`
// независимо от языка браузера и «Свой период» с проверкой дат у поля.

const NOW = new Date("2026-10-22T15:00:00.000Z");

describe("пресеты периода", () => {
  it("7, 30 и 90 дней; по умолчанию — 30", () => {
    expect(PERIOD_PRESETS).toEqual([7, 30, 90]);
    expect(DEFAULT_PRESET).toBe(30);
  });

  it("пресет — пара московских дат: сегодня включительно", () => {
    expect(presetDates(7, NOW)).toEqual({ from: "2026-10-16", to: "2026-10-22" });
    expect(presetDates(30, NOW)).toEqual({ from: "2026-09-23", to: "2026-10-22" });
  });
});

describe("подпись периода", () => {
  it("«ДД.ММ–ДД.ММ», не зависит от языка браузера", () => {
    expect(periodLabel("2026-09-22", "2026-10-22")).toBe("22.09–22.10");
  });

  it("один день — одна дата; через границу года — с годом", () => {
    expect(periodLabel("2026-10-22", "2026-10-22")).toBe("22.10");
    expect(periodLabel("2025-12-28", "2026-01-03")).toBe("28.12.2025–03.01.2026");
  });
});

describe("«Свой период»", () => {
  it("годные даты — без ошибки", () => {
    expect(customProblem("2026-10-01", "2026-10-22")).toBeNull();
    expect(customProblem("2026-10-22", "2026-10-22")).toBeNull();
  });

  it("перевёрнутые даты — ошибка у поля", () => {
    expect(customProblem("2026-10-22", "2026-10-01")).toBe("Дата «С» позже даты «По»");
  });

  it("пустое поле и период длиннее года — ошибка", () => {
    expect(customProblem("", "2026-10-01")).toBe("Укажите обе даты");
    expect(customProblem("2026-10-01", "")).toBe("Укажите обе даты");
    expect(customProblem("2025-09-01", "2026-10-22")).toBe("Не длиннее года");
  });
});

describe("разметка выбора периода", () => {
  const render = (value: Parameters<typeof PeriodPicker>[0]["value"]) =>
    renderToStaticMarkup(createElement(PeriodPicker, { value, now: NOW, onChange: () => undefined }));

  it("три пресета и «Свой период»; выбранный отмечен, подпись периода рядом", () => {
    const html = render({ preset: 30 });
    for (const title of ["7 дней", "30 дней", "90 дней", "Свой период"]) expect(html).toContain(title);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain("23.09–22.10");
    expect(html).not.toContain('type="date"');
  });

  it("свой период раскрывает два поля дат, перевёрнутые — с ошибкой у поля", () => {
    const html = render({ preset: "custom", from: "2026-10-22", to: "2026-10-01" });
    expect(html.match(/type="date"/g)).toHaveLength(2);
    expect(html).toContain("Дата «С» позже даты «По»");
  });
});
