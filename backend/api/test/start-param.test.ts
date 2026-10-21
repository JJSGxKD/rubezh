import { describe, expect, it } from "vitest";
import { START_KINDS, parseStartParam } from "../src/modules/attribution/start-param.js";
import { newLinkCode } from "../src/modules/links/link-code.js";

// Параметр запуска (docs/34-stage3-plan.md, WP6): откуда пришёл игрок.
// Проверяется то, на чём разбор ломался в источнике переноса: мусор, чужой
// формат и склейка нескольких значений в одну строку.

describe("разбор параметра запуска", () => {
  it("нет параметра — органический запуск", () => {
    for (const value of [null, undefined, ""]) expect(parseStartParam(value)).toEqual({ kind: "organic", raw: null, ref: null });
  });

  it("узнаёт ссылку через редирект, приглашение друга и партнёрку Telegram", () => {
    expect(parseStartParam("c-Ab12Cd34")).toEqual({ kind: "click", raw: "c-Ab12Cd34", ref: "Ab12Cd34" });
    expect(parseStartParam("invite")).toEqual({ kind: "invite", raw: "invite", ref: null });
    expect(parseStartParam("_tgr_x9Y-z")).toEqual({ kind: "telegram_affiliate", raw: "_tgr_x9Y-z", ref: "x9Y-z" });
  });

  it("узнаёт прямую ссылку кампании l-<код>: вид «link», код — в ref", () => {
    expect(parseStartParam("l-AbC123")).toEqual({ kind: "link", raw: "l-AbC123", ref: "AbC123" });
    // Крайние длины кода ссылки: от шести до шестнадцати знаков.
    expect(parseStartParam("l-Ab12Cd")).toMatchObject({ kind: "link", ref: "Ab12Cd" });
    expect(parseStartParam("l-Ab12Cd34Ef56Gh78")).toMatchObject({ kind: "link", ref: "Ab12Cd34Ef56Gh78" });
  });

  it("код прямой ссылки проверяется правилом кода ссылки, второго правила нет", () => {
    // Выданный ссылке код всегда разбирается: правило и генератор не расходятся.
    const code = newLinkCode();
    expect(parseStartParam(`l-${code}`)).toEqual({ kind: "link", raw: `l-${code}`, ref: code });
    // Пустой, короткий, длинный или с дефисом внутри — не прямая ссылка, но сырая строка остаётся.
    for (const value of ["l-", "l-abc", "l-Ab12Cd34Ef56Gh78X", "l-abc-defgh"]) expect(parseStartParam(value), value).toEqual({ kind: "unknown", raw: value, ref: null });
    // Кириллицу Telegram в параметре не пропускает: даже сырой она не хранится.
    expect(parseStartParam("l-а1")).toEqual({ kind: "unknown", raw: null, ref: null });
  });

  it("клик c-<код> разбирается как раньше и с прямой ссылкой не путается", () => {
    expect(parseStartParam("c-Ab12Cd34")).toEqual({ kind: "click", raw: "c-Ab12Cd34", ref: "Ab12Cd34" });
    expect(parseStartParam("c-")).toMatchObject({ kind: "unknown", raw: "c-" });
    // Прямая ссылка — только строчная «l»: заглавная «L» — чужой формат.
    expect(parseStartParam("L-AbC123")).toMatchObject({ kind: "unknown" });
  });

  it("узнаёт ссылку дружбы по коду, а не по похожему началу", () => {
    expect(parseStartParam("f-Qw3rTy12Zx")).toEqual({ kind: "friend", raw: "f-Qw3rTy12Zx", ref: "Qw3rTy12Zx" });
    // Код короче восьми знаков или с дефисом внутри — не ссылка дружбы.
    expect(parseStartParam("f-abc")).toMatchObject({ kind: "unknown", raw: "f-abc" });
    expect(parseStartParam("f-abc-defgh")).toMatchObject({ kind: "unknown", raw: "f-abc-defgh" });
  });

  it("узнаёт кнопку уведомления в боте: вид — в ref", () => {
    expect(parseStartParam("n-friend_request")).toEqual({ kind: "notification", raw: "n-friend_request", ref: "friend_request" });
    // Заглавные и цифры в виде не бывают — это чужой формат.
    expect(parseStartParam("n-Friend1")).toMatchObject({ kind: "unknown", raw: "n-Friend1" });
  });

  it("чужой формат не теряется: сырая строка остаётся для разбора потом", () => {
    expect(parseStartParam("r-123_source-channel")).toEqual({ kind: "unknown", raw: "r-123_source-channel", ref: null });
    // Похоже на клик, но код не той длины — не клик.
    expect(parseStartParam("c-abc")).toMatchObject({ kind: "unknown", raw: "c-abc" });
  });

  it("старые форматы после появления пар разбираются как раньше (Р116)", () => {
    expect(parseStartParam("c-AbCdEf123456")).toEqual({ kind: "click", raw: "c-AbCdEf123456", ref: "AbCdEf123456" });
    expect(parseStartParam("l-AbCdEf1234")).toEqual({ kind: "link", raw: "l-AbCdEf1234", ref: "AbCdEf1234" });
    expect(parseStartParam("f-AbCdEf1234")).toEqual({ kind: "friend", raw: "f-AbCdEf1234", ref: "AbCdEf1234" });
    expect(parseStartParam("n-friend_request")).toEqual({ kind: "notification", raw: "n-friend_request", ref: "friend_request" });
    expect(parseStartParam("invite")).toEqual({ kind: "invite", raw: "invite", ref: null });
    expect(parseStartParam("_tgr_123")).toEqual({ kind: "telegram_affiliate", raw: "_tgr_123", ref: "123" });
    // Вход в панель и подтверждение роли разбирает бот раньше атрибуции; здесь они не пары.
    for (const value of ["panel-AbCdEfGhIjKlMnOpQrStUv", "role-AbCdEfGhIjKlMnOpQrStUv"]) expect(parseStartParam(value), value).toEqual({ kind: "unknown", raw: value, ref: null });
  });

  it("список видов запуска включает «tagged» — ссылку с метками", () => {
    expect(START_KINDS).toContain("tagged");
    expect(parseStartParam("src-tgads_cmp-oct")).toMatchObject({ kind: "tagged", ref: "src-tgads_cmp-oct" });
  });

  it("то, чего Telegram не пропускает, не хранится даже сырым", () => {
    expect(parseStartParam("c-<script>")).toEqual({ kind: "unknown", raw: null, ref: null });
    expect(parseStartParam("x".repeat(65))).toEqual({ kind: "unknown", raw: null, ref: null });
  });
});
