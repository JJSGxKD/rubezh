import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchSourceAvatar, missOf, SOURCE_AVATAR_PATH } from "../src/api/source-avatar";
import { readSource, refillSourceImages, shouldTakeFromSource, SOURCE_DEBOUNCE_MS, SOURCE_MESSAGES, takeSourceImage, type ImagePipeline, type TakeContext } from "../src/ui/source-image";
import type { TaskDef } from "../src/api/tasks";
import { fakeFetch, json } from "./helpers";

/**
 * Картинка источника задания (docs/35-stage4-plan.md Р158): панель сама берёт
 * аватарку канала или бота, пока поле пусто и источник прошёл проверку формы.
 * Своя картинка сильнее; убранную руками сама не подставляет.
 */

const channelTask = { kind: "channel", params: { platform: "telegram", chat: "@rubezh_game", url: "https://t.me/rubezh_game" } } as const;
const botTask = { kind: "bot", params: { url: "https://t.me/some_bot/app?startapp=x" } } as const;

describe("источник задания", () => {
  it("канал Telegram с @именем или id — готов к запросу", () => {
    const reading = readSource(channelTask);
    expect(reading).toMatchObject({ state: "ready", kind: "channel", request: { kind: "channel", platform: "telegram", chat: "@rubezh_game" } });
    expect(readSource({ kind: "channel", params: { platform: "telegram", chat: "  -1001234567890 ", url: "https://t.me/x" } })).toMatchObject({ state: "ready", request: { chat: "-1001234567890" } });
  });

  it("канал, который ещё набирают, — не готов: запрос с недописанным именем сжёг бы лимит", () => {
    for (const chat of ["", "@", "@ab", "rubezh_game", "@bad-name", "https://t.me/rubezh_game"]) {
      expect(readSource({ kind: "channel", params: { platform: "telegram", chat, url: "https://t.me/x" } }), chat).toEqual({ state: "incomplete", kind: "channel" });
    }
    expect(readSource({ kind: "channel", params: null })).toEqual({ state: "incomplete", kind: "channel" });
  });

  it("бот и Mini App — по ссылке; параметры запуска не мешают", () => {
    expect(readSource(botTask)).toMatchObject({ state: "ready", kind: "bot", request: { kind: "bot", platform: "telegram", url: "https://t.me/some_bot/app?startapp=x" } });
    expect(readSource({ kind: "bot", params: { platforms: ["telegram", "max"], url: "https://t.me/some_bot" } })).toMatchObject({ state: "ready" });
  });

  it("ссылка на бота: не https, нет имени, лишние сегменты — не готова", () => {
    for (const url of ["", "t.me/some_bot", "http://t.me/some_bot", "https://t.me/", "https://t.me/ab", "https://t.me/some_bot/app/extra"]) {
      expect(readSource({ kind: "bot", params: { url } }), url).toEqual({ state: "incomplete", kind: "bot" });
    }
  });

  it("MAX и VK картинку не отдают — об этом и скажем; бот без Telegram среди площадок — то же", () => {
    expect(readSource({ kind: "channel", params: { platform: "max", chat: "123456", url: "https://max.ru/x" } })).toEqual({ state: "unsupported", kind: "channel" });
    expect(readSource({ kind: "channel", params: { platform: "vk", chat: "", url: "https://vk.com/x" } })).toEqual({ state: "unsupported", kind: "channel" });
    expect(readSource({ kind: "bot", params: { platforms: ["vk", "web"], url: "https://t.me/some_bot" } })).toEqual({ state: "unsupported", kind: "bot" });
  });

  it("у ссылки и остальных видов источника нет", () => {
    expect(readSource({ kind: "link", params: { url: "https://example.com/" } })).toEqual({ state: "none" });
    expect(readSource({ kind: "runs", params: null })).toEqual({ state: "none" });
  });

  it("ключ источника меняется вместе с каналом и ссылкой", () => {
    const first = readSource(channelTask);
    const second = readSource({ kind: "channel", params: { platform: "telegram", chat: "@other_chan", url: "https://t.me/x" } });
    expect(first.state === "ready" && second.state === "ready" && first.key !== second.key).toBe(true);
    expect(readSource(botTask)).toMatchObject({ key: expect.stringContaining("bot") });
  });

  it("ввод затихает на 800 мс", () => {
    expect(SOURCE_DEBOUNCE_MS).toBe(800);
  });
});

