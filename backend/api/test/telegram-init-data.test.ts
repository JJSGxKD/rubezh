import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyInitData } from "../src/platforms/telegram/telegram-init-data.js";

// Проверка подписи данных запуска Telegram — на ней стоит вход в аккаунт
// (docs/34-stage3-plan.md, WP1; docs/33-telegram-mini-app-pitfalls.md §1).

const BOT_TOKEN = "123456:TEST-token-for-signatures";
const NOW = Date.parse("2026-09-14T12:00:00Z");

/** Подписать данные запуска так же, как это делает Telegram. */
function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

function launch(overrides: Record<string, string> = {}): string {
  return signInitData({
    auth_date: String(Math.floor(NOW / 1000) - 60),
    query_id: "AAE",
    user: JSON.stringify({ id: 777000111, first_name: "Анна", last_name: "К", username: "anna" }),
    ...overrides,
  });
}

describe("проверка initData", () => {
  it("принимает подписанные данные и достаёт игрока", () => {
    const check = verifyInitData(launch(), BOT_TOKEN, 86_400, NOW);
    expect(check).toMatchObject({ ok: true, player: { id: "777000111", name: "Анна К", username: "anna" } });
  });

  it("отвергает подменённое поле: подпись считается по всем полям", () => {
    const tampered = launch().replace("777000111", "777000112");
    expect(verifyInitData(tampered, BOT_TOKEN, 86_400, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отвергает подпись чужим токеном бота", () => {
    const foreign = signInitData({ auth_date: String(Math.floor(NOW / 1000)), user: "{}" }, "999:other");
    expect(verifyInitData(foreign, BOT_TOKEN, 86_400, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("отвергает устаревшие данные: подпись вечна, окно — нет", () => {
    const old = launch({ auth_date: String(Math.floor(NOW / 1000) - 90_000) });
    expect(verifyInitData(old, BOT_TOKEN, 86_400, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("пускает дату из будущего только в пределах расхождения часов", () => {
    const nowSec = Math.floor(NOW / 1000);
    // Часы телефона спешат на пару минут — это не подделка.
    const ahead = launch({ auth_date: String(nowSec + 120) });
    expect(verifyInitData(ahead, BOT_TOKEN, 3_600, NOW)).toMatchObject({ ok: true });
    // Дата на час вперёд продлила бы окно свежести на тот же час.
    const future = launch({ auth_date: String(nowSec + 3_600) });
    expect(verifyInitData(future, BOT_TOKEN, 3_600, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("отвергает данные без подписи и без пользователя", () => {
    expect(verifyInitData("auth_date=1&user=%7B%7D", BOT_TOKEN, 86_400, NOW)).toEqual({
      ok: false,
      reason: "missing_hash",
    });
    const noUser = signInitData({ auth_date: String(Math.floor(NOW / 1000)) });
    expect(verifyInitData(noUser, BOT_TOKEN, 86_400, NOW)).toEqual({ ok: false, reason: "no_user" });
  });
});

describe("параметр запуска в initData", () => {
  it("берётся из подписанных данных", () => {
    expect(verifyInitData(launch({ start_param: "c-Ab12Cd34" }), BOT_TOKEN, 86_400, NOW)).toMatchObject({ ok: true, startParam: "c-Ab12Cd34" });
    expect(verifyInitData(launch(), BOT_TOKEN, 86_400, NOW)).toMatchObject({ ok: true, startParam: null });
  });

  it("подменённый параметр ломает подпись: приписать себе чужую ссылку нельзя", () => {
    const tampered = launch({ start_param: "invite" }).replace("start_param=invite", "start_param=c-Stolen123");
    expect(verifyInitData(tampered, BOT_TOKEN, 86_400, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

