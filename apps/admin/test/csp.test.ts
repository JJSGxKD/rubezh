import { describe, expect, it } from "vitest";
import { adminContentSecurityPolicy } from "../src/csp";

function directive(policy: string, name: string): string[] {
  const found = policy.split("; ").find((part) => part.startsWith(`${name} `));
  return found === undefined ? [] : found.split(" ").slice(1);
}

describe("политика источников панели", () => {
  const build = adminContentSecurityPolicy("build");
  const dev = adminContentSecurityPolicy("dev");

  it("не даёт встроить панель во фрейм никому — кнопки блокировки не подсунуть под чужую страницу", () => {
    expect(directive(build, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(dev, "frame-ancestors")).toEqual(["'none'"]);
  });

  it("в сборке скрипты и соединения — только свои", () => {
    expect(directive(build, "script-src")).toEqual(["'self'"]);
    expect(directive(build, "connect-src")).toEqual(["'self'"]);
    expect(directive(build, "worker-src")).toEqual(["'self'"]);
    expect(build).toContain("upgrade-insecure-requests");
  });

  it("dev-сервер мягче ровно на горячую перезагрузку", () => {
    expect(directive(dev, "script-src")).toContain("'unsafe-inline'");
    expect(directive(dev, "connect-src")).toEqual(["'self'", "ws:", "wss:"]);
    expect(dev).not.toContain("upgrade-insecure-requests");
  });

  it("пускает аватары игроков из Telegram и ничего стороннего сверх них", () => {
    expect(directive(build, "img-src")).toEqual(["'self'", "data:", "https://t.me"]);
    expect(directive(build, "object-src")).toEqual(["'none'"]);
  });
});
