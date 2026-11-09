import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { OnlinePillView } from "../src/app/OnlinePill";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import {
  ONLINE_FAILURES_TO_HIDE,
  createOnlinePinger,
  formatOnlineCount,
  onlinePlacement,
  onlineView,
  resetOnlineForTests,
  runCaption,
  useOnline,
  type OnlineEnv,
} from "../src/state/online";

// Счётчик онлайна (Р107, tasks/T-0148): пинг раз в `nextPingSec`, только пока
// приложение видимо; числа приходят порогованными с сервера, клиент ничего не
// решает. Счётчик — сведения, а не функция: сбой оставляет прежние числа, а
// три сбоя подряд убирают плашку вовсе.

interface Sent {
  path: string;
  body: unknown;
}

/** Сервер, который разбирает ответ той же схемой, что и настоящий `apiRequest`. */
function server(sent: Sent[], answers: unknown[]): ApiRequest {
  return async <T,>(path: string, schema: object, init: { method: string; body?: unknown }): Promise<ApiResult<T>> => {
    sent.push({ path, body: init.body });
    const answer = answers.shift();
    if (answer === undefined) return { ok: false, failure: "offline" };
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

function reply(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { online: 128, inRun: 37, todayPlayed: null, nextPingSec: 45, ...overrides };
}

/** Часы и таймеры в руках теста: время идёт только по `advance`. */
function rig(answers: unknown[], patch: Partial<OnlineEnv> = {}) {
  const sent: Sent[] = [];
  let now = 1_000_000;
  let timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  const state = { visible: true, inRun: false, lastApiAt: 0 };
  const env: OnlineEnv = {
    request: server(sent, answers),
    now: () => now,
    visible: () => state.visible,
    inRun: () => state.inRun,
    lastApiAt: () => state.lastApiAt,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer: (handle) => {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    ...patch,
  };
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      timers = timers.filter((timer) => timer.id !== due.id);
      now = Math.max(now, due.at);
      due.fn();
      await settle();
    }
    now = until;
  };
  return { env, sent, state, advance, pending: () => timers.length, now: () => now, setNow: (value: number) => (now = value) };
}

/** Промисы пинга и разбора ответа доезжают за несколько микрозадач. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  resetOnlineForTests();
});

describe("пинг: когда идёт", () => {
  it("первый пинг уходит при старте, с inRun: false", async () => {
    const test = rig([reply()]);
    createOnlinePinger(test.env).start();
    await settle();
    expect(test.sent).toEqual([{ path: "/api/v1/online/ping", body: { inRun: false } }]);
    expect(useOnline.getState()).toMatchObject({ online: 128, inRun: 37, todayPlayed: null, failures: 0 });
  });

  it("следующий пинг — через nextPingSec из ответа, не раньше", async () => {
    const test = rig([reply({ nextPingSec: 45 }), reply({ online: 130 })]);
    createOnlinePinger(test.env).start();
    await settle();
    await test.advance(44_000);
    expect(test.sent).toHaveLength(1);
    await test.advance(1_000);
    expect(test.sent).toHaveLength(2);
    expect(useOnline.getState().online).toBe(130);
  });

  it("интервал сервера держат в пределах: секунда — не чаще 15 с, час — не реже 300 с", async () => {
    const fast = rig([reply({ nextPingSec: 1 }), reply()]);
    createOnlinePinger(fast.env).start();
    await settle();
    await fast.advance(14_000);
    expect(fast.sent).toHaveLength(1);
    await fast.advance(1_000);
    expect(fast.sent).toHaveLength(2);

    resetOnlineForTests();
    const slow = rig([reply({ nextPingSec: 3_600 }), reply()]);
    createOnlinePinger(slow.env).start();
    await settle();
    await slow.advance(299_000);
    expect(slow.sent).toHaveLength(1);
    await slow.advance(1_000);
    expect(slow.sent).toHaveLength(2);
  });

  it("пока приложение скрыто, пинга нет; вернулись и срок вышел — пинг сразу", async () => {
    const test = rig([reply(), reply({ online: 140 })]);
    const pinger = createOnlinePinger(test.env);
    pinger.start();
    await settle();
    test.state.visible = false;
    await test.advance(200_000);
    expect(test.sent).toHaveLength(1);
    test.state.visible = true;
    pinger.wake();
    await settle();
    expect(test.sent).toHaveLength(2);
    expect(useOnline.getState().online).toBe(140);
  });

  it("вернулись раньше срока — пинга сразу нет, он ждёт своего часа", async () => {
    const test = rig([reply(), reply()]);
    const pinger = createOnlinePinger(test.env);
    pinger.start();
    await settle();
    await test.advance(10_000);
    pinger.wake();
    await settle();
    expect(test.sent).toHaveLength(1);
    await test.advance(35_000);
    expect(test.sent).toHaveLength(2);
  });

  it("запуск при скрытом приложении ждёт, пока оно станет видимым", async () => {
    const test = rig([reply()]);
    test.state.visible = false;
    const pinger = createOnlinePinger(test.env);
    pinger.start();
    await settle();
    expect(test.sent).toHaveLength(0);
    test.state.visible = true;
    pinger.wake();
    await settle();
    expect(test.sent).toHaveLength(1);
  });

  it("если за промежуток был другой запрос в API, пинг пропускается: сервер и так видел игрока", async () => {
    const test = rig([reply(), reply({ online: 131 })]);
    createOnlinePinger(test.env).start();
    await settle();
    test.state.lastApiAt = test.now() + 10_000;
    await test.advance(45_000);
    expect(test.sent).toHaveLength(1);
    // Следующий срок — тихий: пинг идёт.
    await test.advance(45_000);
    expect(test.sent).toHaveLength(2);
  });

  it("запрос, случившийся до пинга, пинг не отменяет", async () => {
    const test = rig([reply(), reply()]);
    test.state.lastApiAt = test.now() - 5_000;
    createOnlinePinger(test.env).start();
    await settle();
    await test.advance(45_000);
    expect(test.sent).toHaveLength(2);
  });

  it("в забеге пинг идёт всегда и с inRun: true, даже если были другие запросы", async () => {
    const test = rig([reply(), reply(), reply()]);
    createOnlinePinger(test.env).start();
    await settle();
    test.state.inRun = true;
    test.state.lastApiAt = test.now() + 10_000;
    await test.advance(45_000);
    await test.advance(45_000);
    expect(test.sent.map((entry) => entry.body)).toEqual([{ inRun: false }, { inRun: true }, { inRun: true }]);
  });

  it("stop() снимает таймер, дальше пингов нет", async () => {
    const test = rig([reply(), reply()]);
    const pinger = createOnlinePinger(test.env);
    pinger.start();
    await settle();
    pinger.stop();
    expect(test.pending()).toBe(0);
    await test.advance(120_000);
    expect(test.sent).toHaveLength(1);
  });
});

describe("числа и плашка", () => {
  it("онлайн есть — «сейчас»; онлайна нет, а сегодняшние есть — «сегодня играли»", () => {
    expect(onlineView({ online: 128, inRun: null, todayPlayed: null })).toEqual({ kind: "now", count: 128 });
    expect(onlineView({ online: null, inRun: null, todayPlayed: 3_400 })).toEqual({ kind: "today", count: 3_400 });
  });

  it("все числа null или ноль — плашки нет, без заглушки", () => {
    expect(onlineView({ online: null, inRun: null, todayPlayed: null })).toBeNull();
    expect(onlineView({ online: 0, inRun: 0, todayPlayed: 0 })).toBeNull();
  });

  it("«в забеге» — подпись для «Играть» только при положительном числе", () => {
    expect(runCaption({ inRun: 37 })).toBe(37);
    expect(runCaption({ inRun: null })).toBeNull();
    expect(runCaption({ inRun: 0 })).toBeNull();
  });

  it("ответ с online: null кладёт todayPlayed в стор", async () => {
    const test = rig([reply({ online: null, inRun: null, todayPlayed: 3_400 })]);
    createOnlinePinger(test.env).start();
    await settle();
    expect(onlineView(useOnline.getState())).toEqual({ kind: "today", count: 3_400 });
    expect(runCaption(useOnline.getState())).toBeNull();
  });

  it("числа до тысячи — как есть, до десяти тысяч — «1,2 тыс.», дальше — «12 тыс.»", () => {
    const clean = (text: string): string => text.replaceAll(" ", " ").replaceAll(" ", " ");
    expect(clean(formatOnlineCount(0))).toBe("0");
    expect(clean(formatOnlineCount(128))).toBe("128");
    expect(clean(formatOnlineCount(999))).toBe("999");
    expect(clean(formatOnlineCount(1_000))).toBe("1 тыс.");
    expect(clean(formatOnlineCount(1_234))).toBe("1,2 тыс.");
    // Вниз, а не к ближайшему: плашка не показывает больше, чем есть.
    expect(clean(formatOnlineCount(1_999))).toBe("1,9 тыс.");
    expect(clean(formatOnlineCount(9_999))).toBe("9,9 тыс.");
    expect(clean(formatOnlineCount(12_400))).toBe("12 тыс.");
    expect(clean(formatOnlineCount(130_000))).toBe("130 тыс.");
  });
});

describe("сбои", () => {
  it("сбой оставляет прежние числа до следующего пинга", async () => {
    const test = rig([reply(), { мусор: true }]);
    createOnlinePinger(test.env).start();
    await settle();
    await test.advance(45_000);
    expect(useOnline.getState()).toMatchObject({ online: 128, inRun: 37, failures: 1 });
  });

  it("три сбоя подряд — плашки нет; удачный ответ возвращает её", async () => {
    const test = rig([reply(), "битый", "битый", "битый", reply({ online: 150 })]);
    createOnlinePinger(test.env).start();
    await settle();
    expect(ONLINE_FAILURES_TO_HIDE).toBe(3);
    await test.advance(45_000);
    await test.advance(45_000);
    expect(onlineView(useOnline.getState())).toEqual({ kind: "now", count: 128 });
    await test.advance(45_000);
    expect(useOnline.getState().failures).toBe(3);
    expect(onlineView(useOnline.getState())).toBeNull();
    expect(runCaption(useOnline.getState())).toBeNull();
    await test.advance(45_000);
    expect(onlineView(useOnline.getState())).toEqual({ kind: "now", count: 150 });
    expect(useOnline.getState().failures).toBe(0);
  });

  it("удача между сбоями обнуляет счёт: два сбоя, удача, два сбоя — плашка на месте", async () => {
    const test = rig([reply(), "битый", "битый", reply(), "битый", "битый"]);
    createOnlinePinger(test.env).start();
    await settle();
    for (let index = 0; index < 5; index++) await test.advance(45_000);
    expect(useOnline.getState().failures).toBe(2);
    expect(onlineView(useOnline.getState())).toEqual({ kind: "now", count: 128 });
  });

  it("битый ответ — как ошибка: числа не меняются, строка вместо числа не принимается", async () => {
    const test = rig([reply(), reply({ online: "много" }), reply({ nextPingSec: "скоро" }), reply({ inRun: -1 })]);
    createOnlinePinger(test.env).start();
    await settle();
    await test.advance(45_000);
    await test.advance(45_000);
    await test.advance(45_000);
    expect(useOnline.getState()).toMatchObject({ online: 128, inRun: 37, failures: 3 });
  });

  it("сеть пропала (запрос не ушёл) — тоже сбой, пинг не останавливается", async () => {
    const test = rig([reply()]);
    createOnlinePinger(test.env).start();
    await settle();
    await test.advance(45_000);
    expect(useOnline.getState().failures).toBe(1);
    await test.advance(45_000);
    expect(test.sent).toHaveLength(3);
  });
});

describe("где стоит плашка", () => {
  it("в полосе кнопок — если площадка её отдала", () => {
    expect(onlinePlacement({ wide: false, bar: { top: 47, height: 44 } })).toBe("bar");
  });

  it("без полосы кнопок — строкой под шапкой", () => {
    expect(onlinePlacement({ wide: false, bar: null })).toBe("subline");
  });

  it("на ПК — в широкой шапке, полоса кнопок планшета в ландшафте не перебивает", () => {
    expect(onlinePlacement({ wide: true, bar: null })).toBe("header");
    expect(onlinePlacement({ wide: true, bar: { top: 20, height: 44 } })).toBe("header");
  });
});

describe("плашка: вёрстка", () => {
  const html = (view: Parameters<typeof OnlinePillView>[0]["view"], variant: "bar" | "subline" | "header") =>
    renderToStaticMarkup(createElement(OnlinePillView, { view, variant }));

  it("«128 онлайн» с точкой «сейчас» и полной подписью для чтения с экрана", () => {
    const markup = html({ kind: "now", count: 128 }, "subline");
    expect(markup).toContain("128 онлайн");
    expect(markup).toContain('aria-label="128 игроков онлайн"');
    expect(markup).toContain('data-online-dot=""');
  });

  it("в полосе кнопок слово прячется на узких экранах, число и подпись остаются", () => {
    const markup = html({ kind: "now", count: 128 }, "bar");
    expect(markup).toContain("min-[360px]:inline");
    expect(markup).toContain('aria-label="128 игроков онлайн"');
  });

  it("«сегодня играли» — без точки: точка значит «сейчас»", () => {
    const markup = html({ kind: "today", count: 3_400 }, "subline");
    expect(markup).toContain("сегодня играли");
    expect(markup).toContain("3,4 тыс.");
    expect(markup).not.toContain("data-online-dot");
  });

  it("чисел нет — плашки нет", () => {
    expect(html(null, "subline")).toBe("");
  });

  it("плашка не кнопка: цель нажатия ей не нужна, жесты проходят насквозь", () => {
    expect(html({ kind: "now", count: 5 }, "bar")).not.toContain("<button");
  });
});
