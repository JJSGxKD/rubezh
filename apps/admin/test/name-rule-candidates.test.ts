import { describe, expect, it } from "vitest";
import { AdminApi, CSRF_HEADER, CSRF_VALUE } from "../src/api/client";
import {
  acceptCandidate,
  candidatesNote,
  candidatesViewSchema,
  defaultKind,
  dismissCandidate,
  fetchCandidates,
  firstSeenText,
  kindTitle,
  type CandidatesView,
} from "../src/api/name-rule-candidates";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Кандидаты в правила фильтра имён в панели (tasks/T-0341, Р168): слой API с Zod
// на границе и чистые функции вкладки «Кандидаты». Слова нейтральные.

const ID = "00000000-0000-4000-8000-000000000001";

function view(patch: Partial<CandidatesView> = {}): CandidatesView {
  return {
    computedAt: "2026-10-30T03:15:00.000Z",
    minPlayers: 20,
    windowDays: 30,
    items: [
      { candidateId: ID, token: "пример", kind: "word", players: 31, firstSeenAt: "2026-10-12T03:15:00.000Z" },
      { candidateId: "00000000-0000-4000-8000-000000000002", token: "пример бренд", kind: "pair", players: 22, firstSeenAt: "2026-10-29T03:15:00.000Z" },
    ],
    ...patch,
  };
}

describe("слой API кандидатов", () => {
  it("fetchCandidates: адрес и разбор схемой; ответ без числа игроков — ошибка, а не пустая таблица", async () => {
    const body = view();
    const { fetch, calls } = fakeFetch(json(200, { data: body }), json(200, { data: { ...body, items: [{ candidateId: ID, token: "пример", kind: "word" }] } }));
    const api = new AdminApi(fetch);

    const answer = await fetchCandidates(api);
    expect(calls[0]?.url).toBe("/api/v1/admin/name-rules/candidates");
    expect(answer.ok && answer.data.items).toHaveLength(2);
    expect(candidatesViewSchema.safeParse(body).success).toBe(true);
    expect((await fetchCandidates(api)).ok).toBe(false);
  });

  it("вид кандидата, которого панель не знает, — ошибка разбора", () => {
    const body = view();
    expect(candidatesViewSchema.safeParse({ ...body, items: [{ ...body.items[0], kind: "phrase" }] }).success).toBe(false);
  });

  it("acceptCandidate: POST с категорией и видом, заголовок CSRF, id в пути; 409 приходит текстом сервера", async () => {
    const rule = { ruleId: ID, category: "brand", kind: "word", pattern: "пример", active: true, note: null, updatedAt: "2026-10-30T04:00:00.000Z", updatedBy: null };
    const { fetch, calls } = fakeFetch(json(201, { data: rule }), json(409, { error: { code: "name_rule_conflict", message: "Такое правило уже есть" } }));
    const api = new AdminApi(fetch);

    const added = await acceptCandidate(api, ID, { category: "brand", kind: "word" });
    expect(added.ok).toBe(true);
    expect(calls[0]?.url).toBe(`/api/v1/admin/name-rules/candidates/${ID}/accept`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ category: "brand", kind: "word" });
    expect((calls[0]?.init.headers as Record<string, string>)[CSRF_HEADER]).toBe(CSRF_VALUE);

    const duplicate = await acceptCandidate(api, ID, { category: "brand", kind: "word" });
    expect(!duplicate.ok && duplicate.error).toMatchObject({ kind: "rejected", status: 409, message: "Такое правило уже есть" });
  });

  it("dismissCandidate: POST без тела на свой адрес", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { dismissed: true } }));
    const answer = await dismissCandidate(new AdminApi(fetch), ID);
    expect(answer.ok).toBe(true);
    expect(calls[0]?.url).toBe(`/api/v1/admin/name-rules/candidates/${ID}/dismiss`);
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)[CSRF_HEADER]).toBe(CSRF_VALUE);
  });
});

describe("чистые функции вкладки", () => {
  it("defaultKind: слово — «слово целиком», пара — «точная фраза»", () => {
    const [word, pair] = view().items;
    expect(word && defaultKind(word)).toBe("word");
    expect(pair && defaultKind(pair)).toBe("exact");
  });

  it("kindTitle: «Слово» и «Пара слов»", () => {
    expect(kindTitle("word")).toBe("Слово");
    expect(kindTitle("pair")).toBe("Пара слов");
  });

  it("candidatesNote: нет расчёта, пусто, есть", () => {
    expect(candidatesNote(view({ computedAt: null, items: [] }))).toBe("Расчёт ещё не запускался — он идёт каждую ночь в 03:15 UTC");
    expect(candidatesNote(view({ items: [] }))).toBe("Пока ни одно слово не набрало 20 игроков");
    expect(candidatesNote(view({ items: [], minPlayers: 25 }))).toBe("Пока ни одно слово не набрало 25 игроков");
    const note = candidatesNote(view());
    expect(note).toContain("у 20 и более разных игроков за 30 суток");
    expect(note).toContain("Ники и аккаунты не сохраняются");
    expect(note).toContain("Посчитано:");
  });

  it("firstSeenText: день и месяц по UTC, без времени", () => {
    expect(firstSeenText("2026-10-12T23:59:00.000Z")).toMatch(/^12\s?окт/u);
  });

  it("список разделов не менялся: «Фильтр имён» — один раздел с правом names.edit", () => {
    expect(SECTIONS.filter((section) => section.id === "names")).toHaveLength(1);
    expect(SECTIONS.find((section) => section.id === "names")?.permission).toBe("names.edit");
  });
});
