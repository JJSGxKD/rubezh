import { Injectable } from "@nestjs/common";
import type { MessageTopic } from "../../platforms/ports/messenger.js";
import type { RichDocument } from "../../platforms/ports/rich-message.js";
import type { AccountRef } from "../roles/roles.service.js";
import type { SettingDefinition } from "../settings/setting-catalog.js";
import { CARD_KIND_PATTERN } from "./bot-card-protocol.js";

/**
 * Контракт вида живой карточки и реестр видов (docs/35-stage4-plan.md Р199,
 * tasks/T-0395). Виды регистрируются сами — `BotCardKinds.register` в
 * `onModuleInit` модуля вида, как слушатели `RunsHooks`: общего списка видов в
 * ядре нет, поэтому карточки «Сезон», «Награда дня» и «Приглашения» не делят
 * файлов. Деньги в ядре не живут: оно только передаёт действие виду (`act`),
 * а начисления идут через проверки сервисов самого вида.
 */

/** Итог действия игрока из карточки: `res` в ответе и `outcome` события `bot_card_query`. */
export interface CardActResult {
  outcome: "ok" | "already" | "locked" | "limited";
  /** поля ответа поверх `{ v: 1, res }`; весь ответ — до 1024 байт */
  result: Record<string, unknown>;
}

export interface BotCardKind {
  /** `^[a-z_]{3,16}$`: `season`, `daily`, `invites` */
  kind: string;
  /** ключ панели вида: выключен — этот вид идёт запасным сообщением (Р225) */
  enabled: SettingDefinition<boolean>;
  /** выбор игрока для карточек по триггеру; `null` — у вида выбора нет. Команда игрока выбору не подчиняется */
  choice: { setting: string; byDefault: boolean } | null;
  /** параметр запуска `n-<вид>_card`: кнопка «▶ Играть» ведёт по нему и считает приход */
  startRef: string;
  /** тема в личном чате; не задана — без темы */
  topic?: MessageTopic;
  /** ключ периода на момент `at`: смена периода — финал живых карточек; `null` — у вида нет финала */
  periodKey(at: Date): string | null;
  /** состояние, как игрок видит его сейчас; до 1024 байт вместе с `v: 1` */
  state(accountId: string, at: Date): Promise<Record<string, unknown>>;
  /** финал периода; нет — последнее отправленное состояние с `x: 1` */
  finalState?(last: Record<string, unknown>, at: Date): Record<string, unknown>;
  /** подпись карточки до 1024 знаков: правда и там, где обновления до игрока не дойдут */
  caption(state: Record<string, unknown>): string;
  /** то же содержание для площадки без карточек и на время паузы (Р225) */
  fallback(state: Record<string, unknown>): RichDocument;
  /** действие игрока; ядро зовёт его только для имён из `actions` */
  act?(account: AccountRef, action: string, arg: string | null, at: Date): Promise<CardActResult>;
  /** разрешённые действия, кроме обновления `r` */
  actions: readonly string[];
}

@Injectable()
export class BotCardKinds {
  private readonly kinds = new Map<string, BotCardKind>();

  /** Повтор вида — исключение на старте: два вида с одним id делили бы карточки молча. */
  register(kind: BotCardKind): void {
    if (!CARD_KIND_PATTERN.test(kind.kind)) throw new Error(`Вид карточки «${kind.kind}»: id — строчные латинские и подчёркивание, 3–16 знаков`);
    if (this.kinds.has(kind.kind)) throw new Error(`Вид карточки «${kind.kind}» уже зарегистрирован`);
    this.kinds.set(kind.kind, kind);
  }

  get(kind: string): BotCardKind | undefined {
    return this.kinds.get(kind);
  }

  all(): BotCardKind[] {
    return [...this.kinds.values()];
  }
}
