import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CABINET_FUNNEL_TEXTS, clicksLine, fetchCabinetFunnel, funnelSourceTitle, hiddenRowText, tooFewText, type CabinetFunnel } from "../src/api/cabinet";
import { AdminApi } from "../src/api/client";
import { fakeFetch, json } from "./helpers";

// Воронка в кабинете партнёра (docs/35-stage4-plan.md Р136, tasks/T-0219): запрос с периодом, разбор ответа,
// подписи строк. Сервер уже вырезал группы меньше порога — панель только показывает строку о пороге.

const COUNTS = { accounts: 12, entered: 12, appOpened: 12, firstRunStarted: 9, firstRunFinished: 7, runs2: 5, runs5: 2, returnedD1: 6, returnedD7: 3, firstPurchase: 1 };
const FUNNEL: CabinetFunnel = {
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-31T00:00:00.000Z",
  minGroup: 10,
  clicks: 1240,
  tooFew: false,
  total: COUNTS,
  sources: [
    { via: "link", ref: "abc123def456", name: "igrovoy-ugol", source: "channel", note: "Игровой угол", counts: COUNTS },
    { via: "link", ref: "zzz999", name: "post-5", source: "post", note: null, counts: null },
    { via: "code", ref: "7b0c0f6e", name: "KANAL 2026", source: null, note: null, counts: null },
  ],
  platforms: [{ platform: "telegram", counts: COUNTS }],
  days: [{ day: "2026-10-10", counts: COUNTS }],
  hiddenDays: 2,
};

describe("запрос воронки кабинета", () => {
  it("свой кабинет — период в запросе без partnerId; глазами партнёра — с ним; ответ разбирается схемой", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: FUNNEL }), json(200, { data: FUNNEL }));
    const api = new AdminApi(fetch);
    const period = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" };

    const own = await fetchCabinetFunnel(api, null, period);
    const watched = await fetchCabinetFunnel(api, "p-1", period);

    expect(calls.map((call) => call.url)).toEqual([
      "/api/v1/admin/cabinet/funnel?from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-31T00%3A00%3A00.000Z",
      "/api/v1/admin/cabinet/funnel?partnerId=p-1&from=2026-10-01T00%3A00%3A00.000Z&to=2026-10-31T00%3A00%3A00.000Z",
    ]);
    expect(own.ok && own.data.sources[1]?.counts).toBeNull();
    expect(watched.ok && watched.data.hiddenDays).toBe(2);
  });

  it("ответ с незнакомым видом источника — ошибка разбора, а не молча пустая таблица", async () => {
    const broken = { ...FUNNEL, sources: [{ via: "network", ref: null, name: null, source: null, note: null, counts: COUNTS }] };
    const { fetch } = fakeFetch(json(200, { data: broken }));

    const result = await fetchCabinetFunnel(new AdminApi(fetch), null, { from: FUNNEL.from, to: FUNNEL.to });

    expect(result.ok).toBe(false);
  });
});

describe("подписи воронки кабинета", () => {
  it("переходы: число с пробелами и период словами", () => {
    // Разделитель тысяч у Intl — неразрывный пробел: сравниваем без различия пробелов.
    const plain = (text: string) => text.replace(/\s/g, " ");
    expect(plain(clicksLine(1240, 30))).toBe("Переходов за 30 дней: 1 240");
    expect(clicksLine(0, 7)).toBe("Переходов за 7 дней: 0");
    expect(clicksLine(5, null)).toBe("Переходов за выбранный период: 5");
  });

  it("строка о пороге и о малом итоге называет число из настроек, а не зашитое", () => {
    expect(hiddenRowText(10)).toBe("меньше 10 игроков — не показываем");
    expect(hiddenRowText(25)).toBe("меньше 25 игроков — не показываем");
    expect(tooFewText(10)).toBe("Пока меньше 10 игроков: воронка появится, когда их станет больше");
  });

  it("источник: ссылка — вид и заметка, а без заметки — название; код — слово; без названия — честно", () => {
    expect(funnelSourceTitle(FUNNEL.sources[0]!)).toBe("канал · Игровой угол");
    expect(funnelSourceTitle(FUNNEL.sources[1]!)).toBe("пост · post-5");
    expect(funnelSourceTitle(FUNNEL.sources[2]!)).toBe("код · KANAL 2026");
    expect(funnelSourceTitle({ via: "link", ref: "zzz", name: null, source: null, note: null })).toBe("ссылка · zzz");
    expect(funnelSourceTitle({ via: "code", ref: null, name: null, source: null, note: null })).toBe("код (его больше нет)");
  });

  it("состояния: пустое — словами партнёра, скрытые дни — числом", () => {
    expect(CABINET_FUNNEL_TEXTS.empty).toBe("Пока никто не пришёл по вашим ссылкам");
    expect(CABINET_FUNNEL_TEXTS.daysHidden(2)).toBe("Скрыто дней, где игроков меньше порога: 2");
  });
});

// Компонентов тест не рисует — держит решения: вкладка в кабинете есть, а срез без чисел не рисует вех.
describe("вкладка «Воронка»", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("подключена к кабинету и берёт тот же partnerId, что остальные вкладки", () => {
    const screen = source("../src/screens/cabinet/CabinetScreen.tsx");
    expect(screen).toContain('{ id: "funnel", title: "Воронка" }');
    expect(screen).toContain("<FunnelTab partnerId={partnerId} />");
  });

  it("срез без чисел — строка о пороге из ответа сервера, вех в нём нет", () => {
    const tab = source("../src/screens/cabinet/FunnelTab.tsx");
    expect(tab).toContain("hiddenRowText(minGroup)");
    expect(tab).toContain("slice.row === null ? null");
    expect(tab).toContain("tooFewText(funnel.minGroup)");
  });
});
