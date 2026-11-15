import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HERO_PORTRAITS, WORDMARK_SVG } from "../src/common/card/brand-art.js";
import { CardDelivery, cardCacheKey, type CardFileCache } from "../src/common/card/card-cache.js";
import { cardHashOf } from "../src/common/card/card-store.js";
import { heroScene, SCENE_HEIGHT, SCENE_WIDTH } from "../src/common/card/scene.js";
import { BUNDLED_FONT_DIR, HEADING_FONT, renderPixels, renderPng, svgDocument, text } from "../src/common/card/svg.js";
import { TelegramBotApi } from "../src/platforms/telegram/telegram-bot-api.js";
import { TelegramMessagePreparer, type PreparerBotApi } from "../src/platforms/telegram/telegram-message-preparer.js";
import { PNG_RENDER_TIMEOUT_MS } from "./helpers/card-render.js";

// Общая основа картинок бота: шрифт игры, сцена с обликом, кэш file_id и
// подготовленное сообщение с картинкой (tasks/T-0252, docs/35-stage4-plan.md Р156).

/** Рисунки, вставленные в SVG картинками: у сцены это словесный знак и портрет облика. */
function embeddedImages(svg: string): string[] {
  return [...svg.matchAll(/href="data:image\/svg\+xml;base64,([^"]+)"/g)].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8"));
}

/** Строки текста сцены заданного кегля: каждая строка — свой `<text>`. */
function textLines(svg: string, size: number): string[] {
  return [...svg.matchAll(/<text [^>]*font-size="(\d+)"[^>]*>([^<]*)<\/text>/g)].filter((match) => Number(match[1]) === size).map((match) => match[2] ?? "");
}

