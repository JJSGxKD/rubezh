import { describe, expect, it } from "vitest";
import { parseStartParam } from "../src/modules/attribution/start-param.js";

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

  it("узнаёт ссылку дружбы по коду, а не по похожему началу", () => {
    expect(parseStartParam("f-Qw3rTy12Zx")).toEqual({ kind: "friend", raw: "f-Qw3rTy12Zx", ref: "Qw3rTy12Zx" });
    // Код короче восьми знаков или с дефисом внутри — не ссылка дружбы.
    expect(parseStartParam("f-abc")).toMatchObject({ kind: "unknown", raw: "f-abc" });
    expect(parseStartParam("f-abc-defgh")).toMatchObject({ kind: "unknown", raw: "f-abc-defgh" });
  });

  it("чужой формат не теряется: сырая строка остаётся для разбора потом", () => {
    expect(parseStartParam("r-123_source-channel")).toEqual({ kind: "unknown", raw: "r-123_source-channel", ref: null });
    // Похоже на клик, но код не той длины — не клик.
    expect(parseStartParam("c-abc")).toMatchObject({ kind: "unknown", raw: "c-abc" });
  });

  it("то, чего Telegram не пропускает, не хранится даже сырым", () => {
    expect(parseStartParam("c-<script>")).toEqual({ kind: "unknown", raw: null, ref: null });
    expect(parseStartParam("x".repeat(65))).toEqual({ kind: "unknown", raw: null, ref: null });
  });
});
