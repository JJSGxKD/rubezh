import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — утилита разработки на чистом JS, типов у неё нет и не нужно
import { EXIT, exitCodeOf, parseArgs, reportOf } from "../replay.mjs";
import { circling, recordHeadlessRun } from "../../packages/core-game/test/helpers/recorded-run";
import type { RunRecording } from "../../packages/core-game/src/run-api";

// `pnpm replay <reportId>` (docs/28-diagnostics.md §3.4): находит запись в
// выгрузке, повторяет забег и честно говорит кодом выхода, совпало ли.

const script = fileURLToPath(new URL("../replay.mjs", import.meta.url));
const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), "rubezh-replay-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Строка `diagnostic_reports.ndjson` в том виде, в каком её пишет выгрузка. */
function exportLine(recording: RunRecording): string {
  return JSON.stringify({
    report_id: recording.reportId,
    kind: "run",
    schema_version: recording.schema,
    app_version: "0.4.0",
    content_hash: recording.contentHash,
    install_id: "install",
    user: "u_0123456789abcdef0123456789abcdef",
    platform: "telegram",
    device: {},
    summary: {},
    payload: { recording, client: { screenMode: "fullscreen", insets: { top: 0, right: 0, bottom: 0, left: 0 }, clientErrors: 1, evictedReports: 0 } },
    size_bytes: 1,
    occurred_at: recording.startedAt,
    received_at: recording.startedAt,
  });
}

async function replay(reportId: string, from: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await run(process.execPath, [script, reportId, "--from", from], { timeout: 120_000 });
    return { code: 0, out: stdout };
  } catch (error: unknown) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, out: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("разбор аргументов и файла", () => {
  it("понимает reportId и --from в обоих написаниях, без них — ничего", () => {
    expect(parseArgs(["abc", "--from", "x.ndjson"])).toEqual({ reportId: "abc", from: "x.ndjson" });
    expect(parseArgs(["--", "abc", "--from=x.json"])).toEqual({ reportId: "abc", from: "x.json" });
    expect(parseArgs(["abc"])).toBeNull();
    expect(parseArgs(["--from", "x.ndjson"])).toBeNull();
  });

  it("достаёт запись из строки выгрузки, конверта и голой записи; стресс-тест — не запись", () => {
    const recording = { schema: "rubezh.run.v1", reportId: "r1" };
    expect(reportOf({ app_version: "0.4.0", payload: { recording, client: null } }, "r1")).toMatchObject({ recording, appVersion: "0.4.0" });
    expect(reportOf({ appVersion: "0.5.0", payload: { recording } }, "r1")?.appVersion).toBe("0.5.0");
    expect(reportOf(recording, "r1")?.recording).toBe(recording);
    expect(reportOf({ payload: { report: { schema: "rubezh.bench.v4" } } }, "r1")).toBeNull();
    expect(reportOf(recording, "другой")).toBeNull();
  });

  it("код выхода отличает дефект детерминизма от «повторить нельзя»", () => {
    expect(exitCodeOf("match")).toBe(EXIT.match);
    expect(exitCodeOf("mismatch")).toBe(EXIT.mismatch);
    expect(exitCodeOf("content_mismatch")).toBe(EXIT.cannot);
    expect(exitCodeOf("broken")).toBe(EXIT.cannot);
  });
});

describe("pnpm replay целиком", () => {
  const recording = recordHeadlessRun({ seed: 2026, maxTicks: 4_000, steer: circling(180) });

  it("находит запись среди чужих строк выгрузки и повторяет её", async () => {
    const other = { ...recording, reportId: "99999999-0000-4000-8000-000000000000" };
    const file = join(dir, "diagnostic_reports.ndjson");
    writeFileSync(file, `${exportLine(other)}\nбитая строка ${recording.reportId}\n${exportLine(recording)}\n`);

    const result = await replay(recording.reportId, file);
    expect(result.out).toContain("Повтор совпал");
    expect(result.out).toContain("ошибок клиента за забег: 1");
    expect(result.code).toBe(EXIT.match);
  }, 120_000);

  it("подменённый исход — код 1 и таблица расхождения", async () => {
    const file = join(dir, "tampered.json");
    writeFileSync(file, JSON.stringify({ ...recording, result: { ...recording.result, enemiesKilled: recording.result.enemiesKilled + 1 } }));

    const result = await replay(recording.reportId, file);
    expect(result.code).toBe(EXIT.mismatch);
    expect(result.out).toContain("РАЗОШЁЛСЯ");
    expect(result.out).toMatch(/≠ enemiesKilled/);
  }, 120_000);

  it("нет записи — код 2 и понятный текст", async () => {
    const file = join(dir, "diagnostic_reports.ndjson");
    const result = await replay("00000000-0000-4000-8000-00000000dead", file);
    expect(result.code).toBe(EXIT.cannot);
    expect(result.out).toContain("нет");
  }, 120_000);
});
