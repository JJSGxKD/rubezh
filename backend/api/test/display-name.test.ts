import { describe, expect, it } from "vitest";
import { cleanName, displayNameFor } from "../src/modules/auth/display-name.js";

// Чистка ника (tasks/T-0149): знаки, которыми рисуют на полэкрана, «залго»,
// невидимые и переворачивающие текст символы, длина и мат. Применение при
// входе — отдельная задача, здесь только чистая функция.

const ID = "a1b2c3d4-0000-4000-8000-000000000000";

describe("обычные имена не меняются", () => {
  it.each(["Оленька", "Marina Krasovskaya", "Жамила 🚀", "Александр🥖", "Nguyễn", "हिन्दी", "Игорь_98"])("%s", (name) => {
    expect(cleanName(name)).toEqual({ name, verdict: "ok" });
  });

  it("семья эмодзи: склейка U+200D сохранена", () => {
    const name = "Семья 👨‍👩‍👧";
    expect(cleanName(name)).toEqual({ name, verdict: "ok" });
  });

  it("вьетнамское имя в разложенном виде собирается в обычное", () => {
    expect(cleanName("Nguyễn").name).toBe("Nguyễn");
  });

  it("ровно 24 знака — без обрезки", () => {
    const name = "Абвгде".repeat(4);
    expect(cleanName(name)).toEqual({ name, verdict: "ok" });
  });
});

describe("лишние знаки выбрасываются", () => {
  it("«залго»: не больше трёх надстрочных знаков на букву", () => {
    const marks = "̵̶̴̷̸̢̛̹̺̻";
    const raw = [..."Zalgo"].map((letter) => letter + marks).join("");
    const result = cleanName(raw);
    expect(result.verdict).toBe("symbols");
    expect(result.name?.replace(/\p{Mn}/gu, "")).toBe("Zalgo");
    expect(result.name).not.toMatch(/\p{Mn}{4}/u);
    expect(result.name).toMatch(/\p{Mn}{3}/u);
  });

  it("охватывающие знаки U+0489 — «кружева»: остались одни пробелы, ника нет", () => {
    expect(cleanName("҉ ҉҉ ҉")).toEqual({ name: null, verdict: "empty" });
  });

  it("клинопись целиком — ника нет, а рядом с именем просто выбрасывается", () => {
    expect(cleanName("𒐫𒐫𒐫")).toEqual({ name: null, verdict: "empty" });
    expect(cleanName("Вася 𒐫")).toEqual({ name: "Вася", verdict: "symbols" });
  });

  it("шрифт Брайля — картинки из точек", () => {
    expect(cleanName("⣿⣿⣿ Петя")).toEqual({ name: "Петя", verdict: "symbols" });
  });

  it("рамки и блоки, лигатуры, иероглифы", () => {
    expect(cleanName("▓▒░ Петя ╔═╗").name).toBe("Петя");
    expect(cleanName("Петя ﷽").name).toBe("Петя");
    expect(cleanName("Петя 𓀀").name).toBe("Петя");
  });

  it("переворачивающий текст RLO выброшен", () => {
    const result = cleanName("Вася‮петя");
    expect(result.name).toBe("Васяпетя");
    expect(result.name).not.toContain("‮");
  });

  it("невидимые служебные и управляющие знаки выброшены", () => {
    expect(cleanName("Ва​ся\u0000").name).toBe("Вася");
  });

  it("шрифтовые буквы — обычными: «𝓐𝓵𝓮𝔁» → Alex", () => {
    expect(cleanName("𝓐𝓵𝓮𝔁").name).toBe("Alex");
  });

  it("пробелы схлопываются, края обрезаются, табуляция — пробел", () => {
    expect(cleanName("  Вася \t  Петя  ")).toEqual({ name: "Вася Петя", verdict: "ok" });
  });

  it("нет ни одной буквы или цифры — ника нет", () => {
    expect(cleanName("★☆★")).toEqual({ name: null, verdict: "empty" });
    expect(cleanName("   ")).toEqual({ name: null, verdict: "empty" });
    expect(cleanName("")).toEqual({ name: null, verdict: "empty" });
  });
});