describe("когда брать картинку сама", () => {
  const ready = readSource(channelTask);
  const base: TakeContext = { reading: ready, image: null, taken: null, removedByHand: false, attemptedKey: null };

  it("поле пусто и источник валиден — брать", () => {
    expect(shouldTakeFromSource(base)).toBe(true);
  });

  it("своя загруженная картинка — не брать", () => {
    expect(shouldTakeFromSource({ ...base, image: "a".repeat(64) })).toBe(false);
  });

  it("убрали руками — не брать до «Обновить с источника»", () => {
    expect(shouldTakeFromSource({ ...base, removedByHand: true })).toBe(false);
  });

  it("вид link, недописанный источник и чужая площадка — не брать", () => {
    for (const reading of [readSource({ kind: "link", params: { url: "https://example.com/" } }), readSource({ kind: "channel", params: { platform: "telegram", chat: "@a", url: "https://t.me/x" } }), readSource({ kind: "channel", params: { platform: "max", chat: "1234", url: "https://max.ru/x" } })]) {
      expect(shouldTakeFromSource({ ...base, reading })).toBe(false);
    }
  });

  it("уже пробовали этот источник — не долбить: повтор только кнопкой", () => {
    expect(ready.state === "ready" && shouldTakeFromSource({ ...base, attemptedKey: ready.key })).toBe(false);
  });

  it("взятая сама картинка заменяется, когда источник сменили; своя — нет", () => {
    const other = readSource({ kind: "channel", params: { platform: "telegram", chat: "@other_chan", url: "https://t.me/x" } });
    const taken = { imageId: "b".repeat(64), key: ready.state === "ready" ? ready.key : "" };
    expect(shouldTakeFromSource({ ...base, reading: other, image: taken.imageId, taken, attemptedKey: taken.key })).toBe(true);
    expect(shouldTakeFromSource({ ...base, reading: other, image: "c".repeat(64), taken, attemptedKey: taken.key })).toBe(false);
  });
});

