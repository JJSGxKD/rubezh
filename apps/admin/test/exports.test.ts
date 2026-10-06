import { describe, expect, it } from "vitest";
import { AdminApi, CSRF_HEADER, CSRF_VALUE, fileNameOf } from "../src/api/client";
import { buildExport, EXPORT_TIMEOUT_MS, fetchExports } from "../src/api/exports";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const AT = "2026-09-25T10:00:00.000Z";

describe("выгрузки", () => {
  it("архив приходит файлом: заголовок панели, долгий таймаут, имя из ответа", async () => {
    const zip = new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="rubezh-export-2026-09-25.zip"' } });
    const { fetch, calls } = fakeFetch(zip);
    const result = await buildExport(new AdminApi(fetch), { from: AT });

    expect(result.ok && result.data.fileName).toBe("rubezh-export-2026-09-25.zip");
    expect(result.ok && result.data.blob.size).toBe(4);
    expect(calls[0]?.init.headers).toMatchObject({ [CSRF_HEADER]: CSRF_VALUE });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ from: AT });
    expect(EXPORT_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("отказ сборки — тем же конвертом ошибки, что у JSON-запросов", async () => {
    const { fetch } = fakeFetch(json(429, { error: { code: "rate_limited", message: "Выгрузка уже собирается — подождите" } }), json(404, { error: { code: "endpoint_disabled", message: "Выгрузки выключены" } }));
    const api = new AdminApi(fetch);
    const busy = await buildExport(api, {});
    const off = await buildExport(api, {});
    expect(busy.ok || busy.error).toMatchObject({ kind: "rate_limited", message: "Выгрузка уже собирается — подождите" });
    expect(off.ok || off.error.kind).toBe("disabled");
  });

  it("журнал разбирается, имя файла без заголовка — общее", async () => {
    const row = { exportId: "x1", source: "panel", requestedBy: "555", period: { from: null, to: AT }, status: "sent", events: 10, reports: 2, sizeBytes: 4096, parts: 1, error: null, createdAt: AT, finishedAt: AT };
    const result = await fetchExports(new AdminApi(fakeFetch(json(200, { data: { exports: [row] } })).fetch));
    expect(result.ok && result.data.exports[0]?.period.from).toBeNull();
    expect(fileNameOf(null)).toBe("rubezh-export.zip");
  });
});

describe("меню", () => {
  it("раздел — за правом его маршрутов на сервере", () => {
    expect(SECTIONS.find((section) => section.id === "exports")?.permission).toBe("data.export");
  });
});
