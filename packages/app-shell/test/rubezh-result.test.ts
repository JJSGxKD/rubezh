import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunResult } from "@bh/shared-types";
import "../src/i18n/run";
import { RubezhResult, rubezhResultView } from "../src/screens/run/RubezhResult";
import type { RunRewardView } from "../src/state/progress";

// Карточка рубежа на экране смерти (tasks/T-0124): победа, страж жив или
// ничего. Строку награды рисует только ответ сервера с `rubezhMul`: оболочка
// сама «×2» не считает.

const BASE = { runId: "run-1", survivalSec: 700 } as RunResult;

const result = (rubezh: RunResult["rubezh"]): RunResult => ({ ...BASE, ...(rubezh === undefined ? {} : { rubezh }) });

const won = result({ reached: true, clearedSec: 702, guardHpPercent: null });
const stopped = result({ reached: true, clearedSec: null, guardHpPercent: 12 });

const granted = (rubezhMul: number | null | undefined): RunRewardView => {
  const progress = { level: 5, xp: 10, xpIntoLevel: 5, xpForNext: 50, nextReward: null };
  return {
    status: "granted",
    coins: 120,
    coinsCapped: false,
    xp: 40,
    levelBefore: 4,
    levelAfter: 5,
    progress,
    ...(rubezhMul === undefined ? {} : { rubezhMul }),
  };
};

const render = (value: RunResult, reward?: RunRewardView): string =>
  renderToStaticMarkup(createElement(RubezhResult, { result: value, reward }));

describe("карточка рубежа: что показывать", () => {
  it("победа: время падения стража и награда ×2, если сервер её подтвердил", () => {
    expect(rubezhResultView(won, granted(2))).toEqual({ kind: "cleared", clearedSec: 702, rewardMul: 2 });
  });

  it("победа без награды в ответе: нет сети, награда считается, отказ или множитель null — строки награды нет", () => {
    for (const reward of [undefined, { status: "pending" } as const, { status: "none", reason: "short" } as const, granted(null), granted(undefined)]) {
      expect(rubezhResultView(won, reward)).toEqual({ kind: "cleared", clearedSec: 702, rewardMul: null });
    }
  });

  it("множитель не больше единицы не считается наградой", () => {
    expect(rubezhResultView(won, granted(1))).toEqual({ kind: "cleared", clearedSec: 702, rewardMul: null });
  });

  it("страж пришёл, но жив: остаток здоровья", () => {
    expect(rubezhResultView(stopped, granted(null))).toEqual({ kind: "stopped", guardHpPercent: 12 });
  });

  it("не дошёл до стража или итог прошлой сборки без поля — карточки нет", () => {
    expect(rubezhResultView(result({ reached: false, clearedSec: null, guardHpPercent: null }), undefined)).toBeNull();
    expect(rubezhResultView(result(undefined), granted(2))).toBeNull();
  });

  it("победа в итоге сильнее остатка здоровья: страж пал, значит «остановил» не показываем", () => {
    expect(rubezhResultView(result({ reached: true, clearedSec: 650, guardHpPercent: 30 }), undefined)?.kind).toBe("cleared");
  });
});

describe("карточка рубежа: разметка", () => {
  it("победа: заголовок, время минутами и секундами, награда", () => {
    const html = render(won, granted(2));
    expect(html).toContain("Рубеж взят");
    expect(html).toContain("Страж пал на 11:42");
    expect(html).toContain("Награда ×2");
  });

  it("победа без награды: карточка видна сразу, обещания «×2» нет", () => {
    const html = render(won, undefined);
    expect(html).toContain("Рубеж взят");
    expect(html).toContain("Страж пал на 11:42");
    expect(html).not.toContain("×2");
    expect(html).not.toContain("Награда");
    expect(render(won, { status: "pending" })).not.toContain("×2");
  });

  it("страж жив: остался процент здоровья", () => {
    const html = render(stopped, undefined);
    expect(html).toContain("Страж рубежа остановил тебя: осталось 12% здоровья");
    expect(html).not.toContain("Рубеж взят");
  });

  it("страж жив, остаток неизвестен — без числа, но без «осталось null%»", () => {
    const html = render(result({ reached: true, clearedSec: null, guardHpPercent: null }), undefined);
    expect(html).toContain("Страж рубежа остановил тебя");
    expect(html).not.toContain("осталось");
    expect(html).not.toContain("null");
  });

  it("не дошёл — компонента нет", () => {
    expect(render(result({ reached: false, clearedSec: null, guardHpPercent: null }), granted(2))).toBe("");
    expect(render(result(undefined), granted(2))).toBe("");
  });

  it("декоративный значок скрыт от скринридера", () => {
    expect(render(won, undefined)).toMatch(/<svg[^>]*aria-hidden="true"/);
  });
});
