import { describe, expect, it } from "vitest";
import {
  POSTBACK_MACROS,
  fillTemplate,
  logTemplateOf,
  logUrlOf,
  templateProblems,
  usesMacro,
  type PostbackMacro,
} from "../src/modules/ad-conversions/destinations/postback-template.js";

/**
 * Шаблон адреса постбэка (tasks/T-0070, docs/35-stage4-plan.md Р86, Р96): проверка при сохранении и
 * подстановка при отправке. Тексты проблем — дословно из спецификации: их видит человек в панели.
 */

const VALID = "https://track.example.com/postback?click_id={click_id}&event={event}&event_id={event_id}&amount={amount}&currency={currency}&sub1={sub1}";

const EMPTY_VALUES: Record<PostbackMacro, string> = {
  click_id: "",
  sub1: "",
  sub2: "",
  sub3: "",
  sub4: "",
  sub5: "",
  event: "",
  event_id: "",
  amount: "",
  currency: "",
};

function values(patch: Partial<Record<PostbackMacro, string>>): Record<PostbackMacro, string> {
  return { ...EMPTY_VALUES, ...patch };
}

describe("макросы", () => {
  it("десять макросов: click_id, sub1…sub5, event, event_id, amount, currency", () => {
    expect([...POSTBACK_MACROS]).toEqual(["click_id", "sub1", "sub2", "sub3", "sub4", "sub5", "event", "event_id", "amount", "currency"]);
  });

  it("usesMacro: ищет макрос в шаблоне, чужие имена и половинки скобок не считает", () => {
    expect(usesMacro(VALID, "click_id")).toBe(true);
    expect(usesMacro(VALID, "sub2")).toBe(false);
    expect(usesMacro("https://h.example/p?a=click_id", "click_id")).toBe(false);
    expect(usesMacro("https://h.example/p?a={click_id", "click_id")).toBe(false);
  });
});

describe("templateProblems", () => {
  it("валидный пример и адрес без макросов годятся", () => {
    expect(templateProblems(VALID)).toEqual([]);
    expect(templateProblems("https://track.example.com/postback")).toEqual([]);
    expect(templateProblems("https://track.example.com/{sub1}/pb?x={sub2}#{sub3}")).toEqual([]);
  });

  it("пустой адрес — «Адрес пустой»; из одних пробелов — тоже", () => {
    expect(templateProblems("")).toEqual(["Адрес пустой"]);
    expect(templateProblems("   ")).toEqual(["Адрес пустой"]);
  });

  it("1025 знаков — «Адрес длиннее 1024 знаков», 1024 — годится", () => {
    const base = "https://track.example.com/pb?x=";
    expect(templateProblems(base + "a".repeat(1025 - base.length))).toEqual(["Адрес длиннее 1024 знаков"]);
    expect(templateProblems(base + "a".repeat(1024 - base.length))).toEqual([]);
  });

  it("не https — «Адрес должен начинаться с https://»", () => {
    expect(templateProblems("http://track.example.com/pb")).toEqual(["Адрес должен начинаться с https://"]);
    expect(templateProblems("track.example.com/pb")).toEqual(["Адрес должен начинаться с https://"]);
    expect(templateProblems("ftp://track.example.com/pb")).toEqual(["Адрес должен начинаться с https://"]);
    // `https:host` URL-разбор принял бы за https://host/ — нам нужны две косые черты.
    expect(templateProblems("https:track.example.com/pb")).toEqual(["Адрес должен начинаться с https://"]);
  });

  it("логин и пароль — «В адресе нельзя указывать логин и пароль»", () => {
    expect(templateProblems("https://u:p@h.example/p")).toEqual(["В адресе нельзя указывать логин и пароль"]);
    expect(templateProblems("https://token@h.example/p")).toEqual(["В адресе нельзя указывать логин и пароль"]);
    // Обратная косая черта браузерный разбор считает слэшем, но строка с «@» до неё — всё равно отказ.
    expect(templateProblems("https://evil.example\\@good.example/p")).toEqual(["В адресе нельзя указывать логин и пароль"]);
  });

  it("порт — «Порт в адресе не поддерживается», в том числе стандартный", () => {
    expect(templateProblems("https://h.example:8443/p")).toEqual(["Порт в адресе не поддерживается"]);
    expect(templateProblems("https://h.example:443/p")).toEqual(["Порт в адресе не поддерживается"]);
    expect(templateProblems("https://h.example:/p")).toEqual(["Порт в адресе не поддерживается"]);
  });

  it("макрос в имени сайта — «Макросы нельзя ставить в имя сайта»", () => {
    expect(templateProblems("https://{sub1}.example.com/p")).toEqual(["Макросы нельзя ставить в имя сайта"]);
    expect(templateProblems("https://example.com{sub1}/p")).toEqual(["Макросы нельзя ставить в имя сайта"]);
    expect(templateProblems("https://{click_id}")).toEqual(["Макросы нельзя ставить в имя сайта"]);
  });

  it("неизвестный макрос называется по имени и перечисляет известные", () => {
    expect(templateProblems("https://h.example/p?x={nope}")).toEqual([
      "Макрос {nope} неизвестен. Доступны: {click_id}, {sub1}…{sub5}, {event}, {event_id}, {amount}, {currency}",
    ]);
    // Регистр важен, пустые скобки — тоже неизвестный макрос; один и тот же — один раз.
    expect(templateProblems("https://h.example/p?x={Click_ID}")).toEqual([
      "Макрос {Click_ID} неизвестен. Доступны: {click_id}, {sub1}…{sub5}, {event}, {event_id}, {amount}, {currency}",
    ]);
    expect(templateProblems("https://h.example/p?x={}")).toHaveLength(1);
    expect(templateProblems("https://h.example/p?x={nope}&y={nope}")).toHaveLength(1);
  });

  it("половинка скобки и пробелы с управляющими знаками — «Адрес не разбирается»", () => {
    expect(templateProblems("https://h.example/p?x={click_id")).toEqual(["Адрес не разбирается"]);
    expect(templateProblems("https://h.example/p?x=click_id}")).toEqual(["Адрес не разбирается"]);
    expect(templateProblems("https://h.example/p?x=a b")).toEqual(["Адрес не разбирается"]);
    expect(templateProblems("https://h.example/p?x=a\nb")).toEqual(["Адрес не разбирается"]);
    expect(templateProblems("https://")).toEqual(["Адрес не разбирается"]);
  });

  it("внутренние адреса — «Адрес указывает на внутреннюю сеть» (подробные случаи — postback-address.test.ts)", () => {
    expect(templateProblems("https://localhost/p")).toEqual(["Адрес указывает на внутреннюю сеть"]);
    expect(templateProblems("https://127.0.0.1/p")).toEqual(["Адрес указывает на внутреннюю сеть"]);
    expect(templateProblems("https://track.example.com/p")).toEqual([]);
  });
});

