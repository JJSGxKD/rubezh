import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { IMAGE_MAX_BYTES, IMAGE_PROFILES, imageUrl, toBase64, uploadImage } from "../src/api/media";
import { CENTERED, QUALITY_STEPS, ZOOM_MAX, cropOf, encodeWithin, maxZoom, outputSide, panBy, sizeProblem, sourceProblem, zoomTo } from "../src/ui/image-crop";
import { fakeFetch, json } from "./helpers";

/**
 * Картинка из панели (docs/35-stage4-plan.md Р82, О42): квадрат кадра не
 * выходит за края исходника, приближение не делает его мельче нужного,
 * сжатие укладывается в 200 КБ или честно говорит, почему нет, а файл уходит
 * на сервер base64.
 */

const task = IMAGE_PROFILES.task;
const wide = { width: 1200, height: 600 };

describe("кадр картинки", () => {
  it("по умолчанию — квадрат во всю короткую сторону по центру", () => {
    expect(cropOf(wide, CENTERED, task.minSide)).toEqual({ x: 300, y: 0, side: 600 });
    expect(cropOf({ width: 400, height: 900 }, CENTERED, task.minSide)).toEqual({ x: 0, y: 250, side: 400 });
  });

  it("перетаскивание: картинка едет за мышью, квадрат — навстречу, и за край не выходит", () => {
    // кадр 288 точек показывает квадрат 600: точка кадра — 600/288 точки исходника
    const moved = panBy(wide, CENTERED, task.minSide, 144, 0, 288);
    expect(cropOf(wide, moved, task.minSide)).toEqual({ x: 0, y: 0, side: 600 });
    const far = panBy(wide, CENTERED, task.minSide, -10_000, -10_000, 288);
    expect(cropOf(wide, far, task.minSide)).toEqual({ x: 600, y: 0, side: 600 });
    expect(far.cx).toBeCloseTo(0.75);
  });

  it("приближение — вокруг центра и не мельче нужного: у края центр уступает", () => {
    const zoomed = zoomTo(wide, CENTERED, task.minSide, 2);
    expect(cropOf(wide, zoomed, task.minSide)).toEqual({ x: 450, y: 150, side: 300 });
    expect(maxZoom(wide, task.minSide)).toBe(ZOOM_MAX);
    expect(maxZoom({ width: 150, height: 150 }, task.minSide)).toBeCloseTo(150 / 96);
    expect(maxZoom({ width: 96, height: 300 }, task.minSide)).toBe(1);
    const tooClose = zoomTo({ width: 150, height: 150 }, CENTERED, task.minSide, 10);
    expect(cropOf({ width: 150, height: 150 }, tooClose, task.minSide).side).toBeCloseTo(96);

    // Приблизили, увели в левый верхний угол и отдалили: квадрат упёрся в край, центр сдвинулся.
    const corner = panBy(wide, zoomTo(wide, CENTERED, task.minSide, 3), task.minSide, 10_000, 10_000, 288);
    expect(cropOf(wide, corner, task.minSide)).toEqual({ x: 0, y: 0, side: 200 });
    const out = zoomTo(wide, corner, task.minSide, 1);
    expect(cropOf(wide, out, task.minSide)).toEqual({ x: 0, y: 0, side: 600 });
    expect([out.cx, out.cy]).toEqual([0.25, 0.5]);
  });

  it("сторона результата — профиль, а мелкий исходник не растягивается", () => {
    expect(outputSide({ x: 0, y: 0, side: 600 }, task.side)).toBe(256);
    expect(outputSide({ x: 0, y: 0, side: 150.4 }, task.side)).toBe(150);
  });
});

