import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { allTimeSchema, fetchAllTime, platformLine, recordLine, reachableShare, starsLine, type AllTime } from "../src/api/all-time";
import { formatNumber } from "../src/format";
import { ALL_TIME_HELP, AllTimeView } from "../src/screens/overview/AllTimePanel";
import { fakeFetch, json } from "./helpers";

/**
 * Панель «Чего достигли» (tasks/T-0203): строки платформ, рекордов и звёзд,
 * разбор ответа схемой, плитки и их подсказки дословно, состояния без права и
 * без данных.
 */

const AT = "2026-10-20T09:00:00.000Z";

const DATA: AllTime = {
  at: AT,
  accounts: {
    total: 1600,
    banned: 4,
    byPlatform: [
      { platform: "telegram", total: 1200 },
      { platform: "vk", total: 340 },
      { platform: "max", total: 60 },
      { platform: "web", total: 0 },
    ],
  },
  reachable: {
    total: 900,
    byPlatform: [
      { platform: "telegram", total: 800 },
      { platform: "vk", total: 100 },
    ],
  },
  played: { players: 900, runs: 5000 },
  revenue: { stars: 380, paid: 500, refunded: 120, purchases: 12, donations: 0 },
  records: {
    dau: { value: 130, day: "2026-10-20", now: 130 },
    wau: { value: 300, day: "2026-10-14", now: 250 },
    mau: { value: 700, day: "2025-12-31", now: 650 },
  },
};

const EMPTY: AllTime = {
  at: AT,
  accounts: { total: 0, banned: 0, byPlatform: [] },
  reachable: { total: 0, byPlatform: [] },
  played: { players: 0, runs: 0 },
  revenue: null,
  records: { dau: null, wau: null, mau: null },
};

describe("platformLine", () => {
  it("крупные платформы первыми, названия для людей", () => {
    expect(
      platformLine([
        { platform: "vk", total: 340 },
        { platform: "telegram", total: 1200 },
        { platform: "max", total: 60 },
        { platform: "web", total: 7 },
      ]),
    ).toBe(`Telegram ${formatNumber(1200)} · VK 340 · MAX 60 · Веб 7`);
  });

  it("платформы с нулём пропускаются", () => {
    expect(platformLine([{ platform: "telegram", total: 5 }, { platform: "vk", total: 0 }])).toBe("Telegram 5");
  });

  it("при равенстве — по порядку площадок, а не как пришло", () => {
    expect(platformLine([{ platform: "vk", total: 5 }, { platform: "telegram", total: 5 }])).toBe("Telegram 5 · VK 5");
  });

  it("пусто — «пока никого»", () => {
    expect(platformLine([])).toBe("пока никого");
    expect(platformLine([{ platform: "web", total: 0 }])).toBe("пока никого");
  });

  it("незнакомая площадка с будущего сервера показывается ключом, а не пропадает", () => {
    expect(platformLine([{ platform: "ok", total: 3 }])).toBe("ok 3");
  });

  it("не меняет переданный список", () => {
    const rows = [{ platform: "vk", total: 1 }, { platform: "telegram", total: 2 }];
    platformLine(rows);
    expect(rows.map((row) => row.platform)).toEqual(["vk", "telegram"]);
  });
});

describe("recordLine", () => {
  it("дата словами по-московски, число с разрядами", () => {
    expect(recordLine({ value: 5421, day: "2026-10-14", now: 100 }, AT)).toBe(`рекорд ${formatNumber(5421)} — 14 октября`);
  });

  it("год добавляется, если не текущий", () => {
    expect(recordLine({ value: 10, day: "2025-12-31", now: 1 }, AT)).toBe("рекорд 10 — 31 декабря 2025");
    // 01:00 UTC 1 января — уже 04:00 по Москве, год новый: прошлый добавляется.
    expect(recordLine({ value: 10, day: "2026-12-31", now: 1 }, "2027-01-01T01:00:00.000Z")).toBe("рекорд 10 — 31 декабря 2026");
  });

  it("текущие сутки по Москве — «сегодня, ещё идёт»", () => {
    expect(recordLine({ value: 130, day: "2026-10-20", now: 130 }, AT)).toBe("рекорд 130 — сегодня, ещё идёт");
    // 20:59 UTC — ещё 23:59 по Москве; 21:00 UTC — уже следующие сутки.
    expect(recordLine({ value: 1, day: "2026-10-20", now: 1 }, "2026-10-20T20:59:00.000Z")).toBe("рекорд 1 — сегодня, ещё идёт");
    expect(recordLine({ value: 1, day: "2026-10-20", now: 1 }, "2026-10-20T21:00:00.000Z")).toBe("рекорд 1 — 20 октября");
  });

  it("рекорда нет — «рекордов пока нет»", () => {
    expect(recordLine(null, AT)).toBe("рекордов пока нет");
  });
});

