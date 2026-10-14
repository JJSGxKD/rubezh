import { describe, expect, it } from "vitest";
import { AVAILABILITY_CHECKERS, CHECKER_REFERER_HOSTS, checkerOf } from "../src/modules/links/availability-checkers.js";
import { isCrawler } from "../src/modules/links/crawler.js";

/**
 * Сервисы проверки доступности (docs/24-attribution-and-sharing.md §3.3): их
 * запросы не клики. Признак — точный хост Referer или фрагмент User-Agent из
 * явного списка, а не общее правило «похоже на бота».
 */

const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36";

const SERVICE_AGENTS: ReadonlyArray<readonly [string, string]> = [
  ["Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)", "uptimerobot"],
  ["Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)", "pingdom"],
  ["Mozilla/5.0 (Windows NT 6.1; WOW64; rv:45.0.247) Gecko/20100101 Firefox/83.0 Site24x7", "site24x7"],
  ["Mozilla/5.0 (compatible;HostTracker/2.0;+http://www.host-tracker.com/)", "hosttracker"],
  ["Mozilla/5.0 (compatible; CheckHost/1.0)", "check-host"],
];

describe("checkerOf: Referer", () => {
  it("check-host.net — сервис, с портом и в любом регистре тоже", () => {
    expect(checkerOf({ userAgent: ANDROID, refererHost: "check-host.net" })).toBe("check-host");
    expect(checkerOf({ userAgent: ANDROID, refererHost: "check-host.net:443" })).toBe("check-host");
    expect(checkerOf({ userAgent: ANDROID, refererHost: "Check-Host.NET" })).toBe("check-host");
  });

  it("похожий, но другой хост и человеческий Referer — не сервис", () => {
    for (const refererHost of ["evil-check-host.net", "check-host.net.evil.example", "t.me", null]) {
      expect(checkerOf({ userAgent: ANDROID, refererHost }), String(refererHost)).toBeNull();
    }
  });
});

describe("checkerOf: User-Agent", () => {
  it.each(SERVICE_AGENTS)("%s → %s", (userAgent, service) => {
    expect(checkerOf({ userAgent, refererHost: null })).toBe(service);
  });

  it("люди, краулеры превью и запрос без User-Agent — не сервис", () => {
    for (const userAgent of [ANDROID, LINUX, "TelegramBot (like TwitterBot)", null]) {
      expect(checkerOf({ userAgent, refererHost: null }), String(userAgent)).toBeNull();
    }
  });
});

describe("список AVAILABILITY_CHECKERS", () => {
  it("имена уникальны и пригодны для метки; у каждой записи есть признак", () => {
    const names = AVAILABILITY_CHECKERS.map((item) => item.service);
    expect(new Set(names).size).toBe(names.length);
    expect(AVAILABILITY_CHECKERS.length).toBeGreaterThanOrEqual(5);
    for (const item of AVAILABILITY_CHECKERS) {
      expect(item.service, item.service).toMatch(/^[a-z0-9-]+$/);
      expect(item.refererHosts.length > 0 || item.userAgent !== null, item.service).toBe(true);
    }
  });

  it("хосты — строчные, без схемы, пути и порта", () => {
    for (const host of CHECKER_REFERER_HOSTS) expect(host).toMatch(/^[a-z0-9.-]+$/);
    expect(CHECKER_REFERER_HOSTS).toContain("check-host.net");
  });

  it("образцы сервисов не краулеры превью — иначе запись недостижима", () => {
    for (const [userAgent] of SERVICE_AGENTS) expect(isCrawler(userAgent), userAgent).toBe(false);
  });
});