describe("исходник", () => {
  it("PNG, JPEG и WebP до 15 МБ; меньше 96 px по короткой стороне — объяснение", () => {
    expect(sourceProblem({ type: "image/png", size: 1_000 })).toBeNull();
    expect(sourceProblem({ type: "image/jpeg", size: 15 * 1024 * 1024 })).toBeNull();
    expect(sourceProblem({ type: "image/gif", size: 1_000 })).toBe("Нужна картинка PNG, JPEG или WebP");
    expect(sourceProblem({ type: "image/svg+xml", size: 1_000 })).toBe("Нужна картинка PNG, JPEG или WebP");
    expect(sourceProblem({ type: "image/png", size: 15 * 1024 * 1024 + 1 })).toBe("Файл больше 15 МБ — уменьшите его");
    expect(sizeProblem({ width: 96, height: 400 }, task.minSide)).toBeNull();
    expect(sizeProblem({ width: 80, height: 60 }, task.minSide)).toBe("Картинка 80×60 — меньше 96 px по короткой стороне, в игре она будет мыльной. Возьмите побольше");
  });
});

describe("сжатие в WebP", () => {
  const blob = (size: number, type = "image/webp") => new Blob([new Uint8Array(size)], { type });

  it("качество шагами вниз, пока не уложится; первое подходящее — сразу", async () => {
    const asked: number[] = [];
    const encoded = await encodeWithin(async (quality) => {
      asked.push(quality);
      return blob(quality > 0.7 ? IMAGE_MAX_BYTES + 1 : IMAGE_MAX_BYTES);
    }, IMAGE_MAX_BYTES);
    expect(encoded).toMatchObject({ ok: true, quality: 0.66 });
    expect(asked).toEqual([0.9, 0.82, 0.74, 0.66]);
  });

  it("браузер без WebP, отказ холста и неуместимая картинка — словами", async () => {
    expect(await encodeWithin(async () => blob(10, "image/png"), IMAGE_MAX_BYTES)).toEqual({ ok: false, problem: "Этот браузер не сохраняет WebP — откройте панель в Chrome, Edge или Firefox" });
    expect(await encodeWithin(async () => null, IMAGE_MAX_BYTES)).toEqual({ ok: false, problem: "Браузер не смог сжать картинку — попробуйте другой файл" });
    let calls = 0;
    const heavy = await encodeWithin(async () => {
      calls += 1;
      return blob(IMAGE_MAX_BYTES + 1);
    }, IMAGE_MAX_BYTES);
    expect(heavy).toEqual({ ok: false, problem: "Даже сильно сжатая картинка тяжелее 200 КБ — возьмите попроще" });
    expect(calls).toBe(QUALITY_STEPS.length);
  });
});

describe("загрузка", () => {
  it("файл уходит base64 с профилем и заголовком панели; ответ — id картинки, адрес показа — под путём панели", async () => {
    const bytes = new Uint8Array(70_000).map((_, index) => index % 251);
    const { fetch, calls } = fakeFetch(json(201, { data: { imageId: "f".repeat(64), width: 256, height: 256, sizeBytes: bytes.length } }));
    const result = await uploadImage(new AdminApi(fetch), "task", new Blob([bytes], { type: "image/webp" }));
    expect(result).toEqual({ ok: true, data: { imageId: "f".repeat(64), width: 256, height: 256, sizeBytes: bytes.length } });
    expect(calls[0]?.url).toBe("/api/v1/admin/media/images");
    const body = JSON.parse(String(calls[0]?.init.body)) as { profile: string; data: string };
    expect(body.profile).toBe("task");
    expect(Buffer.from(body.data, "base64").equals(Buffer.from(bytes))).toBe(true);
    expect(imageUrl("f".repeat(64))).toBe(`/api/v1/admin/media/${"f".repeat(64)}.webp`);
  });

  it("отказ сервера — его словами", async () => {
    const { fetch } = fakeFetch(json(400, { error: { code: "image_rejected", message: "Картинка задания — квадрат, а пришло 120×80" } }));
    const result = await uploadImage(new AdminApi(fetch), "task", new Blob([new Uint8Array(10)], { type: "image/webp" }));
    expect(result.ok ? null : result.error.message).toBe("Картинка задания — квадрат, а пришло 120×80");
  });

  it("base64 большого файла — без переполнения стека и без потерь", async () => {
    const bytes = new Uint8Array(300_000).map((_, index) => (index * 7) % 256);
    expect(Buffer.from(await toBase64(new Blob([bytes])), "base64").equals(Buffer.from(bytes))).toBe(true);
  });
});
