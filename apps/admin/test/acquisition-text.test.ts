import { describe, expect, it } from "vitest";
import { affiliateMarkText, TOUCH_TITLES, touchText } from "../src/screens/players/acquisition-text";

/**
 * Откуда пришёл игрок — слова карточки (T-0072): вид касания называется так же, как в списках и
 * воронке, а строка метки партнёрки Telegram читается без сырых кодов.
 */

describe("вид касания словами", () => {
  it("нет касания — прочерк", () => {
    expect(touchText(null, null)).toBe("—");
    expect(touchText(null, "x9Y-z")).toBe("—");
  });

  it("известный вид — название, с кодом через «: »", () => {
    expect(touchText("organic", null)).toBe("Органика");
    expect(touchText("click", "Ab12Cd34")).toBe("Ссылка кампании: Ab12Cd34");
    expect(touchText("telegram_affiliate", "x9Y-z")).toBe("Партнёрка Telegram: x9Y-z");
    expect(touchText("telegram_affiliate", null)).toBe("Партнёрка Telegram");
    expect(touchText("notification", "friend_request")).toBe("Кнопка уведомления в боте: friend_request");
  });

  it("незнакомый вид — как есть: новый вид сервера не прячется и не роняет карточку", () => {
    expect(touchText("new_kind", "q")).toBe("new_kind: q");
    expect(touchText("new_kind", null)).toBe("new_kind");
  });

  it("у каждого вида первого касания, который отдаёт сервер, есть название", () => {
    for (const kind of ["organic", "click", "invite", "friend", "telegram_affiliate", "notification", "link", "tagged", "unknown"]) {
      expect(TOUCH_TITLES[kind], kind).toBeDefined();
    }
  });
});

describe("строка метки партнёрки Telegram", () => {
  it("код и дата, дату форматирует вызывающий", () => {
    expect(affiliateMarkText("x9Y-z", "13.10.2026, 14:05")).toBe("код x9Y-z, с 13.10.2026, 14:05");
  });
});
