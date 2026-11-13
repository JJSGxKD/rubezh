import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { changeRequestSchema, type ChangeRequest, type ChangeTarget } from "../src/api/change-requests";
import { ChangeRequestList } from "../src/screens/balance/prices/ChangeRequestList";
import { RewardSettings } from "../src/screens/balance/prices/RewardSettings";
import { describeChange, emptyRewardDraft, rewardAfter, rewardProblem, rewardValueOf } from "../src/screens/balance/prices/prices-rules";

// Блок «Награды» вкладки «Цены и награды» (tasks/T-0310): числа наград с текущим
// значением, «Предложить» и заявки с предупреждением о потолке кошелька.

const NOW = new Date(Date.UTC(2026, 10, 13, 9));
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const COINS: ChangeTarget = {
  target: "rewards.run-max-coins",
  title: "Награда за забег: потолок монет",
  hint: "Больше монет за один забег не начисляется",
  current: { value: 600 },
  inCode: { value: 600 },
  overridden: false,
};
const LADDER: ChangeTarget = {
  target: "rewards.level-ladder",
  title: "Награды за уровень аккаунта",
  hint: "Ступени «с уровня:монет за уровень:самоцветов:раз в сколько уровней» через «;»",
  current: { value: "1:60:10:5" },
  inCode: { value: "1:50:10:5" },
  overridden: true,
};

function request(patch: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    requestId: "33333333-3333-4333-8333-333333333333",
    kind: "reward_setting",
    target: "rewards.run-max-coins",
    before: { value: 600 },
    after: { value: 25_000 },
    reason: "Пробуем щедрее",
    author: OTHER,
    authorName: "Аня",
    status: "pending",
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 72 * 3_600_000).toISOString(),
    ...patch,
  };
}

describe("форма заявки на награду", () => {
  it("пустая форма — текущее значение; число — числом, лестница — строкой; изменённое идёт в заявку", () => {
    expect(rewardValueOf(COINS.current)).toBe(600);
    expect(rewardValueOf(LADDER.current)).toBe("1:60:10:5");
    expect(rewardValueOf({})).toBeNull();
    expect(emptyRewardDraft(COINS)).toEqual({ value: "600", reason: "" });
    expect(rewardAfter({ value: " 800 ", reason: "" }, COINS)).toEqual({ value: 800 });
    expect(rewardAfter({ value: " 1:60:10:5; 20:80:20:10 ", reason: "" }, LADDER)).toEqual({ value: "1:60:10:5; 20:80:20:10" });
    expect(rewardAfter({ value: "много", reason: "" }, COINS)).toEqual({});
  });

  it("отправить нельзя: значение не изменено, не число, пусто, причина пуста или длинная", () => {
    expect(rewardProblem({ value: "600", reason: "причина" }, COINS)).toBe("Ничего не изменено: поменяйте значение");
    expect(rewardProblem({ value: "6.5", reason: "причина" }, COINS)).toBe("Значение — целое число");
    expect(rewardProblem({ value: "-5", reason: "причина" }, COINS)).toBe("Значение — целое число");
    expect(rewardProblem({ value: " ", reason: "причина" }, LADDER)).toContain("не заполнено");
    expect(rewardProblem({ value: "800", reason: "  " }, COINS)).toContain("причину");
    expect(rewardProblem({ value: "800", reason: "я".repeat(201) }, COINS)).toContain("200");
    expect(rewardProblem({ value: "800", reason: "Нужно щедрее" }, COINS)).toBeNull();
    expect(rewardProblem({ value: "1:60:10:5; 20:80:20:10", reason: "Нужно" }, LADDER)).toBeNull();
  });

  it("«было → стало» словами: число и строка", () => {
    expect(describeChange("reward_setting", { value: 600 }, { value: 800 })).toEqual(["600 → 800"]);
    expect(describeChange("reward_setting", { value: "1:50:10:5" }, { value: "1:60:10:5" })).toEqual(["1:50:10:5 → 1:60:10:5"]);
  });
});

describe("блок «Награды»", () => {
  const render = (canEdit: boolean, waiting = false) =>
    renderToStaticMarkup(createElement(RewardSettings, { targets: [COINS, LADDER], canEdit, waitingFor: (target) => (waiting && target === COINS.target ? request() : null), onPropose: () => undefined }));

  it("карточка: название, ключ, значение сейчас, значение по умолчанию, подсказка и «Предложить»", () => {
    const html = render(true);
    expect(html).toContain("Награда за забег: потолок монет");
    expect(html).toContain("rewards.run-max-coins");
    expect(html).toContain("1:60:10:5");
    // Лестница изменена — рядом видно, что в коде; число не менялось — строки «по умолчанию» нет.
    expect(html).toContain("по умолчанию 1:50:10:5");
    expect(html).not.toContain("по умолчанию 600");
    expect(html).toContain("Больше монет за один забег не начисляется");
    expect(html.match(/Предложить/g)).toHaveLength(2);
  });

  it("без права на цены кнопки «Предложить» нет; ждущая заявка видна пометкой", () => {
    expect(render(false)).not.toContain("Предложить");
    expect(render(true, true)).toContain("ждёт заявка");
    expect(render(true)).not.toContain("ждёт заявка");
  });
});

describe("заявка на награду в списке", () => {
  const list = (requests: ChangeRequest[]) =>
    renderToStaticMarkup(createElement(ChangeRequestList, { requests, meId: ME, now: NOW, titleOf: () => "Награда за забег: потолок монет", busy: null, onApprove: () => undefined, onReject: () => undefined, onWithdraw: () => undefined }));

  it("предупреждение о потолке кошелька показано рядом с «было → стало»; без него блока нет", () => {
    const warned = list([request({ warnings: ["Выше суточного потолка — часть не начислится: монеты за забег до 25 000 при потолке 20 000 в сутки"] })]);
    expect(warned).toContain("600 → 25000");
    expect(warned).toContain("Выше суточного потолка — часть не начислится");
    expect(list([request()])).not.toContain("Предупреждения");
  });

  it("ответ сервера с предупреждениями и без них разбирается схемой", () => {
    const wire = { ...request(), warnings: ["Выше суточного потолка"] };
    expect(changeRequestSchema.safeParse(wire).success).toBe(true);
    expect(changeRequestSchema.safeParse(request()).success).toBe(true);
    expect(changeRequestSchema.safeParse({ ...wire, warnings: [1] }).success).toBe(false);
  });
});
