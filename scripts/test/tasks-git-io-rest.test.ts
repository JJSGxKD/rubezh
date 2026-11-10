import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита на чистом JS, типов у неё нет
import { prFromRest, repoSlugFromUrl } from "../tasks/git-io.mjs";

// Облачная сессия Claude Code закрывает GraphQL GitHub, и `gh pr list` в ней
// не отвечает: доска и `pnpm task resume` читают открытые PR через REST.

describe("адрес репозитория для REST", () => {
  it("разбирает адреса GitHub по https и ssh", () => {
    expect(repoSlugFromUrl("https://github.com/JJSGxKD/rubezh.git")).toBe("JJSGxKD/rubezh");
    expect(repoSlugFromUrl("https://github.com/JJSGxKD/rubezh")).toBe("JJSGxKD/rubezh");
    expect(repoSlugFromUrl("git@github.com:JJSGxKD/rubezh.git")).toBe("JJSGxKD/rubezh");
  });

  it("разбирает адрес прокси облачной сессии", () => {
    expect(repoSlugFromUrl("http://local_proxy@127.0.0.1:41437/git/JJSGxKD/rubezh")).toBe("JJSGxKD/rubezh");
  });

  it("на пустом и битом адресе — null", () => {
    expect(repoSlugFromUrl("")).toBeNull();
    expect(repoSlugFromUrl("rubezh")).toBeNull();
  });
});

describe("PR из ответа REST", () => {
  it("приводит запись к форме gh pr list", () => {
    const pr = prFromRest({
      number: 686,
      head: { ref: "task/T-0127" },
      draft: true,
      labels: [{ id: 1, name: "доработка", color: "fff" }, { name: "release: minor" }],
      body: "Задача: tasks/T-0127",
      created_at: "2026-11-07T14:31:00Z",
    });
    expect(pr).toEqual({
      number: 686,
      headRefName: "task/T-0127",
      isDraft: true,
      labels: [{ name: "доработка" }, { name: "release: minor" }],
      body: "Задача: tasks/T-0127",
      createdAt: "2026-11-07T14:31:00Z",
    });
  });

  it("пустое описание и отсутствие меток не ломают разбор", () => {
    expect(prFromRest({ number: 1, head: { ref: "fix/x" }, draft: false, labels: null, body: null })).toEqual({
      number: 1,
      headRefName: "fix/x",
      isDraft: false,
      labels: [],
      body: "",
      createdAt: null,
    });
  });

  it("запись без номера или ветки отбрасывается", () => {
    expect(prFromRest({ head: { ref: "task/T-1" } })).toBeNull();
    expect(prFromRest({ number: 3, head: {} })).toBeNull();
    expect(prFromRest(null)).toBeNull();
  });
});