describe("fillTemplate", () => {
  it("значения кодируются одним проходом: &, = и # не ломают запрос", () => {
    const url = fillTemplate("https://track.example.com/pb?cid={click_id}&s={sub1}", values({ click_id: "a&b=c#d", sub1: "x" }));
    expect(url.toString()).toBe("https://track.example.com/pb?cid=a%26b%3Dc%23d&s=x");
    expect(url.searchParams.get("cid")).toBe("a&b=c#d");
  });

  it("макрос без значения даёт пустое место; нескольких разом и повторные подставляются все", () => {
    const url = fillTemplate("https://h.example/pb?a={sub3}&b={sub1}&c={sub1}", values({ sub1: "v" }));
    expect(url.toString()).toBe("https://h.example/pb?a=&b=v&c=v");
  });

  it("значение, похожее на макрос, остаётся закодированным и повторно не раскрывается", () => {
    const url = fillTemplate("https://h.example/pb?a={sub1}&b={sub2}", values({ sub1: "{sub2}", sub2: "z" }));
    expect(url.toString()).toBe("https://h.example/pb?a=%7Bsub2%7D&b=z");
    expect(url.searchParams.get("a")).toBe("{sub2}");
  });

  it("кодирование — encodeURIComponent: кириллица и пробел", () => {
    const url = fillTemplate("https://h.example/pb?a={sub1}", values({ sub1: "привет мир" }));
    expect(url.search).toBe(`?a=${encodeURIComponent("привет мир")}`);
  });

  it("макрос в пути подставляется закодированным", () => {
    expect(fillTemplate("https://h.example/{sub1}/pb", values({ sub1: "a/b" })).pathname).toBe("/a%2Fb/pb");
  });

  it("неразбираемая подстановка — исключение: решает вызывающий", () => {
    expect(() => fillTemplate("не адрес", EMPTY_VALUES)).toThrow();
  });
});

describe("адрес без запроса в логе", () => {
  it("logUrlOf: запрос заменён на «?***», без запроса — как есть", () => {
    expect(logUrlOf(new URL("https://track.example.com/postback?token=secret&cid=1"))).toBe("https://track.example.com/postback?***");
    expect(logUrlOf(new URL("https://track.example.com/postback"))).toBe("https://track.example.com/postback");
    expect(logUrlOf(new URL("https://track.example.com/postback?"))).toBe("https://track.example.com/postback");
    expect(logUrlOf(new URL("https://track.example.com/postback?a=1#frag"))).toBe("https://track.example.com/postback?***");
  });

  it("logTemplateOf: то же для хранимого шаблона, макросы пути остаются как написаны", () => {
    expect(logTemplateOf(VALID)).toBe("https://track.example.com/postback?***");
    expect(logTemplateOf("https://track.example.com/{sub1}/pb?token=secret")).toBe("https://track.example.com/{sub1}/pb?***");
    expect(logTemplateOf("https://track.example.com/pb")).toBe("https://track.example.com/pb");
    expect(logTemplateOf("https://track.example.com/pb#token")).toBe("https://track.example.com/pb");
  });
});
