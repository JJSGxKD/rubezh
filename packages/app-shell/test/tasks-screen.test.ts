import { describe, expect, it } from "vitest";
import { unseenPartnerShows } from "../src/screens/meta/tasks";
import type { TaskItem } from "../src/state/tasks-api";

// Показы партнёрских заданий (tasks/T-0224): событие task_shown на каждую
// партнёрскую цель, которую карточка реально нарисовала в списке. Экран
// запоминает показанные id на время открытия, поэтому повторная загрузка
// того же списка новых событий не даёт.

function task(patch: Partial<TaskItem> & Pick<TaskItem, "id" | "kind">): TaskItem {
  return {
    period: "achievement",
    category: undefined,
    title: null,
    target: 1,
    value: 0,
    done: false,
    claimed: false,
    reward: { coins: 0, gems: 0, shards: 0 },
    passPoints: 0,
    ...patch,
  } as TaskItem;
}

const partnerChannel = task({ id: "partner_channel", kind: "channel", category: "partner" });
const partnerBot = task({ id: "partner_bot", kind: "bot", category: "partner" });
const runTask = task({ id: "daily_runs", kind: "runs", period: "daily" });

describe("показы партнёрских заданий", () => {
  it("список с двумя партнёрскими заданиями и заданием забега — два показа с id и видом цели", () => {
    const shown = unseenPartnerShows([partnerChannel, runTask, partnerBot], new Set());
    expect(shown.map((item) => ({ task: item.id, kind: item.kind }))).toEqual([
      { task: "partner_channel", kind: "channel" },
      { task: "partner_bot", kind: "bot" },
    ]);
  });

  it("повторная загрузка того же списка на том же экране — показов нет", () => {
    const seen = new Set<string>();
    for (const item of unseenPartnerShows([partnerChannel, partnerBot], seen)) seen.add(item.id);
    expect(unseenPartnerShows([partnerChannel, partnerBot], seen)).toEqual([]);
  });

  it("новое партнёрское задание в обновлённом списке показывается, старое — нет", () => {
    const seen = new Set(["partner_channel"]);
    const shown = unseenPartnerShows([partnerChannel, partnerBot], seen);
    expect(shown.map((item) => item.id)).toEqual(["partner_bot"]);
  });

  it("без партнёрских заданий показов нет", () => {
    expect(unseenPartnerShows([runTask], new Set())).toEqual([]);
    expect(unseenPartnerShows([], new Set())).toEqual([]);
  });
});