describe("запрос к серверу", () => {
  it("тело — вид, площадка и источник; ответ — байты с типом источника", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
    const { fetch, calls } = fakeFetch(new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }));
    const reading = readSource(channelTask);
    if (reading.state !== "ready") throw new Error("источник должен быть готов");
    const result = await fetchSourceAvatar(new AdminApi(fetch), reading.request);
    expect(result.ok && result.data.blob.type).toBe("image/jpeg");
    expect(result.ok && result.data.blob.size).toBe(bytes.length);
    expect(calls[0]?.url).toBe(`/api/v1/admin${SOURCE_AVATAR_PATH}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ kind: "channel", platform: "telegram", chat: "@rubezh_game" });
  });

  it("ошибки — словами состояния поля: нет картинки, сбой сети, лимит", async () => {
    const miss = async (response: Response | Error) => {
      const reading = readSource(botTask);
      if (reading.state !== "ready") throw new Error("источник должен быть готов");
      const result = await fetchSourceAvatar(new AdminApi(fakeFetch(response).fetch), reading.request);
      if (result.ok) throw new Error("ожидали отказ");
      return missOf(result.error);
    };
    expect(await miss(json(404, { error: { code: "source_avatar_missing", message: "нет" } }))).toEqual({ outcome: "none", message: SOURCE_MESSAGES.none });
    expect(await miss(json(422, { error: { code: "source_avatar_invalid", message: "кривая ссылка" } }))).toEqual({ outcome: "none", message: SOURCE_MESSAGES.invalid });
    expect(await miss(json(503, { error: { code: "source_avatar_unavailable", message: "x" } }))).toEqual({ outcome: "failed", message: SOURCE_MESSAGES.failed });
    expect(await miss(new TypeError("offline"))).toEqual({ outcome: "failed", message: SOURCE_MESSAGES.failed });
    expect(await miss(json(429, { error: { code: "rate_limited", message: "x" } }))).toMatchObject({ outcome: "failed" });
  });

  it("тексты состояний — как в сценарии", () => {
    expect(SOURCE_MESSAGES).toMatchObject({
      loading: "Берём картинку…",
      none: "У источника нет картинки — загрузите свою",
      unsupported: "Эта площадка картинку не отдаёт — загрузите свою",
      failed: "Не удалось взять картинку",
    });
  });
});

describe("от байтов до сохранённой картинки", () => {
  const upload = json(201, { data: { imageId: "d".repeat(64), width: 256, height: 256, sizeBytes: 10 } });
  const pipeline = (outcome: Awaited<ReturnType<ImagePipeline["toWebp"]>>): ImagePipeline & { seen: Blob[] } => {
    const seen: Blob[] = [];
    return {
      seen,
      async toWebp(blob) {
        seen.push(blob);
        return outcome;
      },
    };
  };
  const webp = new Blob([new Uint8Array(1000)], { type: "image/webp" });
  const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]), { status: 200, headers: { "content-type": "image/jpeg" } });
  const request = (() => {
    const reading = readSource(channelTask);
    if (reading.state !== "ready") throw new Error("источник должен быть готов");
    return reading.request;
  })();

  it("скачали, кадрировали и сжали, загрузили обычной загрузкой с профилем task", async () => {
    const { fetch, calls } = fakeFetch(jpeg(), upload);
    const steps = pipeline({ ok: true, blob: webp });
    const taken = await takeSourceImage(new AdminApi(fetch), request, steps);
    expect(taken).toEqual({ ok: true, imageId: "d".repeat(64) });
    expect(steps.seen[0]?.type).toBe("image/jpeg");
    expect(calls[1]?.url).toBe("/api/v1/admin/media/images");
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ profile: "task" });
  });

  it("нет картинки у источника — outcome none, загрузки нет", async () => {
    const { fetch, calls } = fakeFetch(json(404, { error: { code: "source_avatar_missing", message: "нет" } }));
    expect(await takeSourceImage(new AdminApi(fetch), request, pipeline({ ok: true, blob: webp }))).toEqual({ ok: false, outcome: "none", message: SOURCE_MESSAGES.none });
    expect(calls).toHaveLength(1);
  });

  it("картинка слишком мелкая или не сжалась — словами, загрузки нет", async () => {
    const { fetch, calls } = fakeFetch(jpeg());
    const taken = await takeSourceImage(new AdminApi(fetch), request, pipeline({ ok: false, problem: "Картинка 80×60 — меньше 96 px", outcome: "none" }));
    expect(taken).toEqual({ ok: false, outcome: "none", message: "Картинка 80×60 — меньше 96 px" });
    expect(calls).toHaveLength(1);
  });

  it("отказ загрузки — сообщением сервера, outcome failed", async () => {
    const { fetch } = fakeFetch(jpeg(), json(400, { error: { code: "image_rejected", message: "Картинка задания — квадрат" } }));
    expect(await takeSourceImage(new AdminApi(fetch), request, pipeline({ ok: true, blob: webp }))).toEqual({ ok: false, outcome: "failed", message: "Картинка задания — квадрат" });
  });
});

describe("«Картинки источников» над списком", () => {
  const task = (patch: Partial<TaskDef>): TaskDef => ({ taskId: "t", period: "achievement", kind: "channel", params: channelTask.params, filter: null, tier: null, target: 1, title: null, coins: 1, gems: 0, shards: 0, passPoints: 0, sort: 0, active: true, limit: null, image: null, ...patch }) as TaskDef;

  it("идёт по активным channel и bot без картинки по одному и сохраняет тем же сохранением; итог — «Обновлено N, без картинки M»", async () => {
    const order: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const tasks = [
      task({ taskId: "a_channel" }),
      task({ taskId: "b_bot", kind: "bot", params: botTask.params }),
      task({ taskId: "c_has_image", image: "e".repeat(64) }),
      task({ taskId: "d_off", active: false }),
      task({ taskId: "e_link", kind: "link", params: { url: "https://example.com/" } }),
      task({ taskId: "f_max", params: { platform: "max", chat: "12345", url: "https://max.ru/x" } }),
      task({ taskId: "g_empty", params: { platform: "telegram", chat: "@empty_chan", url: "https://t.me/x" } }),
    ];
    const summary = await refillSourceImages(tasks, {
      async take(request) {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await Promise.resolve();
        running -= 1;
        order.push(request.kind === "channel" ? request.chat : request.url);
        return request.kind === "channel" && request.chat === "@empty_chan" ? { ok: false, outcome: "none", message: SOURCE_MESSAGES.none } : { ok: true, imageId: "f".repeat(64) };
      },
      async save(saved) {
        order.push(`save:${saved.taskId}:${String(saved.image)}`);
        return true;
      },
    });
    expect(order).toEqual(["@rubezh_game", `save:a_channel:${"f".repeat(64)}`, "https://t.me/some_bot/app?startapp=x", `save:b_bot:${"f".repeat(64)}`, "@empty_chan"]);
    expect(maxRunning).toBe(1);
    expect(summary).toEqual({ updated: 2, missed: 1, text: "Обновлено 2, без картинки 1" });
  });

  it("сохранение не прошло — задание считается без картинки", async () => {
    const summary = await refillSourceImages([task({ taskId: "a_channel" })], { take: async () => ({ ok: true, imageId: "f".repeat(64) }), save: async () => false });
    expect(summary).toEqual({ updated: 0, missed: 1, text: "Обновлено 0, без картинки 1" });
  });
});
