import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "../src/i18n/tasks";
import { BotMentionBlock, type BotMentionBlockProps } from "../src/screens/meta/bot-mention-rows";
import type { BotMentionTask } from "../src/state/bot-mention-api";

// Блок «юзернейм бота» над вкладками «Заданий» (tasks/T-0337, Р167) без
// браузера: разметка презентационного компонента.

function task(patch: Partial<BotMentionTask> = {}): BotMentionTask {
  return {
    kind: "name",
    reward: { coins: 50, gems: 0, shards: 0 },
    started: true,
    streak: 0,
    bestStreak: 0,
    rewardedToday: false,
    lastResult: null,
    checkedAt: null,
    ...patch,
  };
}

const rewarded = (patch: Partial<BotMentionTask>) => task({ rewardedToday: true, lastResult: "present", ...patch });
const BOTH_DONE = [rewarded({ kind: "name", streak: 5 }), rewarded({ kind: "bio", streak: 3 })];

function block(patch: Partial<BotMentionBlockProps> = {}): string {
  return renderToStaticMarkup(
    createElement(BotMentionBlock, {
      botUsername: "game_bot",
      tasks: BOTH_DONE,
      expanded: false,
      busyKind: null,
      messages: {},
      onToggle: () => undefined,
      onPress: () => undefined,
      ...patch,
    }),
  );
}

describe("свёрнутый вид", () => {
  it("награда у обоих видов: одна строка с серией, «Развернуть», карточек нет", () => {
    const markup = block();
    expect(markup).toContain("Серия 5 дней · завтра снова");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Развернуть");
    expect(markup).not.toContain("Юзернейм бота в имени");
    expect(markup).not.toContain("Проверить");
    expect(markup).not.toContain("Начать");
  });

  it("строка не ниже 44 px и обрезает длинное, а не переносит", () => {
    const markup = block();
    expect(markup).toContain("min-h-11");
    expect(markup).toContain("truncate");
  });

  it.each([
    [1, "Серия 1 день"],
    [2, "Серия 2 дня"],
    [5, "Серия 5 дней"],
    [11, "Серия 11 дней"],
    [21, "Серия 21 день"],
  ])("серия %i — «%s»", (streak, text) => {
    expect(block({ tasks: [rewarded({ kind: "name", streak })] })).toContain(`${text} · завтра снова`);
  });
});

describe("развёрнутый игроком", () => {
  it("кнопка «Свернуть» и обе карточки", () => {
    const markup = block({ expanded: true });
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Свернуть");
    expect(markup).toContain("Юзернейм бота в имени");
    expect(markup).toContain("Юзернейм бота в bio");
  });

  it("сообщение под кнопкой видно", () => {
    expect(block({ expanded: true, messages: { name: "Нашли! Получено: 50 монет" } })).toContain("Нашли! Получено: 50 монет");
  });
});

describe("не свёрнут", () => {
  it("награда только у одного вида: обе карточки, кнопки свёртки нет", () => {
    const markup = block({ tasks: [rewarded({ kind: "name", streak: 5 }), task({ kind: "bio", streak: 3 })] });
    expect(markup).toContain("Юзернейм бота в имени");
    expect(markup).toContain("Юзернейм бота в bio");
    expect(markup).not.toContain("aria-expanded");
  });

  it("не начато: карточки и «Начать», кнопки свёртки нет", () => {
    const markup = block({ tasks: [task({ started: false }), task({ kind: "bio", started: false })] });
    expect(markup).toContain("Начать");
    expect(markup).not.toContain("aria-expanded");
  });

  it("absent: «Проверить»", () => {
    const markup = block({ tasks: [task({ lastResult: "absent" })] });
    expect(markup).toContain("Проверить");
    expect(markup).not.toContain("aria-expanded");
  });
});

describe("скрытие", () => {
  it("без юзернейма бота — пусто", () => {
    expect(block({ botUsername: null })).toBe("");
  });

  it("пустой список видов — пусто", () => {
    expect(block({ tasks: [] })).toBe("");
  });
});
