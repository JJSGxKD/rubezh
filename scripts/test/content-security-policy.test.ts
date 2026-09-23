import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../vite/content-security-policy";

/**
 * Политика источников клиента (docs/34-stage3-plan.md, WP3).
 *
 * Ошибка здесь дорога в обе стороны: слишком мягко — политика ничего не
 * закрывает, слишком строго — игра молча не грузится у части игроков. Самая
 * коварная — встраивание: Telegram Web открывает Mini App во фрейме, а
 * тестируют чаще всего на телефоне, где фрейма нет.
 */

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => {
        const [name, ...sources] = part.split(/\s+/);
        return [name ?? "", sources];
      }),
  );
}

const build = directives(contentSecurityPolicy({ mode: "build", apiOrigin: "" }));
const dev = directives(contentSecurityPolicy({ mode: "dev", apiOrigin: "" }));

describe("политика источников клиента", () => {
  it("в сборке скрипты только свои: ни встроенных, ни eval", () => {
    expect(build.get("script-src")).toEqual(["'self'"]);
  });

  it("пускает во фрейм Telegram Web — иначе игра там не откроется", () => {
    expect(build.get("frame-ancestors")).toContain("https://web.telegram.org");
  });

  it("и никого больше: чужой сайт не встроит игру для кликджекинга", () => {
    expect(build.get("frame-ancestors")).toEqual(["'self'", "https://web.telegram.org"]);
  });

  it("показывает аватары игроков с t.me — их адрес приходит в данных запуска", () => {
    expect(build.get("img-src")).toContain("https://t.me");
  });

  it("пускает data: для картинок: иконка в разметке и служебные текстуры Phaser", () => {
    expect(build.get("img-src")).toContain("data:");
  });

  it("пускает blob: для картинок: так загрузчик Phaser отдаёт текстуру из файла", () => {
    // Сегодня графика процедурная и blob: не нужен, но первый спрайт из
    // assets/ без него молча не нарисуется.
    expect(build.get("img-src")).toContain("blob:");
  });

  it("разрешает встроенные стили: без них вернётся белый экран до первого кадра", () => {
    expect(build.get("style-src")).toContain("'unsafe-inline'");
  });

  it("соединяется с API на другом домене, но только по его источнику", () => {
    const withApi = directives(contentSecurityPolicy({ mode: "build", apiOrigin: "https://api.rubezh.gonet.fun/api/v1" }));

    expect(withApi.get("connect-src")).toEqual(["'self'", "https://api.rubezh.gonet.fun"]);
  });

  it("битый адрес API не роняет сборку: строгая политика лучше несобранного клиента", () => {
    const broken = directives(contentSecurityPolicy({ mode: "build", apiOrigin: "не адрес" }));

    expect(broken.get("connect-src")).toEqual(["'self'"]);
  });

  it("плагины закрыты вовсе", () => {
    expect(build.get("object-src")).toEqual(["'none'"]);
  });

  it("в сборке переписывает http на https, в разработке — нет", () => {
    expect(build.has("upgrade-insecure-requests")).toBe(true);
    // dev-сервер бывает по http, без сертификата.
    expect(dev.has("upgrade-insecure-requests")).toBe(false);
  });

  it("в разработке пускает то, что нужно самой разработке, и только это", () => {
    // React вставляет встроенный скрипт горячей перезагрузки, Vite держит
    // websocket HMR.
    expect(dev.get("script-src")).toContain("'unsafe-inline'");
    expect(dev.get("connect-src")).toEqual(expect.arrayContaining(["ws:", "wss:"]));
    expect(dev.get("frame-ancestors")).toEqual(build.get("frame-ancestors"));
  });
});
