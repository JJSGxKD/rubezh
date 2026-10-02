import { describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { GH_RETRY_DELAYS_MS, transientGhReason, withGhRetry } from "../release/git.mjs";

// Чтения GitHub в скриптах выпуска (docs/09-ci-cd.md §8.1): вычисление версии
// спрашивает GitHub о каждом коммите после стабильного тега, и один 504 из
// сотен не должен ронять выпуск. Отказ по сути повтором не лечится.

/** Ошибка как у `execFileSync`: текст команды в сообщении, ответ gh — в stderr. */
function ghFailure(stderr: string): Error {
  return Object.assign(new Error(`Command failed: gh api repos/{owner}/{repo}/commits/abc/pulls\n${stderr}`), { stderr });
}

const GATEWAY = "gh: We couldn't respond to your request in time. Sorry about that. (HTTP 504)";

describe("временный сбой GitHub", () => {
  it("5xx, 429 и обрыв — временные; 404, 403 и не ошибка — нет", () => {
    expect(transientGhReason(ghFailure(GATEWAY))).toBe(GATEWAY);
    expect(transientGhReason(ghFailure("gh: API rate limit exceeded (HTTP 429)"))).not.toBeNull();
    expect(transientGhReason(ghFailure("Post \"https://api.github.com/graphql\": read: connection reset by peer"))).not.toBeNull();
    expect(transientGhReason(new Error("dial tcp: i/o timeout"))).not.toBeNull();
    expect(transientGhReason(ghFailure("gh: Not Found (HTTP 404)"))).toBeNull();
    expect(transientGhReason(ghFailure("gh: Resource not accessible by integration (HTTP 403)"))).toBeNull();
    expect(transientGhReason("HTTP 504")).toBeNull();
  });

  it("повторяет чтение с паузами и отдаёт ответ, когда GitHub ожил", () => {
    const sleeps: number[] = [];
    const logs: string[] = [];
    let calls = 0;
    const result = withGhRetry(
      () => {
        calls += 1;
        if (calls < 3) throw ghFailure(GATEWAY);
        return "[]";
      },
      { sleep: (ms: number) => sleeps.push(ms), log: (line: string) => logs.push(line) },
    );
    expect(result).toBe("[]");
    expect(sleeps).toEqual(GH_RETRY_DELAYS_MS.slice(0, 2));
    expect(logs[0]).toContain("HTTP 504");
    expect(logs[0]).toContain("повтор 1 из 4");
  });

  it("отказ по сути — сразу, без пауз; временный сбой дольше всех пауз — ошибка", () => {
    const sleeps: number[] = [];
    const options = { sleep: (ms: number) => sleeps.push(ms), log: () => undefined };
    expect(() => withGhRetry(() => { throw ghFailure("gh: Not Found (HTTP 404)"); }, options)).toThrow("HTTP 404");
    expect(sleeps).toEqual([]);

    let calls = 0;
    expect(() =>
      withGhRetry(() => {
        calls += 1;
        throw ghFailure(GATEWAY);
      }, options),
    ).toThrow("HTTP 504");
    expect(calls).toBe(GH_RETRY_DELAYS_MS.length + 1);
    expect(sleeps).toEqual(GH_RETRY_DELAYS_MS);
  });
});
