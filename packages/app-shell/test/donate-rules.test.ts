import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "../src/i18n/donate";
import { t } from "../src/i18n";
import type { DonationView } from "../src/state/donations-api";
import { defaultAmount, hasAnyWay, parseAmount, visibleWays } from "../src/screens/meta/donate-rules";
import { DonateCard } from "../src/screens/meta/donate-block";
import { DonateSheetView, type DonateSheetViewProps } from "../src/screens/meta/donate-sheet";
import { SupporterBadge } from "../src/screens/meta/supporter-badge";
import { TesterBadge } from "../src/screens/meta/tester-badge";
import { LeaderboardRow } from "../src/screens/meta/rating";

// Донаты проекту на клиенте (docs/35-stage4-plan.md, Р109; tasks/T-0158): чистые
// правила суммы и способов, блок на «Об игре» и в профиле, лист доната и знак
// «Меценат» — без браузера, разметкой.

const STARS = { min: 1, max: 10_000, presets: [50, 250, 1000], mode: "live" as const };
const TRIBUTE = { url: "https://t.me/tribute/app?startapp=donate", way: "tribute_telegram" };

function view(patch: Partial<DonationView> = {}): DonationView {
  return { stars: STARS, tribute: TRIBUTE, supporter: false, ...patch };
}

describe("сумма доната", () => {
  it("целое число цифрами в пределах сервера — проходит, границы включены", () => {
    expect(parseAmount("100", 1, 10_000)).toEqual({ ok: true, amount: 100 });
    expect(parseAmount("1", 1, 10_000)).toEqual({ ok: true, amount: 1 });
    expect(parseAmount("10000", 1, 10_000)).toEqual({ ok: true, amount: 10_000 });
  });

  it("вне пределов, дробное, с пробелом, со знаком, не число и пустое — нет", () => {
    for (const text of ["0", "10001", "1.5", "1,5", " 5", "5 ", "-3", "+3", "abc", "", "1e3", "٣"]) {
      expect(parseAmount(text, 1, 10_000), JSON.stringify(text)).toEqual({ ok: false });
    }
  });

  it("предел задаёт сервер: нижняя граница выше единицы работает так же", () => {
    expect(parseAmount("9", 10, 500)).toEqual({ ok: false });
    expect(parseAmount("10", 10, 500)).toEqual({ ok: true, amount: 10 });
    expect(parseAmount("501", 10, 500)).toEqual({ ok: false });
  });

  it("ведущие нули и огромные записи числом не считаются", () => {
    expect(parseAmount("0100", 1, 10_000)).toEqual({ ok: false });
    expect(parseAmount("99999999999999999999", 1, 10_000)).toEqual({ ok: false });
  });

  it("первой выбрана вторая готовая сумма, если она есть, иначе первая; готовых нет — ничего", () => {
    expect(defaultAmount([50, 250, 1000])).toBe(250);
    expect(defaultAmount([100])).toBe(100);
    expect(defaultAmount([])).toBeNull();
  });
});

describe("способы поддержать", () => {
  it("звёзды выключены и ссылки нет — способов нет", () => {
    const nothing = view({ stars: null, tribute: null });
    expect(visibleWays(nothing)).toEqual({ stars: false, tribute: null });
    expect(hasAnyWay(nothing)).toBe(false);
    expect(visibleWays(view({ stars: null, tribute: undefined }))).toEqual({ stars: false, tribute: null });
  });

  it("ссылка не https отбрасывается: http, чужая схема, мусор и пустая строка", () => {
    for (const url of ["http://t.me/x", "javascript:alert(1)", "tg://resolve?domain=x", "not a url", ""]) {
      expect(visibleWays(view({ stars: null, tribute: { url, way: "tribute_web" } })).tribute, url).toBeNull();
    }
    expect(hasAnyWay(view({ stars: null, tribute: { url: "http://t.me/x", way: "tribute_web" } }))).toBe(false);
  });

  it("только Tribute — способ есть, кнопок звёзд нет; только звёзды — способ есть", () => {
    const onlyTribute = view({ stars: null });
    expect(visibleWays(onlyTribute)).toEqual({ stars: false, tribute: TRIBUTE });
    expect(hasAnyWay(onlyTribute)).toBe(true);
    const onlyStars = view({ tribute: null });
    expect(visibleWays(onlyStars)).toEqual({ stars: true, tribute: null });
    expect(hasAnyWay(onlyStars)).toBe(true);
  });
});

