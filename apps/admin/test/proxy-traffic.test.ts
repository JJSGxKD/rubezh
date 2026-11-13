import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchProxyTraffic, TRAFFIC_PERIODS, type TrafficReport } from "../src/api/proxy-traffic";
import { bytesText, keepUnits, periodLabel, subscriptionTotals, trafficRows, windowLabel } from "../src/screens/proxies/traffic-view";
import { TrafficPanel } from "../src/screens/proxies/TrafficPanel";
import { HELP } from "../src/ui/help";
import { fakeFetch, json } from "./helpers";

// Трафик через узлы Xray в панели (docs/35-stage4-plan.md Р192, tasks/T-0386):
// байты читаются словами, узлы всех подписок — одной таблицей по «всего» по
// убыванию, ушедший из подписки узел помечен, окно подписано по времени смотрящего.

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;
/** Дробные гигабайты — целыми байтами, как их присылает сервер. */
const gb = (value: number): number => Math.round(value * GB);

const report = (patch: Partial<TrafficReport> = {}): TrafficReport => ({
  period: "day",
  from: "2026-11-06T15:00:00.000Z",
  to: "2026-11-07T15:00:00.000Z",
  lastCollectedAt: "2026-11-07T14:24:00.000Z",
  subscriptions: [
    {
      key: "main",
      name: "Основная",
      upBytes: gb(1.2),
      downBytes: gb(15.3),
      nodes: [
        { nodeKey: "aaaaaaaaaaaaaaaa", name: "Берлин", inSubscription: true, upBytes: gb(1), downBytes: gb(10) },
        { nodeKey: "bbbbbbbbbbbbbbbb", name: "Ушедший", inSubscription: false, upBytes: gb(0.2), downBytes: gb(5.3) },
      ],
    },
    {
      key: "b2b2b2b2b2b2",
      name: "Резервная",
      upBytes: 3 * MB,
      downBytes: 60 * MB,
      nodes: [{ nodeKey: "aaaaaaaaaaaaaaaa", name: "Берлин", inSubscription: true, upBytes: 3 * MB, downBytes: 60 * MB }],
    },
  ],
  ...patch,
});

describe("байты словами", () => {
  it("меньше килобайта — целые байты; дальше КБ, МБ, ГБ, ТБ с одним знаком после запятой", () => {
    expect(bytesText(0)).toBe("0 Б");
    expect(bytesText(512)).toBe("512 Б");
    expect(bytesText(1023)).toBe("1023 Б");
    expect(bytesText(1024)).toBe("1,0 КБ");
    expect(bytesText(1.5 * KB)).toBe("1,5 КБ");
    expect(bytesText(5 * MB)).toBe("5,0 МБ");
    expect(bytesText(1.5 * GB)).toBe("1,5 ГБ");
    expect(bytesText(2 * TB)).toBe("2,0 ТБ");
  });

  it("округление не выдаёт «1024,0 КБ»: на границе единица переходит в следующую", () => {
    expect(bytesText(MB - 1)).toBe("1,0 МБ");
    expect(bytesText(GB - 1)).toBe("1,0 ГБ");
    expect(bytesText(1023.95 * KB)).toBe("1,0 МБ");
  });

  it("ТБ — последняя единица: большие числа остаются в терабайтах", () => {
    expect(bytesText(3 * 1024 * TB)).toContain("ТБ");
  });

  it("мусор не показывается числом: отрицательное и не число — «0 Б»", () => {
    expect(bytesText(-5)).toBe("0 Б");
    expect(bytesText(Number.NaN)).toBe("0 Б");
  });
});

describe("строки таблицы узлов", () => {
  it("узлы всех подписок одной таблицей, по «всего» по убыванию", () => {
    const rows = trafficRows(report());
    expect(rows.map((row) => [row.subscriptionName, row.name])).toEqual([
      ["Основная", "Берлин"],
      ["Основная", "Ушедший (нет в подписке)"],
      ["Резервная", "Берлин"],
    ]);
    expect(rows.map((row) => row.totalBytes)).toEqual([11 * GB, gb(0.2) + gb(5.3), 63 * MB]);
  });

  it("узел, которого нет в подписке, подписан «(нет в подписке)»; остальные — без пометки", () => {
    const rows = trafficRows(report());
    expect(rows[1]?.name).toBe("Ушедший (нет в подписке)");
    expect(rows[1]?.gone).toBe(true);
    expect(rows[0]?.name).toBe("Берлин");
    expect(rows[0]?.gone).toBe(false);
  });

  it("текст ячеек: отдано, получено и всего — словами", () => {
    const [first] = trafficRows(report());
    expect(first).toMatchObject({ upText: "1,0 ГБ", downText: "10,0 ГБ", totalText: "11,0 ГБ" });
  });

  it("одинаковое «всего» — по названию узла, затем по подписке: порядок не прыгает между обновлениями", () => {
    const tied = report({
      subscriptions: [
        { key: "x", name: "Б", upBytes: 2, downBytes: 0, nodes: [{ nodeKey: "1111111111111111", name: "Я", inSubscription: true, upBytes: 2, downBytes: 0 }] },
        { key: "y", name: "А", upBytes: 2, downBytes: 0, nodes: [{ nodeKey: "2222222222222222", name: "Я", inSubscription: true, upBytes: 2, downBytes: 0 }] },
        { key: "z", name: "В", upBytes: 2, downBytes: 0, nodes: [{ nodeKey: "3333333333333333", name: "А", inSubscription: true, upBytes: 2, downBytes: 0 }] },
      ],
    });
    expect(trafficRows(tied).map((row) => [row.name, row.subscriptionName])).toEqual([
      ["А", "В"],
      ["Я", "А"],
      ["Я", "Б"],
    ]);
  });

  it("трафика не было — строк нет", () => {
    expect(trafficRows(report({ subscriptions: [{ key: "main", name: "Основная", upBytes: 0, downBytes: 0, nodes: [] }] }))).toEqual([]);
    expect(trafficRows(report({ subscriptions: [] }))).toEqual([]);
  });
});

