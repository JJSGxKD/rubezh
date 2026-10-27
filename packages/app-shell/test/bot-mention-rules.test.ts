import ruTasks from "../src/i18n/ru-tasks.json";
import { describe, expect, it } from "vitest";
import { buttonKey, outcomeKey, statusKey, visibleTasks } from "../src/screens/meta/bot-mention-rules";
import type { BotMentionTask, BotMentionView } from "../src/state/bot-mention-api";

// Правила блока «юзернейм бота» (tasks/T-0160): что показать, какая строка
// состояния и подпись кнопки. Клиент ничего не считает — только выбирает текст
// по ответу сервера.

const REWARD = { coins: 50, gems: 0, shards: 0 };

function task(patch: Partial<BotMentionTask> = {}): BotMentionTask {
  return { kind: "name", reward: REWARD, started: true, streak: 0, bestStreak: 0, rewardedToday: false, lastResult: null, checkedAt: null, ...patch };
}

const view = (tasks: BotMentionTask[], botUsername: string | null = "game_bot"): BotMentionView => ({ botUsername, tasks });
const texts = ruTasks as Record<string, string>;

describe("какие виды показывать", () => {
  it("без юзернейма бота блока нет", () => {
    expect(visibleTasks(view([task()], null))).toEqual([]);
  });

  it("порядок — имя, потом bio; незнакомый вид пропускается", () => {
    const tasks = [task({ kind: "bio" }), task({ kind: "other" }), task({ kind: "name" })];
    expect(visibleTasks(view(tasks)).map((entry) => entry.kind)).toEqual(["name", "bio"]);
  });

  it("пустой список — пусто", () => {
    expect(visibleTasks(view([]))).toEqual([]);
  });
});

describe("строка состояния", () => {
  it("не начато или проверок не было — нет строки", () => {
    expect(statusKey(task({ started: false, lastResult: "absent" }))).toBeNull();
    expect(statusKey(task({ started: true, lastResult: null }))).toBeNull();
  });

  it("не нашли: у имени и у bio своя фраза", () => {
    expect(statusKey(task({ kind: "name", lastResult: "absent" }))).toBe("botMention.status.absent.name");
    expect(statusKey(task({ kind: "bio", lastResult: "absent" }))).toBe("botMention.status.absent.bio");
  });

  it("bio скрыто — общая фраза у обоих видов", () => {
    expect(statusKey(task({ kind: "bio", lastResult: "hidden" }))).toBe("botMention.status.hidden");
    expect(statusKey(task({ kind: "name", lastResult: "hidden" }))).toBe("botMention.status.hidden");
  });

  it("нашли и награда за сегодня получена — «получена»; нашли без награды — строки нет", () => {
    expect(statusKey(task({ lastResult: "present", rewardedToday: true }))).toBe("botMention.status.rewarded");
    expect(statusKey(task({ lastResult: "present", rewardedToday: false }))).toBeNull();
  });

  it("проверить нельзя — «не получается»", () => {
    expect(statusKey(task({ lastResult: "unavailable" }))).toBe("botMention.status.unavailable");
  });
});

describe("кнопка", () => {
  it("не начато — «Начать», начато — «Проверить», награда за сегодня — кнопки нет", () => {
    expect(buttonKey(task({ started: false }))).toBe("botMention.start");
    expect(buttonKey(task({ started: true }))).toBe("botMention.check");
    expect(buttonKey(task({ started: true, rewardedToday: true }))).toBeNull();
  });
});

describe("сообщение под кнопкой", () => {
  it("каждый из шести исходов — свой ключ", () => {
    const keys = ["present", "absent", "hidden", "unavailable", "retry", "done_today"].map((outcome) => outcomeKey(outcome));
    expect(keys).toEqual([
      "botMention.outcome.present",
      "botMention.outcome.absent",
      "botMention.outcome.hidden",
      "botMention.outcome.unavailable",
      "botMention.outcome.retry",
      "botMention.outcome.done_today",
    ]);
  });

  it("незнакомый исход — «не получилось проверить»", () => {
    expect(outcomeKey("weird")).toBe("botMention.outcome.failed");
    expect(outcomeKey("")).toBe("botMention.outcome.failed");
  });
});

describe("тексты", () => {
  it("каждый ключ из правил есть в словаре заданий, и тексты — дословно из спецификации", () => {
    const keys = new Set<string>(["botMention.start", "botMention.check", "botMention.outcome.failed"]);
    for (const kind of ["name", "bio"]) {
      for (const lastResult of ["present", "absent", "hidden", "unavailable", null] as const) {
        const key = statusKey(task({ kind, lastResult, rewardedToday: lastResult === "present" }));
        if (key !== null) keys.add(key);
      }
    }
    for (const outcome of ["present", "absent", "hidden", "unavailable", "retry", "done_today", "weird"]) keys.add(outcomeKey(outcome));
    for (const key of keys) expect(texts[key] ?? "", key).not.toBe("");

    expect(texts["botMention.title"]).toBe("Юзернейм бота");
    expect(texts["botMention.name.title"]).toBe("Юзернейм бота в имени");
    expect(texts["botMention.bio.title"]).toBe("Юзернейм бота в bio");
    expect(texts["botMention.name.hint"]).toBe("Впиши {bot} в имя своего профиля. Награда — за каждые игровые сутки, пока он там стоит.");
    expect(texts["botMention.bio.hint"]).toBe("Впиши {bot} в раздел «О себе» своего профиля. Награда — за каждые игровые сутки, пока он там стоит.");
    expect(texts["botMention.auto"]).toBe("Мы сами проверяем раз в игровые сутки — награда придёт без твоего участия.");
    expect(texts["botMention.streak"]).toBe("Серия: {n} {n, plural, one {день} few {дня} many {дней} other {дня}}");
    expect(texts["botMention.best"]).toBe("Лучшая серия: {n}");
    expect(texts["botMention.outcome.present"]).toBe("Нашли! Получено: {what}");
    expect(texts["botMention.status.hidden"]).toBe("Не видим твоё bio: оно пустое или закрыто настройками приватности.");
  });
});