function card(donation: DonationView, place: "about" | "profile" = "about"): string {
  return renderToStaticMarkup(createElement(DonateCard, { view: donation, place, onSheet: () => undefined, onTribute: () => undefined }));
}

describe("блок «Поддержать проект»", () => {
  it("есть оба способа — текст «не покупка», «Поддержать» и «Поддержать через Tribute»", () => {
    const markup = card(view());
    expect(markup).toContain("Поддержать проект");
    expect(markup).toContain("Донат — не покупка");
    expect(markup).toContain(">Поддержать<");
    expect(markup).toContain("Поддержать через Tribute");
    expect(markup).not.toContain("знак уже у тебя");
  });

  it("оплата звёздами выключена — остаётся только Tribute, кнопки «Поддержать» нет", () => {
    const markup = card(view({ stars: null }));
    expect(markup).toContain("Поддержать через Tribute");
    expect(markup).not.toContain(">Поддержать<");
  });

  it("нет Tribute — только звёзды, мёртвой кнопки нет", () => {
    const markup = card(view({ tribute: null }));
    expect(markup).toContain(">Поддержать<");
    expect(markup).not.toContain("Tribute");
  });

  it("поддержавшему — тот же заголовок, знак, строка «знак уже у тебя» и «Поддержать ещё»", () => {
    const markup = card(view({ supporter: true }));
    expect(markup).toContain("Поддержать проект");
    expect(markup).toContain("Меценат");
    expect(markup).toContain("Спасибо за поддержку — знак уже у тебя");
    expect(markup).toContain("Поддержать ещё");
    expect(markup).not.toContain(">Поддержать<");
  });

  it("в профиле у поддержавшего абзаца с объяснением нет, у остальных он есть", () => {
    expect(card(view({ supporter: true }), "profile")).not.toContain("Донат — не покупка");
    expect(card(view({ supporter: false }), "profile")).toContain("Донат — не покупка");
    expect(card(view({ supporter: true }), "about")).not.toContain("Донат — не покупка");
  });

  it("игроку без знака блок не говорит, что знак уже есть, — и при одной ссылке Tribute", () => {
    expect(card(view({ stars: null, supporter: false }))).not.toContain("знак уже у тебя");
  });
});

function sheet(patch: Partial<DonateSheetViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(DonateSheetView, {
      stars: STARS,
      selected: 250,
      customText: "",
      paying: false,
      notice: null,
      thanks: false,
      onSelect: () => undefined,
      onCustomText: () => undefined,
      onPay: () => undefined,
      onClose: () => undefined,
      ...patch,
    }),
  );
}

