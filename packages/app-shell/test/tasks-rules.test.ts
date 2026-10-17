import { describe, expect, it } from "vitest";
import { initialTasksView, TASK_TAB_OF, TASKS_VIEW_ORDER, viewAfterLoad } from "../src/screens/meta/tasks-rules";

// Вкладка «Заданий» при открытии (tasks/T-0098): первая по порядку, где ждёт награда.
const task = (period: "daily" | "weekly" | "achievement", done: boolean, claimed: boolean, partner = false) => ({
  period,
  done,
  claimed,
  ...(partner ? { category: "partner" } : {}),
});

describe("вкладка заданий при открытии", () => {
  it("готового нет, партнёрских нет — «День»", () => {
    expect(initialTasksView({ tasks: [], hasPartner: false })).toBe("daily");
  });

  it("готового нет, партнёрские есть — «Партнёры»", () => {
    expect(initialTasksView({ tasks: [], hasPartner: true })).toBe("partner");
  });

  it("готово только в недельных — «Неделя»", () => {
    expect(initialTasksView({ tasks: [task("weekly", true, false)], hasPartner: false })).toBe("weekly");
  });

  it("готово только в достижениях — «Достижения»", () => {
    expect(initialTasksView({ tasks: [task("achievement", true, false)], hasPartner: false })).toBe("achievements");
  });

  it("готово в недельных и достижениях — первая по порядку, «Неделя»", () => {
    const tasks = [task("achievement", true, false), task("weekly", true, false)];
    expect(initialTasksView({ tasks, hasPartner: false })).toBe("weekly");
  });

  it("готово в ежедневных и недельных — «День»", () => {
    const tasks = [task("weekly", true, false), task("daily", true, false)];
    expect(initialTasksView({ tasks, hasPartner: false })).toBe("daily");
  });

  it("готово в партнёрских и ежедневных — «Партнёры»: партнёрское считается своей вкладкой", () => {
    const tasks = [task("daily", true, false), task("daily", true, false, true)];
    expect(initialTasksView({ tasks, hasPartner: true })).toBe("partner");
  });

  it("готово только в недельных, партнёрские есть — «Неделя»: награда важнее вкладки по умолчанию", () => {
    expect(initialTasksView({ tasks: [task("weekly", true, false)], hasPartner: true })).toBe("weekly");
  });

  it("выполнено и уже забрано — вкладка по умолчанию", () => {
    expect(initialTasksView({ tasks: [task("daily", true, true)], hasPartner: false })).toBe("daily");
    expect(initialTasksView({ tasks: [task("weekly", true, true)], hasPartner: true })).toBe("partner");
  });

  it("не выполнено — вкладка по умолчанию", () => {
    expect(initialTasksView({ tasks: [task("weekly", false, false)], hasPartner: false })).toBe("daily");
  });
});

describe("вкладка после ответа сервера", () => {
  it("выбор игрока не перебивается, даже если есть награда в другой вкладке", () => {
    expect(viewAfterLoad({ chosen: "achievements", tasks: [task("daily", true, false)], hasPartner: false })).toBe("achievements");
  });

  it("выбора не было — открывается вкладка с наградой", () => {
    expect(viewAfterLoad({ chosen: null, tasks: [task("weekly", true, false)], hasPartner: false })).toBe("weekly");
  });

  it("выбор «День» остаётся, даже когда список пуст и партнёрские есть", () => {
    expect(viewAfterLoad({ chosen: "daily", tasks: [], hasPartner: true })).toBe("daily");
  });
});

describe("порядок вкладок", () => {
  it("порядок — «Партнёры», «День», «Неделя», «Достижения»", () => {
    expect(TASKS_VIEW_ORDER).toEqual(["partner", "daily", "weekly", "achievements"]);
  });

  it("у каждой вкладки есть соответствие с категорией заданий", () => {
    for (const view of TASKS_VIEW_ORDER) {
      expect(TASK_TAB_OF[view]).toBeDefined();
    }
    expect(TASK_TAB_OF.achievements).toBe("achievement");
  });
});
