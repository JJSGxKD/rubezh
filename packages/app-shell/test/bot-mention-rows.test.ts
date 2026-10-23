import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "../src/i18n/tasks";
import { BotMentionCard } from "../src/screens/meta/bot-mention-rows";
import type { BotMentionTask } from "../src/state/bot-mention-api";

// Карточка задания «юзернейм бота» (tasks/T-0160) без браузера: разметка
// презентационного компонента. Состояния — из раздела «Сценарий и интерфейс».

function task(patch: Partial<BotMentionTask> = {}): BotMentionTask {
  return {
    kind: "name",
    reward: { coins: 50, gems: 0, shards: 0 },
    started: false,
    streak: 0,
    bestStreak: 0,
    rewardedToday: false,
    lastResult: null,
    checkedAt: null,
    ...patch,
  };
}

function card(patch: Partial<BotMentionTask> = {}, props: { loading?: boolean; message?: string | null; botUsername?: string } = {}): string {
  return renderToStaticMarkup(
    createElement(BotMentionCard, { botUsername: props.botUsername ?? "game_bot", task: task(patch), loading: props.loading ?? false, message: props.message ?? null, onPress: () => undefined }),
  );
}

describe("карточка «юзернейм бота»", () => {
  it("не начато: юзернейм, кнопка «Начать», строка про самопроверку и награда", () => {
    const markup = card();
    expect(markup).toContain("@game_bot");
    expect(markup).toContain("Юзернейм бота в имени");
    expect(markup).toContain("Начать");
    expect(markup).toContain("Мы сами проверяем раз в игровые сутки");
    expect(markup).toContain("50 монет");
    expect(markup).not.toContain("Серия:");
  });

  it("bio: свой заголовок и своя подсказка", () => {
    const markup = card({ kind: "bio" });
    expect(markup).toContain("Юзернейм бота в bio");
    expect(markup).toContain("О себе");
  });

  it("серия: 1 день, 3 дня, 5 дней; лучшая — только если больше текущей", () => {
    expect(card({ started: true, streak: 3, bestStreak: 5 })).toContain("Серия: 3 дня");
    expect(card({ started: true, streak: 3, bestStreak: 5 })).toContain("Лучшая серия: 5");
    expect(card({ started: true, streak: 1, bestStreak: 1 })).toContain("Серия: 1 день");
    expect(card({ started: true, streak: 5, bestStreak: 5 })).toContain("Серия: 5 дней");
    expect(card({ started: true, streak: 5, bestStreak: 5 })).not.toContain("Лучшая серия");
    expect(card({ started: true, streak: 0, bestStreak: 0 })).not.toContain("Серия:");
  });

  it("награда за сегодня получена: кнопки нет, строка «получена»", () => {
    const markup = card({ started: true, streak: 2, bestStreak: 2, lastResult: "present", rewardedToday: true });
    expect(markup).toContain("Награда за сегодня получена");
    expect(markup).not.toContain("<button");
  });

  it("bio скрыто: текст про приватность и кнопка «Проверить» остаётся", () => {
    const markup = card({ kind: "bio", started: true, lastResult: "hidden" });
    expect(markup).toContain("пустое или закрыто настройками приватности");
    expect(markup).toContain("Проверить");
    expect(markup).toContain("<button");
  });

  it("не нашли: строка своего вида и кнопка «Проверить»", () => {
    expect(card({ kind: "name", started: true, lastResult: "absent" })).toContain("В имени юзернейм не нашли");
    expect(card({ kind: "bio", started: true, lastResult: "absent" })).toContain("В bio юзернейм не нашли");
  });

  it("загрузка: у кнопки признак занятости", () => {
    expect(card({ started: true }, { loading: true })).toContain('aria-busy="true"');
    expect(card({ started: true }, { loading: false })).toContain('aria-busy="false"');
  });

  it("сообщение после ответа показывается под кнопкой", () => {
    expect(card({ started: true }, { message: "Площадка не ответила. Попробуйте чуть позже." })).toContain("Площадка не ответила");
  });

  it("юзернейм можно выделить и он не обрезается: свой элемент с выделением и переносом", () => {
    const markup = card({}, { botUsername: "very_long_bot_username_that_must_wrap_on_a_phone_bot" });
    const match = /<span[^>]*class="([^"]*)"[^>]*>@very_long_bot_username_that_must_wrap_on_a_phone_bot<\/span>/.exec(markup);
    expect(match).not.toBeNull();
    expect(match?.[1]).toContain("select-text");
    expect(match?.[1]).toContain("break-all");
    expect(match?.[1]).toContain("font-mono");
  });

  it("в карточке нет анимации появления: блок без движения", () => {
    expect(card()).not.toContain("animate-");
  });
});
