import type { DueConversion } from "../conversions.repository.js";
import { POSTBACK_EVENTS, type PostbackEvent } from "../postback-events.js";
import type { PostbackDestination, Prepared } from "./destination.js";
import { checkHost } from "./public-address.js";
import { POSTBACK_FILLED_MAX, fillTemplate, logUrlOf, templateProblems, usesMacro, type PostbackMacro } from "./postback-template.js";

/**
 * Назначения на общем шаблоне адреса (tasks/T-0070, docs/35-stage4-plan.md Р86, Р96): `s2s` — у ссылки без
 * владельца-партнёра свой адрес (закупка команды в сети с постбэками), `partner` — у ссылки партнёра: адрес
 * ссылки, а если его нет, общий адрес партнёра. Какой адрес действует, решает запрос очереди
 * (`conversions.repository.ts`), назначению он приходит в `postbackUrl`; здесь — подстановка и проверка.
 *
 * Адрес вводят люди, поэтому проверка двойная: при сохранении (`templateProblems`) и здесь, при каждой
 * отправке, — правила могли ужесточиться, а имя сайта могло начать указывать во внутреннюю сеть. Запрос идёт
 * без перенаправлений: чужой сервер не вправе отправить нас на другой адрес.
 */

/** Откуда приёмник узнаёт, чей это запрос. */
const USER_AGENT = "rubezh-postback/1";

const CHECK_PREFIX = "Адрес не прошёл проверку: ";

export class TemplateDestination implements PostbackDestination {
  readonly accepts: readonly PostbackEvent[] = POSTBACK_EVENTS;

  /** `lookup` — подмена поиска имени для тестов; в работе поиск системный. */
  constructor(
    readonly kind: "s2s" | "partner",
    private readonly lookup?: (host: string) => Promise<readonly string[]>,
  ) {}

  async prepare(conversion: DueConversion): Promise<Prepared> {
    const template = conversion.postbackUrl;
    if (template === null || template === "") return { kind: "skip", reason: "no_address" };
    const params = conversion.params ?? {};
    if (usesMacro(template, "click_id") && params.click_id === undefined) return { kind: "skip", reason: "no_click_id" };

    const values: Record<PostbackMacro, string> = {
      click_id: params.click_id ?? "",
      sub1: params.sub1 ?? "",
      sub2: params.sub2 ?? "",
      sub3: params.sub3 ?? "",
      sub4: params.sub4 ?? "",
      sub5: params.sub5 ?? "",
      event: conversion.event,
      // По нему приёмник отсекает повторы: на повторе той же строки он тот же.
      event_id: conversion.conversionId,
      amount: conversion.purchase === null ? "0" : String(conversion.purchase.amount),
      currency: conversion.purchase === null ? "" : conversion.purchase.currency,
    };

    // Правила могли ужесточиться после того, как адрес сохранили: повтор ему не поможет.
    const [problem] = templateProblems(template);
    if (problem !== undefined) return { kind: "fail", message: `${CHECK_PREFIX}${problem}`, retry: false };

    let url: URL;
    try {
      url = fillTemplate(template, values);
    } catch {
      return { kind: "fail", message: "Адрес после подстановки не разбирается", retry: false };
    }
    if (url.href.length > POSTBACK_FILLED_MAX) return { kind: "fail", message: `Адрес после подстановки длиннее ${String(POSTBACK_FILLED_MAX)} знаков`, retry: false };

    const host = await checkHost(url.hostname, this.lookup);
    if (!host.ok) return { kind: "fail", message: `${CHECK_PREFIX}${host.message}`, retry: host.retry };

    return {
      kind: "request",
      url,
      init: { method: "GET", redirect: "manual", headers: { "user-agent": USER_AGENT } },
      logUrl: logUrlOf(url),
      quiet: true,
    };
  }
}
