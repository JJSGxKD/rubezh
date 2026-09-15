import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitFile, ZipWriter } from "../src/common/zip/zip-writer.js";
import { unzip } from "./helpers/unzip.js";

// Архив выгрузки (docs/28-diagnostics.md §6.1.3).

async function* lines(count: number, prefix: string): AsyncIterable<string> {
  for (let i = 0; i < count; i++) yield `${JSON.stringify({ i, prefix, text: "событие закрытого теста" })}\n`;
}

describe("ZIP выгрузки", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rubezh-zip-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("пишет несколько потоков в архив, который читается обратно байт в байт", async () => {
    const path = join(dir, "export.zip");
    const zip = new ZipWriter(path);
    await zip.addFile("manifest.json", (async function* () {
      yield JSON.stringify({ period: "сутки" });
    })());
    await zip.addFile("events.ndjson", lines(5000, "e"));
    await zip.addFile("пустой.csv", (async function* () {})());
    const size = await zip.finish();

    const archive = readFileSync(path);
    expect(archive.length).toBe(size);
    const files = unzip(archive);
    expect([...files.keys()]).toEqual(["manifest.json", "events.ndjson", "пустой.csv"]);
    expect(JSON.parse(files.get("manifest.json")!.toString())).toEqual({ period: "сутки" });
    const events = files.get("events.ndjson")!.toString().trim().split("\n");
    expect(events).toHaveLength(5000);
    expect(JSON.parse(events[4999]!)).toMatchObject({ i: 4999, prefix: "e" });
    expect(files.get("пустой.csv")!.length).toBe(0);
    // NDJSON жмётся в разы — поэтому частей на закрытом тесте обычно не будет.
    expect(size).toBeLessThan(files.get("events.ndjson")!.length / 5);
  });

  it("режет большой архив на части, из которых собирается исходный набор данных", async () => {
    const path = join(dir, "big.zip");
    const zip = new ZipWriter(path);
    // Случайные байты не сжимаются: архив гарантированно больше порога частей.
    await zip.addFile("noise.bin", (async function* () {
      for (let i = 0; i < 4; i++) yield randomBytes(64 * 1024);
    })());
    await zip.addFile("events.ndjson", lines(100, "x"));
    await zip.finish();

    const parts = await splitFile(path, 100 * 1024, join(dir, "parts"));
    expect(parts.length).toBe(3);
    expect(parts.map((part) => part.slice(-4))).toEqual([".001", ".002", ".003"]);
    const joined = Buffer.concat(parts.map((part) => readFileSync(part)));
    expect(joined.equals(readFileSync(path))).toBe(true);
    expect(unzip(joined).get("events.ndjson")!.toString().split("\n").filter(Boolean)).toHaveLength(100);
  });

  it("не режет архив, который помещается в один документ", async () => {
    const path = join(dir, "small.zip");
    const zip = new ZipWriter(path);
    await zip.addFile("a.txt", lines(10, "a"));
    await zip.finish();
    expect(await splitFile(path, 1024 * 1024, join(dir, "parts"))).toEqual([path]);
  });
});