describe("starsLine и доля", () => {
  it("донаты в подписи — только когда они есть", () => {
    expect(starsLine({ stars: 380, paid: 1500, refunded: 120, purchases: 12, donations: 3 })).toBe(`оплачено ${formatNumber(1500)} · возвращено 120 · покупок 12 · донатов 3`);
  });

  it("оплачено, возвращено, покупок", () => {
    expect(starsLine({ stars: 380, paid: 1500, refunded: 120, purchases: 12, donations: 0 })).toBe(`оплачено ${formatNumber(1500)} · возвращено 120 · покупок 12`);
  });

  it("доля «можно писать» — целым процентом от всех; аккаунтов нет — ноль", () => {
    expect(reachableShare(900, 1600)).toBe(56);
    expect(reachableShare(1, 3)).toBe(33);
    expect(reachableShare(0, 0)).toBe(0);
  });
});

describe("разбор ответа и запрос", () => {
  it("ответ с доходом и ответ без него (revenue: null) принимаются", () => {
    expect(allTimeSchema.safeParse(DATA).success).toBe(true);
    expect(allTimeSchema.safeParse({ ...DATA, revenue: null }).success).toBe(true);
    expect(allTimeSchema.safeParse(EMPTY).success).toBe(true);
  });

  it("мусор не разбирается: панель скажет «ответ не разобрался», а не нарисует undefined", () => {
    expect(allTimeSchema.safeParse({ ...DATA, accounts: 5 }).success).toBe(false);
    expect(allTimeSchema.safeParse({ ...DATA, records: { dau: { value: 1 }, wau: null, mau: null } }).success).toBe(false);
  });

  it("запрос идёт на /admin/overview/all-time, без параметров", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: DATA }));
    const result = await fetchAllTime(new AdminApi(fetch));
    expect(calls[0]?.url).toBe("/api/v1/admin/overview/all-time");
    expect(result.ok && result.data.accounts.total).toBe(1600);
  });

  it("ошибка сервера доходит как ошибка, а не как пустые данные", async () => {
    const { fetch } = fakeFetch(json(500, { error: { code: "internal_error", message: "Внутренняя ошибка сервера" } }));
    const result = await fetchAllTime(new AdminApi(fetch));
    expect(result.ok).toBe(false);
  });
});

describe("тексты подсказок — дословно из спецификации", () => {
  it("панель", () => {
    expect(ALL_TIME_HELP.panel).toBe("Итоги за всё время из базы. Цифры кешируются на пять минут, поэтому могут отставать от сводки выше. Рекламные выплаты сетей в них не входят: денег от сетей в базе нет.");
  });
  it("аккаунты", () => {
    expect(ALL_TIME_HELP.accounts).toBe("Все аккаунты, в том числе команды и заблокированные: так же считает ежедневный отчёт в чат. Аккаунты на разных площадках — разные, одного человека на двух площадках мы не склеиваем.");
  });
  it("можно писать", () => {
    expect(ALL_TIME_HELP.reachable).toBe("Аккаунты, которым бот может написать: игрок вошёл в канал площадки или разрешил сообщения и не заблокировал бота. Это аудитория рассылок.");
  });
  it("играло людей", () => {
    expect(ALL_TIME_HELP.played).toBe("Игроки хотя бы с одним законченным забегом без читов. Забеги стирает вайп, поэтому и игроки, и забеги считаются с последнего вайпа.");
  });
  it("доход", () => {
    expect(ALL_TIME_HELP.revenue).toBe("Звёзды живых оплат за всё время минус возвраты, тестовые оплаты не считаются. В рубли и доллары не пересчитываем: курс на дату оплаты не хранится.");
  });
  it("рекорды", () => {
    expect(ALL_TIME_HELP.records).toBe("Лучшие сутки по числу разных игроков, запускавших игру: за сутки (DAU), за 7 суток (WAU) и за 30 суток (MAU), считая сутки по Москве. История — по сессиям запуска, вайп её не стирает. Сегодняшние сутки учитываются сразу, пока не закончились.");
  });
});

