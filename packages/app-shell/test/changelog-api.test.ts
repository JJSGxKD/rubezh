import { beforeEach, describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { useBadges } from "../src/state/badges";
import { createChangelogApi, entriesByKind, markChangelogSeen, type ChangelogPage } from "../src/state/changelog-api";

// Клиент журнала обновлений (docs/35-stage4-plan.md WP31): страницы — по
// курсору-версии, ответ разбирается схемой, открытый журнал отмечается до
// самой поздней публикации из ответа, и знак меню берётся из ответа сервера.

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

function server(calls: Call[], answers: Record<string, unknown>): ApiRequest {
  return async <T,>(path: string, schema: object, init: { method: "GET" | "POST" | "DELETE"; body?: unknown }): Promise<ApiResult<T>> => {
    calls.push({ path, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    const key = Object.keys(answers).find((prefix) => path.startsWith(prefix));
    if (key === undefined) return { ok: false, failure: "unavailable" };
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answers[key] });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const PAGE: ChangelogPage = {
  versions: [
    {
      version: "0.6.0",
      publishedAt: "2026-09-30T10:00:00.000Z",
      fresh: true,
      entries: [
        { id: "a", kind: "fixed", text: "Исправили звук" },
        { id: "b", kind: "added", text: "Журнал обновлений" },
        { id: "c", kind: "teleport", text: "Вид из будущего" },
        { id: "d", kind: "added", text: "Колесо" },
      ],
    },
  ],
  nextCursor: "0.6.0",
  latestAt: "2026-09-30T10:00:00.000Z",
};

describe("клиент журнала обновлений", () => {
  beforeEach(() => {
    useBadges.setState({ changelog: 3 });
  });

  it("первая страница без курсора, следующая — с версией в адресе", async () => {
    const calls: Call[] = [];
    const api = createChangelogApi(server(calls, { "/api/v1/changelog": PAGE }));
    const first = await api.page(null);
    expect(first.ok && first.data.versions[0]?.version).toBe("0.6.0");
    await api.page("0.6.0");
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/changelog", "/api/v1/changelog?cursor=0.6.0"]);
  });

  it("открыл журнал — отметка до самой поздней публикации из ответа, знак — из ответа сервера", async () => {
    const calls: Call[] = [];
    await markChangelogSeen(PAGE, createChangelogApi(server(calls, { "/api/v1/changelog/seen": { badge: 1 } })));
    expect(calls).toEqual([{ path: "/api/v1/changelog/seen", method: "POST", body: { upTo: "2026-09-30T10:00:00.000Z" } }]);
    expect(useBadges.getState().changelog).toBe(1);
  });

  it("пустой журнал отмечать нечего; сбой сети знак не трогает", async () => {
    const calls: Call[] = [];
    await markChangelogSeen({ ...PAGE, versions: [], latestAt: null }, createChangelogApi(server(calls, {})));
    expect(calls).toEqual([]);
    await markChangelogSeen(PAGE, createChangelogApi(server(calls, {})));
    expect(useBadges.getState().changelog).toBe(3);
  });

  it("строки версии — новое, изменено, исправлено; незнакомый вид сервера — в конце, а не выброшен", () => {
    const version = PAGE.versions[0];
    if (version === undefined) throw new Error("нет версии");
    expect(entriesByKind(version).map((group) => [group.kind, group.texts.map((entry) => entry.id)])).toEqual([
      ["added", ["b", "d"]],
      ["fixed", ["a"]],
      ["teleport", ["c"]],
    ]);
  });
});