describe("длина", () => {
  it("30 знаков — 23 и «…»", () => {
    const result = cleanName("Абвгде".repeat(5));
    expect(result.verdict).toBe("trimmed");
    expect(result.name).toBe(`${"Абвгде".repeat(3)}Абвго…`.slice(0, 0) + "Абвгде".repeat(5).slice(0, 23) + "…");
    expect([...new Intl.Segmenter("ru", { granularity: "grapheme" }).segment(result.name ?? "")]).toHaveLength(24);
  });

  it("считаются графемы, а не кодовые точки: эмодзи не режется посередине", () => {
    const result = cleanName("А".repeat(22) + "👨‍👩‍👧" + "Б".repeat(5));
    expect(result.name).toBe("А".repeat(22) + "👨‍👩‍👧…");
  });
});

describe("мат", () => {
  it.each(["Huj Vsem", "х.у.й", "П1ZДЕЦ", "pizdets", "FUCKER", "Блядина", "сука", "cyka", "ХУЙ", "х у й", "с.у.к.а", "Ты_сука", "fuuuuck"])("%s — ника нет", (name) => {
    expect(cleanName(name)).toEqual({ name: null, verdict: "profanity" });
  });

  it("мат за пределом 24 знаков тоже ловится", () => {
    expect(cleanName(`${"Абвгде".repeat(4)} хуй`).verdict).toBe("profanity");
  });

  it.each(["Корабля", "Рубль", "Застрахуй", "Сукно", "Scunthorpe", "Оскорблённый", "Хлебушек", "Сукачёв", "Dickens", "Психуй", "Nigel", "Nigeria"])("%s — не мат", (name) => {
    expect(cleanName(name).verdict).not.toBe("profanity");
    expect(cleanName(name).name).not.toBeNull();
  });
});

describe("замена ника", () => {
  it("хороший ник остаётся", () => {
    expect(displayNameFor("Вася", "tolik", ID)).toEqual({ name: "Вася", verdict: "ok" });
  });

  it("пустой ник, чистый username — username без @", () => {
    expect(displayNameFor("҉҉", "tolik", ID)).toEqual({ name: "tolik", verdict: "empty" });
    expect(displayNameFor("҉҉", "@tolik", ID).name).toBe("tolik");
  });

  it("матерный ник, чистый username — username", () => {
    expect(displayNameFor("хуй", "tolik", ID)).toEqual({ name: "tolik", verdict: "profanity" });
  });

  it("username тоже с матом — «Игрок NNNN»", () => {
    const result = displayNameFor("҉", "pizdets", ID);
    expect(result.name).toMatch(/^Игрок \d{4}$/);
    expect(result.verdict).toBe("empty");
  });

  it("username нет — «Игрок NNNN», номер постоянный для аккаунта", () => {
    const first = displayNameFor("҉", null, ID).name;
    expect(first).toMatch(/^Игрок \d{4}$/);
    expect(displayNameFor("҉", null, ID).name).toBe(first);
  });

  it("номер от первых восьми знаков id: нули дают «Игрок 0000»", () => {
    expect(displayNameFor("҉", null, "00000000-0000-4000-8000-000000000000").name).toBe("Игрок 0000");
    expect(displayNameFor("҉", null, "0000000a-0000-4000-8000-000000000000").name).toBe("Игрок 0010");
  });

  it("username длиннее 24 знаков не обрезается", () => {
    const username = "a".repeat(30);
    expect(displayNameFor("҉", username, ID).name).toBe(username);
  });

  it("id не из шестнадцатеричных цифр не ломает номер", () => {
    expect(displayNameFor("҉", null, "zzzz").name).toMatch(/^Игрок \d{4}$/);
  });
});
