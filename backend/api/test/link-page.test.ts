import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_SCRIPT, OPEN_SCRIPT_HASH, openPage } from "../src/modules/links/link-page.js";

/**
 * Страница-переходник (docs/35-stage4-plan.md Р94/Р95, tasks/T-0058): сразу
 * диплинк в Telegram, через 2,5 с запасной https://t.me, если приложение не
 * открылось. Скрипт один и постоянный — его хэш стоит в политике источников,
 * поэтому `'unsafe-inline'` не нужен.
 */

const DEEP = "tg://resolve?domain=rubezh_bot&startapp=c-Ab12Cd34Ef56";
const FALLBACK = "https://t.me/rubezh_bot?startapp=c-Ab12Cd34Ef56";

describe("хэш скрипта переходника", () => {
  it("OPEN_SCRIPT_HASH — 'sha256-<base64>' ровно от текста скрипта", () => {
    const expected = `'sha256-${createHash("sha256").update(OPEN_SCRIPT, "utf8").digest("base64")}'`;
    expect(OPEN_SCRIPT_HASH).toBe(expected);
  });
});

describe("разметка", () => {
  it("адреса лежат в JSON-данных, а не в коде", () => {
    const html = openPage({ deep: DEEP, fallback: FALLBACK });
    const match = /<script id="target" type="application\/json">([^<]*)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? "")).toEqual({ deep: DEEP, fallback: FALLBACK });
  });

  it("</script> в адресе не закрывает тег данных", () => {
    const html = openPage({ deep: "tg://x?a=</script><script>alert(1)</script>", fallback: FALLBACK });
    // Ровно два <script>: данные и постоянный скрипт.
    expect(html.match(/<script/g)).toHaveLength(2);
    const data = /<script id="target" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    expect(JSON.parse(data?.[1] ?? "").deep).toBe("tg://x?a=</script><script>alert(1)</script>");
    expect(html).not.toContain("alert(1)</script>");
  });

  it("обе кнопки есть, адреса в них экранированы", () => {
    const html = openPage({ deep: `${DEEP}&x="y"`, fallback: `${FALLBACK}&a=1&b=<2>` });
    expect(html).toContain('href="tg://resolve?domain=rubezh_bot&amp;startapp=c-Ab12Cd34Ef56&amp;x=&quot;y&quot;"');
    expect(html).toContain('href="https://t.me/rubezh_bot?startapp=c-Ab12Cd34Ef56&amp;a=1&amp;b=&lt;2&gt;"');
    expect(html).toContain("Открыть в Telegram");
    expect(html).toContain("Открыть в браузере");
    expect(html).toContain("Открываем Telegram…");
    expect(html).toContain("Не открылось? Нажмите кнопку");
  });

  it("единственный исполняемый скрипт — OPEN_SCRIPT", () => {
    const html = openPage({ deep: DEEP, fallback: FALLBACK });
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    const executable = scripts.filter(([, attributes]) => !/type="application\/json"/.test(attributes ?? ""));
    expect(executable).toHaveLength(1);
    expect(executable[0]?.[2]).toBe(OPEN_SCRIPT);
  });

  it("не просит индексации и не ставит стили: политика источников их бы всё равно отсекла", () => {
    const html = openPage({ deep: DEEP, fallback: FALLBACK });
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/\sstyle=/);
  });
});

describe("скрипт: диплинк сразу, запасной адрес через 2,5 с", () => {
  interface Page {
    href: string | null;
    replaced: string | null;
    hidden: boolean;
    fire(event: "blur" | "visibilitychange"): void;
  }

  /** Страница-двойник: ровно те части окна, которые читает скрипт. */
  function run(): Page {
    const listeners = new Map<string, (() => void)[]>();
    const on = (name: string, handler: () => void): void => void listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    const page: Page = {
      href: null,
      replaced: null,
      hidden: false,
      fire: (event) => listeners.get(event)?.forEach((handler) => handler()),
    };
    const location = {
      set href(value: string) {
        page.href = value;
      },
      replace(value: string) {
        page.replaced = value;
      },
    };
    const document = {
      getElementById: () => ({ textContent: JSON.stringify({ deep: DEEP, fallback: FALLBACK }) }),
      addEventListener: on,
      get hidden() {
        return page.hidden;
      },
    };
    const window = { addEventListener: on, location, setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms) };
    runInContext(OPEN_SCRIPT, createContext({ window, document, JSON }));
    return page;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("сразу переходит по диплинку", () => {
    const page = run();
    expect(page.href).toBe(DEEP);
    expect(page.replaced).toBeNull();
  });

  it("приложение не открылось (страница видна, фокус на месте) — через 2,5 с запасной адрес", () => {
    const page = run();
    vi.advanceTimersByTime(2499);
    expect(page.replaced).toBeNull();
    vi.advanceTimersByTime(1);
    expect(page.replaced).toBe(FALLBACK);
  });

  it("окно потеряло фокус — приложение открылось, запасного перехода нет", () => {
    const page = run();
    page.fire("blur");
    vi.advanceTimersByTime(5000);
    expect(page.replaced).toBeNull();
  });

  it("страница скрыта к 2,5 с — запасного перехода нет", () => {
    const page = run();
    page.hidden = true;
    page.fire("visibilitychange");
    vi.advanceTimersByTime(5000);
    expect(page.replaced).toBeNull();
  });

  it("страница скрыта, но событие не пришло — проверка на таймере всё равно не переводит", () => {
    const page = run();
    page.hidden = true;
    vi.advanceTimersByTime(5000);
    expect(page.replaced).toBeNull();
  });
});