describe("лист доната", () => {
  it("готовые суммы плитками, «Своя» последней, кнопка называет выбранную сумму", () => {
    const markup = sheet();
    expect(markup.indexOf(">50<")).toBeLessThan(markup.indexOf(">250<"));
    expect(markup.indexOf(">1000<")).toBeLessThan(markup.indexOf(">Своя<"));
    expect(markup).toContain("Любая сумма в звёздах: от 1 до 10");
    expect(markup).toContain("Поддержать на 250 ⭐");
  });

  it("своя сумма: поле с подписью и ограничением длины по числу знаков предела", () => {
    const markup = sheet({ selected: "custom", customText: "" });
    expect(markup).toContain('inputMode="numeric"');
    expect(markup).toContain('maxLength="5"');
    expect(markup).toContain("Своя сумма");
  });

  it("своя сумма вне пределов — причина строкой под полем, кнопка неактивна и без числа", () => {
    const markup = sheet({ selected: "custom", customText: "20000" });
    expect(markup).toContain("Сумма — целое число от 1 до 10");
    expect(markup).not.toContain("Поддержать на");
    expect(markup).toContain('data-pay="" disabled=""');
  });

  it("своя сумма в пределах — кнопка называет её и активна", () => {
    const markup = sheet({ selected: "custom", customText: "777" });
    expect(markup).toContain("Поддержать на 777 ⭐");
    expect(markup).not.toContain('data-pay="" disabled=""');
  });

  it("пока ждём оплату — «Ждём оплату…», суммы не нажимаются: второго счёта не будет", () => {
    const markup = sheet({ paying: true });
    expect(markup).toContain("Ждём оплату…");
    const tiles = markup.match(/<button[^>]*data-amount[^>]*>/g) ?? [];
    expect(tiles.length).toBe(4);
    for (const tile of tiles) expect(tile).toContain('disabled=""');
  });

  it("тестовая оплата — подпись про возврат звезды; настоящая — без неё", () => {
    expect(sheet({ stars: { ...STARS, mode: "test" } })).toContain("Тестовая оплата: звезда вернётся");
    expect(sheet()).not.toContain("Тестовая оплата");
  });

  it("долгое подтверждение — плашка информации; ошибка оплаты — плашка опасности", () => {
    const slow = sheet({ notice: { tone: "info", text: t("donate.retry.slow_confirmation") } });
    expect(slow).toContain("Оплата ещё подтверждается");
    expect(slow).not.toContain('role="alert"');
    const failed = sheet({ notice: { tone: "error", text: t("donate.retry.payment_failed") } });
    expect(failed).toContain("Оплата не прошла");
    expect(failed).toContain('role="alert"');
  });

  it("«Спасибо!» — вместо выбора суммы: благодарность, знак и закрытие", () => {
    const markup = sheet({ thanks: true });
    expect(markup).toContain("Спасибо!");
    expect(markup).toContain("Поддержка «Рубежа» дошла");
    expect(markup).toContain("Меценат");
    expect(markup).toContain("Знак уже в профиле и в рейтинге");
    expect(markup).toContain("Закрыть");
    expect(markup).not.toContain("Своя сумма");
  });
});

describe("знак «Меценат»", () => {
  it("со словом; в строке рейтинга — одно сердце с подписью для диктора и подсказкой", () => {
    const full = renderToStaticMarkup(createElement(SupporterBadge, { size: "l" }));
    expect(full).toContain("Меценат");
    const icon = renderToStaticMarkup(createElement(SupporterBadge, { iconOnly: true }));
    expect(icon).toContain('aria-label="Меценат"');
    expect(icon).toContain('title="Меценат"');
    expect(icon).not.toContain(">Меценат<");
  });

  it("слово знака — цветом текста, значок — тоном здоровья: розовое слово не проходит контраст", () => {
    const markup = renderToStaticMarkup(createElement(SupporterBadge, {}));
    expect(markup).toContain("text-text");
    expect(markup).toContain("text-hp");
  });
});

const ENTRY = {
  rank: 3,
  name: "Дым",
  photoUrl: null,
  survivalSec: 400,
  level: 9,
  startingWeaponId: "spark",
  enemiesKilled: 120,
  isMe: false,
};

function row(patch: Partial<Parameters<typeof LeaderboardRow>[0]["entry"]>): string {
  return renderToStaticMarkup(createElement(LeaderboardRow, { entry: { ...ENTRY, ...patch }, index: 2 }));
}

describe("знак в строке рейтинга", () => {
  it("у поддержавшего есть сердце, у остальных нет", () => {
    expect(row({ supporter: true })).toContain('aria-label="Меценат"');
    expect(row({})).not.toContain("Меценат");
  });

  it("«Тестер» и «Меценат» вместе: оба знака, имя и метка «Ты» на месте", () => {
    const markup = row({ supporter: true, tester: true, isMe: true });
    expect(markup).toContain(renderToStaticMarkup(createElement(TesterBadge, {})));
    expect(markup).toContain('aria-label="Меценат"');
    expect(markup).toContain("Дым");
    expect(markup).toContain(">Ты<");
  });
});
