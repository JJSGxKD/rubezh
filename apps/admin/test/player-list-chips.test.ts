import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, type PlayerListFilters } from "../src/api/player-list";
import { FILTER_LABELS, clearAllFilters, filterChips } from "../src/screens/players/list-filters";

// Фильтры списка игроков чипами (tasks/T-0354): активные видны, каждый снимается.

const KINDS: Record<string, string> = { chat: "Чат закрыт" };
const kindTitle = (kind: string): string => KINDS[kind] ?? kind;
const chips = (patch: Partial<PlayerListFilters>) => filterChips({ ...EMPTY_FILTERS, ...patch }, kindTitle);

describe("чипы активных фильтров", () => {
  it("пустые фильтры — чипов нет", () => {
    expect(chips({})).toEqual([]);
  });

  it("платящий: один чип, крестик очищает поле", () => {
    const [chip, ...rest] = chips({ payer: "yes" });
    expect(rest).toEqual([]);
    expect(chip?.label).toBe("Платящий: да");
    expect(chip?.clear({ ...EMPTY_FILTERS, payer: "yes" }).payer).toBe("");
  });

  it("уровень от–до — один чип; крестик очищает оба поля", () => {
    const filters = { ...EMPTY_FILTERS, levelMin: "3", levelMax: "10" };
    const found = filterChips(filters, kindTitle);
    expect(found.map((chip) => chip.label)).toEqual(["Уровень: 3–10"]);
    expect(found[0]?.clear(filters)).toMatchObject({ levelMin: "", levelMax: "" });
  });

  it("задана одна граница — «от» или «до»", () => {
    expect(chips({ levelMin: "3" }).map((chip) => chip.label)).toEqual(["Уровень: от 3"]);
    expect(chips({ levelMax: "10" }).map((chip) => chip.label)).toEqual(["Уровень: до 10"]);
  });

  it("даты — день.месяц; одна граница — «с» или «по»", () => {
    expect(chips({ registeredTo: "2026-10-15" }).map((chip) => chip.label)).toEqual(["Регистрация: по 15.10"]);
    expect(chips({ registeredFrom: "2026-10-01", registeredTo: "2026-10-15" }).map((chip) => chip.label)).toEqual(["Регистрация: 01.10–15.10"]);
    expect(chips({ seenFrom: "2026-10-01" }).map((chip) => chip.label)).toEqual(["Заходил: с 01.10"]);
  });

  it("ограничения: вид — из справочника, «any» — есть, «none» — нет", () => {
    expect(chips({ restricted: "chat" }).map((chip) => chip.label)).toEqual(["Ограничения: Чат закрыт"]);
    expect(chips({ restricted: "any" }).map((chip) => chip.label)).toEqual(["Ограничения: есть"]);
    expect(chips({ restricted: "none" }).map((chip) => chip.label)).toEqual(["Ограничения: нет"]);
  });

  it("порядок и направление чипами не показываются", () => {
    expect(chips({ sort: "level", order: "asc" })).toEqual([]);
  });

  it("площадка, источник и кампания — свои чипы; крестик трогает только своё поле", () => {
    const filters = { ...EMPTY_FILTERS, platform: "vk" as const, source: "tagged" as const, campaign: "spring", sort: "seen" as const };
    const found = filterChips(filters, kindTitle);
    expect(found.map((chip) => chip.label)).toEqual(["Площадка: vk", "Откуда пришёл: ссылка с метками", "Кампания: spring"]);
    expect(found[2]?.clear(filters)).toEqual({ ...filters, campaign: "" });
  });

  it("«сбросить все» снимает фильтры и оставляет порядок", () => {
    const filters = { ...EMPTY_FILTERS, payer: "yes" as const, banned: "no" as const, sort: "level" as const, order: "asc" as const };
    expect(clearAllFilters(filters)).toEqual({ ...EMPTY_FILTERS, sort: "level", order: "asc" });
  });

  it("подписи чипов — из той же таблицы, что подписи полей формы", () => {
    const all: PlayerListFilters = {
      ...EMPTY_FILTERS,
      platform: "vk",
      levelMin: "1",
      registeredFrom: "2026-10-01",
      seenFrom: "2026-10-01",
      source: "organic",
      campaign: "a",
      payer: "yes",
      banned: "yes",
      restricted: "any",
      canMessage: "yes",
    };
    const prefixes = filterChips(all, kindTitle).map((chip) => chip.label.split(":")[0]);
    expect(prefixes).toEqual([
      FILTER_LABELS.platform,
      FILTER_LABELS.level,
      FILTER_LABELS.registered,
      FILTER_LABELS.seen,
      FILTER_LABELS.source,
      FILTER_LABELS.campaign,
      FILTER_LABELS.payer,
      FILTER_LABELS.banned,
      FILTER_LABELS.restricted,
      FILTER_LABELS.canMessage,
    ]);
  });
});