describe("итоги по подпискам", () => {
  it("строка на подписку: отдано, получено, всего; подписки как пришли с сервера", () => {
    expect(subscriptionTotals(report())).toEqual([
      { key: "main", name: "Основная", text: "Основная: отдано 1,2 ГБ · получено 15,3 ГБ · всего 16,5 ГБ" },
      { key: "b2b2b2b2b2b2", name: "Резервная", text: "Резервная: отдано 3,0 МБ · получено 60,0 МБ · всего 63,0 МБ" },
    ]);
  });

  it("подписка без трафика остаётся в итогах с нулями", () => {
    const empty = report({ subscriptions: [{ key: "main", name: "Основная", upBytes: 0, downBytes: 0, nodes: [] }] });
    expect(subscriptionTotals(empty)[0]?.text).toBe("Основная: отдано 0 Б · получено 0 Б · всего 0 Б");
  });
});

describe("единицы в строке итогов", () => {
  it("пробел перед единицей неразрывный, остальной текст прежний", () => {
    const shown = keepUnits("Запасная: отдано 2,0 ТБ · получено 1,2 МБ · всего 512 Б");
    expect(shown).toBe("Запасная: отдано 2,0\u00a0ТБ · получено 1,2\u00a0МБ · всего 512\u00a0Б");
    expect(shown.replaceAll("\u00a0", " ")).toBe("Запасная: отдано 2,0 ТБ · получено 1,2 МБ · всего 512 Б");
  });

  it("название подписки с цифрой и буквой не трогается", () => {
    expect(keepUnits("Резерв 2 Берлин: отдано 0 Б")).toBe("Резерв 2 Берлин: отдано 0\u00a0Б");
  });
});

describe("подпись окна и переключатель", () => {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const local = (iso: string): string => {
    const date = new Date(iso);
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  it("окно подписано по времени смотрящего: «с 06.11 14:00 до 07.11 14:00»", () => {
    const text = windowLabel(report());
    expect(text).toBe(`с ${local("2026-11-06T15:00:00.000Z")} до ${local("2026-11-07T15:00:00.000Z")}`);
    expect(text).toMatch(/^с \d{2}\.\d{2} \d{2}:\d{2} до \d{2}\.\d{2} \d{2}:\d{2}$/);
  });

  it("мусор в границах — пустая подпись, а не «Invalid Date»", () => {
    expect(windowLabel(report({ from: "не дата" }))).toBe("");
  });

  it("периоды — сутки, 7 дней, 30 дней; по умолчанию сутки", () => {
    expect(TRAFFIC_PERIODS).toEqual(["day", "week", "month"]);
    expect(periodLabel("day")).toBe("Сутки");
    expect(periodLabel("week")).toBe("7 дней");
    expect(periodLabel("month")).toBe("30 дней");
  });
});

describe("запрос к серверу", () => {
  it("GET /proxy-traffic с периодом; ответ разобран", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: report({ period: "week" }) }));
    const result = await fetchProxyTraffic(new AdminApi(fetch), "week");

    expect(calls[0]?.url).toBe("/api/v1/admin/proxy-traffic?period=week");
    expect(calls[0]?.init.method).toBe("GET");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.subscriptions[0]?.nodes[1]?.inSubscription).toBe(false);
  });

  it("lastCollectedAt: null — допустимый ответ", async () => {
    const { fetch } = fakeFetch(json(200, { data: report({ lastCollectedAt: null }) }));
    const result = await fetchProxyTraffic(new AdminApi(fetch), "day");
    expect(result.ok && result.data.lastCollectedAt).toBeNull();
  });

  it("ответ не по схеме — честная ошибка: нет подписок, период не из списка, байты строкой", async () => {
    const broken = [{ ...report(), subscriptions: undefined }, { ...report(), period: "year" }, report({ subscriptions: [{ key: "m", name: "М", upBytes: "много" as unknown as number, downBytes: 0, nodes: [] }] })];
    for (const data of broken) {
      const { fetch } = fakeFetch(json(200, { data }));
      expect((await fetchProxyTraffic(new AdminApi(fetch), "day")).ok, JSON.stringify(data).slice(0, 40)).toBe(false);
    }
  });

  it("403 — ошибка forbidden, а не пустой отчёт", async () => {
    const { fetch } = fakeFetch(json(403, { error: { code: "forbidden", message: "Нет права" } }));
    const result = await fetchProxyTraffic(new AdminApi(fetch), "day");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("forbidden");
  });
});

describe("блок на странице", () => {
  it("подсказка есть, текст из спецификации", () => {
    expect(HELP.proxies.traffic).toBe(
      "Считает ядро Xray: сколько байт ушло к узлу и пришло от него. Окна скользящие — последние 24 часа, 7 и 30 суток. История хранится 35 суток. При перезапуске Xray (смена конфига, сбой) теряются секунды учёта",
    );
  });

  it("блок рисуется без обращения к серверу: заголовок и пояснение под ним", () => {
    const html = renderToStaticMarkup(createElement(TrafficPanel));
    expect(html).toContain("Трафик через узлы Xray");
  });
});