describe("шрифт игры", () => {
  it("Russo One лежит в репозитории рядом с лицензией OFL и входит в каталоги шрифтов рендера", () => {
    const font = join(BUNDLED_FONT_DIR, "RussoOne-Regular.ttf");
    expect(existsSync(font)).toBe(true);
    // TrueType: resvg читает TTF и OTF, но не woff.
    expect(readFileSync(font).subarray(0, 4).toString("hex")).toBe("00010000");
    expect(readFileSync(join(BUNDLED_FONT_DIR, "OFL.txt"), "utf8")).toContain("SIL Open Font License");
    expect(HEADING_FONT.startsWith("Russo One")).toBe(true);
  });

  it("заголовок рисуется Russo One, а не запасной гарнитурой", () => {
    const heading = (family: string) => {
      const label = text(20, 90, "Рубеж 2340", { size: 72, fill: "#ffffff" }).replace(/font-family="[^"]*"/, `font-family="${family}"`);
      return renderPixels(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="120" viewBox="0 0 640 120">${label}</svg>`);
    };
    const russo = heading("Russo One");
    const fallback = heading("DejaVu Sans");
    const inked = (pixels: Buffer) => pixels.reduce((count, value, index) => (index % 4 === 3 && value > 0 ? count + 1 : count), 0);

    // Прозрачный холст: непрозрачные пиксели — это буквы.
    expect(inked(russo.pixels)).toBeGreaterThan(500);
    // Тот же текст запасным шрифтом выходит другим: у гарнитуры игры нет метрик DejaVu.
    expect(russo.pixels.equals(fallback.pixels)).toBe(false);
  }, PNG_RENDER_TIMEOUT_MS);

  it("текст сцены с заголовком шрифтом игры: PNG заголовка непустой в его зоне", () => {
    const withTitle = renderPixels(heroScene({ title: "Рубеж" }));
    const without = renderPixels(heroScene({ title: "" }));
    // Зона заголовка — левая колонка от x 44, верх первой строки y 140 (design/art/meta-v2.md §3.4).
    let changed = 0;
    for (let y = 100; y < 200; y++) {
      for (let x = 44; x < 600; x++) {
        const at = (y * SCENE_WIDTH + x) * 4;
        if (withTitle.pixels[at] !== without.pixels[at] || withTitle.pixels[at + 1] !== without.pixels[at + 1]) changed++;
      }
    }
    expect(changed).toBeGreaterThan(500);
  }, PNG_RENDER_TIMEOUT_MS);
});

describe("сцена картинок бота", () => {
  it("1200×675, со словесным знаком", () => {
    const svg = heroScene({ title: "Привет" });
    expect(svg).toContain(`width="${SCENE_WIDTH}" height="${SCENE_HEIGHT}"`);
    expect([SCENE_WIDTH, SCENE_HEIGHT]).toEqual([1200, 675]);
    expect(embeddedImages(svg)).toContain(WORDMARK_SVG);
  });

  it("облик vityaz вставляет свой портрет, неизвестный и пустой — keeper", () => {
    const portrait = (skin: string | null | undefined) => embeddedImages(heroScene({ title: "x", skin })).filter((image) => image !== WORDMARK_SVG);
    expect(portrait("vityaz")).toEqual([HERO_PORTRAITS.vityaz]);
    expect(portrait("нет-такого-облика")).toEqual([HERO_PORTRAITS.keeper]);
    expect(portrait(null)).toEqual([HERO_PORTRAITS.keeper]);
    expect(portrait(undefined)).toEqual([HERO_PORTRAITS.keeper]);
    // Служебные ключи объекта — не облики.
    expect(portrait("constructor")).toEqual([HERO_PORTRAITS.keeper]);
    expect(HERO_PORTRAITS.vityaz).not.toBe(HERO_PORTRAITS.keeper);
  });

  it("длинное имя переносится: заголовок не больше двух строк, текст не больше трёх", () => {
    const longTitle = "Ярослава-Велимира Святополк-Изяславовна зовёт тебя на рубеж и на самый дальний край мира";
    const longText = "Облик игрока, мир забега и словесный знак — одна витрина игры. ".repeat(6);
    const svg = heroScene({ title: longTitle, text: longText });

    const titleLines = textLines(svg, 52);
    const bodyLines = textLines(svg, 28);
    expect(titleLines.length).toBeGreaterThan(1);
    expect(titleLines.length).toBeLessThanOrEqual(2);
    expect(bodyLines.length).toBe(3);
    // Лишнее обрезается многоточием, а не уходит за край.
    expect(titleLines.at(-1)).toMatch(/…$/);
    expect(bodyLines.at(-1)).toMatch(/…$/);
    // Короткое не трогается.
    expect(textLines(heroScene({ title: "Привет, Анна", text: "Коротко" }), 52)).toEqual(["Привет, Анна"]);
  });

  it("плашка числа рисуется, а имя и подписи не ломают разметку", () => {
    const svg = heroScene({ title: "<b>&Имя</b>", text: "a \"b\" 'c'", badge: { text: "★ Новый рекорд", tone: "elite" } });
    expect(svg).toContain("★ Новый рекорд");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&#60;b&#62;&#38;Имя&#60;/b&#62;");
    expect(svg).toMatch(/fill="#ffd15c"/);
  });

  it("одинаковый вход — один и тот же PNG и хэш, другое имя — другой", () => {
    const first = renderPng(heroScene({ title: "Мирон зовёт тебя", skin: "vityaz" }));
    const same = renderPng(heroScene({ title: "Мирон зовёт тебя", skin: "vityaz" }));
    const other = renderPng(heroScene({ title: "Ярослава зовёт тебя", skin: "vityaz" }));

    expect(first.subarray(1, 4).toString()).toBe("PNG");
    expect(cardHashOf(first)).toBe(cardHashOf(same));
    expect(cardHashOf(first)).not.toBe(cardHashOf(other));
    expect(cardHashOf(first)).toBe(createHash("sha256").update(first).digest("hex"));
  }, PNG_RENDER_TIMEOUT_MS);

  it("пустой документ без сцены тоже рисуется тем же рендером", () => {
    expect(renderPng(svgDocument(40, 20, [])).subarray(1, 4).toString()).toBe("PNG");
  }, PNG_RENDER_TIMEOUT_MS);
});

class MemoryFiles implements CardFileCache {
  readonly files = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.files.get(key) ?? null;
  }
  async set(key: string, fileId: string): Promise<void> {
    this.files.set(key, fileId);
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}

describe("кэш file_id", () => {
  it("ключ — хэш видимого и версия шаблона; в открытом виде в нём ничего нет", () => {
    const key = cardCacheKey(3, ["Анна", 2340]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).toBe(cardCacheKey(3, ["Анна", 2340]));
    expect(key).not.toBe(cardCacheKey(4, ["Анна", 2340]));
    expect(key).not.toBe(cardCacheKey(3, ["Анна", 2341]));
    expect(key).not.toContain("Анна");
  });

  function delivery() {
    const files = new MemoryFiles();
    const log: string[] = [];
    let renders = 0;
    const sent: (string | Buffer)[] = [];
    const deliver = new CardDelivery(files, { isStale: (error) => error instanceof Error && error.message === "stale", log: (event) => log.push(event) });
    const go = (key: string, rejectFileIds = false) =>
      deliver.send({
        key,
        render: () => {
          renders++;
          return Buffer.from("png");
        },
        upload: async (photo) => {
          if (typeof photo === "string" && rejectFileIds) throw new Error("stale");
          sent.push(photo);
          return { fileId: `file-${sent.length}` };
        },
      });
    return { files, log, sent, go, renders: () => renders };
  }

  it("первая отправка рисует и запоминает file_id, вторая идёт по нему без рендера", async () => {
    const { go, sent, renders, files } = delivery();
    expect(await go("k")).toEqual({ cached: false, pngBytes: 3 });
    expect(await go("k")).toEqual({ cached: true });
    expect(renders()).toBe(1);
    expect(sent).toEqual([Buffer.from("png"), "file-1"]);
    expect(files.files.get("k")).toBe("file-1");
  });

  it("протухший file_id — нарисовать и загрузить заново, а иная ошибка пробрасывается", async () => {
    const { go, renders, files, log } = delivery();
    await go("k");
    expect(await go("k", true)).toMatchObject({ cached: false });
    expect(renders()).toBe(2);
    expect(files.files.size).toBe(1);
    expect(log).toContain("cached_file_rejected");

    const files2 = new MemoryFiles();
    files2.files.set("k", "file-x");
    const failing = new CardDelivery(files2, { isStale: () => false, log: () => undefined });
    await expect(
      failing.send({ key: "k", render: () => Buffer.from("png"), upload: async () => Promise.reject(new Error("сеть")) }),
    ).rejects.toThrow("сеть");
  });

  it("два одновременных запроса одной картинки рисуют её один раз", async () => {
    const { go, renders } = delivery();
    await Promise.all([go("same"), go("same")]);
    expect(renders()).toBe(1);
  });

  it("недоступный кэш не мешает отправке", async () => {
    const broken: CardFileCache = {
      get: async () => Promise.reject(new Error("redis")),
      set: async () => Promise.reject(new Error("redis")),
      delete: async () => Promise.reject(new Error("redis")),
    };
    const log: string[] = [];
    const sent: (string | Buffer)[] = [];
    const deliver = new CardDelivery(broken, { isStale: () => false, log: (event) => log.push(event) });
    const result = await deliver.send({
      key: "k",
      render: () => Buffer.from("png"),
      upload: async (photo) => {
        sent.push(photo);
        return { fileId: "f" };
      },
    });
    expect(result.cached).toBe(false);
    expect(sent).toEqual([Buffer.from("png")]);
    expect(log).toEqual(expect.arrayContaining(["cache_unavailable", "cache_write_failed"]));
  });
});

describe("подготовленное сообщение с картинкой", () => {
  const TOKEN = "123456:SECRET-token";

  function recorder() {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, result: { id: "abc", expiration_date: 1_790_000_000 } }), { status: 200 });
    };
    return { calls, api: new TelegramBotApi(TOKEN, "https://api.telegram.org", fetchImpl) };
  }

  const article = { id: "invite-1", title: "Играть вместе", description: "Откроешь — и мы друзья", text: "Зову тебя в игру", button: { text: "▶ Играть", url: "https://t.me/bot/play?startapp=f-x" } };
  const bodyOf = (call: { init: RequestInit } | undefined): { result: { input_message_content: Record<string, unknown> } } => JSON.parse(String(call?.init.body));

  it("с imageUrl — большой предпросмотр над текстом по адресу картинки", async () => {
    const { calls, api } = recorder();
    await api.savePreparedInlineMessage(424242, { ...article, imageUrl: "https://api.example/api/v1/cards/abc.png" });
    expect(bodyOf(calls[0]).result.input_message_content).toEqual({
      message_text: "Зову тебя в игру",
      link_preview_options: { url: "https://api.example/api/v1/cards/abc.png", prefer_large_media: true, show_above_text: true },
    });
  });

  it("без imageUrl — как раньше: только текст", async () => {
    const { calls, api } = recorder();
    await api.savePreparedInlineMessage(424242, article);
    expect(bodyOf(calls[0]).result.input_message_content).toEqual({ message_text: "Зову тебя в игру" });
  });

  it("адаптер Telegram передаёт imageUrl дальше, а без него ключа нет", async () => {
    const seen: Record<string, unknown>[] = [];
    const api: PreparerBotApi = {
      savePreparedInlineMessage: async (_userId, prepared) => {
        seen.push({ ...prepared });
        return { id: "tg-1", expiresAt: null };
      },
    };
    const preparer = new TelegramMessagePreparer(api, true);
    const message = { title: "t", description: "d", text: "x", button: { text: "▶", url: "https://t.me/b" } };
    await preparer.prepare("424242", { ...message, imageUrl: "https://api.example/api/v1/cards/abc.png" });
    await preparer.prepare("424242", message);
    expect(seen[0]?.imageUrl).toBe("https://api.example/api/v1/cards/abc.png");
    expect("imageUrl" in (seen[1] ?? {})).toBe(false);
  });
});