describe("плитки", () => {
  const html = (data: AllTime) => renderToStaticMarkup(createElement(AllTimeView, { data }));

  it("четыре плитки итогов с подписями", () => {
    const markup = html(DATA);
    for (const title of ["Аккаунтов всего", "Можно писать в бота", "Играло людей", "Доход, звёзд"]) expect(markup).toContain(title);
    expect(markup).toContain(formatNumber(1600));
    expect(markup).toContain(`Telegram ${formatNumber(1200)} · VK 340 · MAX 60`);
    expect(markup).toContain("заблокировано 4");
    expect(markup).toContain("56% от всех");
    expect(markup).toContain(`забегов ${formatNumber(5000)}`);
    expect(markup).toContain(`оплачено ${formatNumber(500)} · возвращено 120 · покупок 12`);
    expect(markup).toContain(">380<");
  });

  it("все подсказки на месте и дословно", () => {
    const markup = html(DATA);
    for (const text of [ALL_TIME_HELP.accounts, ALL_TIME_HELP.reachable, ALL_TIME_HELP.played, ALL_TIME_HELP.revenue, ALL_TIME_HELP.records]) expect(markup).toContain(text);
  });

  it("с доходом сетка на широком экране в четыре колонки, без дохода — в три", () => {
    expect(html(DATA)).toContain("lg:grid-cols-4");
    const without = html({ ...DATA, revenue: null });
    expect(without).toContain("lg:grid-cols-3");
    expect(without).not.toContain("lg:grid-cols-4");
  });

  it("без права на доход плитки нет вовсе, а не нуль", () => {
    const markup = html({ ...DATA, revenue: null });
    expect(markup).not.toContain("Доход, звёзд");
    expect(markup).not.toContain("оплачено");
    expect(markup).toContain("Аккаунтов всего");
  });

  it("заблокированных нет — строки «заблокировано» нет", () => {
    expect(html({ ...DATA, accounts: { ...DATA.accounts, banned: 0 } })).not.toContain("заблокировано");
  });

  it("рекорды: три плитки, дата словами, «сейчас», сегодняшние — «сегодня, ещё идёт»", () => {
    const markup = html(DATA);
    for (const title of ["Рекорд DAU", "Рекорд WAU", "Рекорд MAU", "Рекорды аудитории"]) expect(markup).toContain(title);
    expect(markup).toContain("сегодня, ещё идёт");
    expect(markup).toContain("14 октября");
    expect(markup).toContain("31 декабря 2025");
    expect(markup).toContain("сейчас 130");
    expect(markup).toContain("сейчас 250");
    expect(markup).toContain("сейчас 650");
  });

  it("пусто (новая база): нули, «пока никого», «рекордов пока нет»; панель не падает", () => {
    const markup = html(EMPTY);
    expect(markup).toContain("пока никого");
    expect(markup).toContain(">0<");
    expect(markup.match(/рекордов пока нет/g)).toHaveLength(3);
    expect(markup).not.toContain("сейчас");
  });

  it("число плитки сжимается по ширине самой плитки: семь знаков на 320 px не вылезают за рамку", () => {
    const markup = html(DATA);
    // Плитка — контейнер, размер числа берётся от его ширины (cqw), а не от окна: колонок на экране бывает две и четыре.
    expect(markup).toContain("@container");
    // Подсказка типа `length:` обязательна: без неё Tailwind принимает clamp() за цвет, и размер пропадает.
    expect(markup).toMatch(/text-\[length:clamp\(var\(--text-base\),\d+cqw,var\(--text-2xl\)\)\]/);
    // Фиксированный размер числа (утилита `text-2xl` отдельным классом) вернул бы вылезание.
    expect(markup).not.toMatch(/[\s"]text-2xl[\s"]/);
  });

  it("подписи переносятся, а не режутся многоточием: на телефоне горизонтального скролла нет", () => {
    const markup = html(DATA);
    expect(markup).not.toContain("truncate");
    expect(markup).toContain("break-words");
    expect(markup).toContain("grid-cols-2");
  });
});
