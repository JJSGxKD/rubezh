import type { MessageTopic, SendOutcome } from "./messenger.js";
import type { PlatformId } from "./platform.js";

/**
 * Живая карточка бота (docs/35-stage4-plan.md Р199, WP52): сообщение с
 * состоянием, которое бот правит сам и которое спрашивает бота по касанию.
 * Домен говорит видом карточки и её состоянием, как карточка выглядит, знает
 * адаптер площадки; площадка без карточек вовсе не имеет порта — сценарий идёт
 * обычным сообщением того же содержания.
 *
 * Файл — порт: ничего не импортирует из модулей и адаптеров.
 */

/** Где лежит отправленная карточка: чат и номер сообщения у площадки. */
export interface LiveCardRef {
  chatId: string;
  messageId: number;
}

export interface LiveCardMessage {
  /** вид карточки, `^[a-z_]{3,16}$`: по нему адаптер выбирает облик */
  kind: string;
  /** состояние — JSON не длиннее 1024 байт, первое поле `v: 1` */
  state: string;
  /** подпись не длиннее 1024 знаков: правда и там, где обновления до игрока не дойдут */
  caption: string;
  /** кнопка-ссылка под карточкой; `null` — без кнопки */
  button: { text: string; url: string } | null;
  /** без звука уведомления */
  silent: boolean;
  topic?: MessageTopic;
}

/**
 * `unsupported` — площадка отказала в методе карточек (Р225): не сбой
 * доставки, а «карточек сейчас нет». Игроку при этом уходит запасное
 * сообщение, а площадка встаёт на паузу.
 */
export type LiveCardSendOutcome = { status: "sent"; ref: LiveCardRef; version: string } | { status: "unsupported" } | Exclude<SendOutcome, { status: "sent" }>;

/** `gone` — сообщения больше нет: игрок удалил его. */
export type LiveCardUpdateOutcome = { status: "edited" | "unchanged" | "gone" | "unsupported" } | Exclude<SendOutcome, { status: "sent" }>;

export interface LiveCardPort {
  readonly platform: PlatformId;
  /** бот настроен и может писать */
  readonly configured: boolean;
  /** умеет ли площадка этот вид: решает адаптер, а не домен */
  supports(kind: string): boolean;
  send(platformUserId: string, message: LiveCardMessage): Promise<LiveCardSendOutcome>;
  /** `state` — то же JSON-состояние, что в `LiveCardMessage`; облик собирает адаптер */
  update(ref: LiveCardRef, state: string): Promise<LiveCardUpdateOutcome>;
}

export class LiveCards {
  private readonly byPlatform: ReadonlyMap<PlatformId, LiveCardPort>;

  constructor(ports: readonly LiveCardPort[]) {
    this.byPlatform = new Map(ports.map((port) => [port.platform, port]));
  }

  /** `null` — у площадки нет карточек или бот не настроен. */
  for(platform: PlatformId): LiveCardPort | null {
    const port = this.byPlatform.get(platform);
    return port === undefined || !port.configured ? null : port;
  }
}

/** Запрос из карточки: касание кнопки или обновление фоном. */
export interface LiveCardQuery {
  platform: PlatformId;
  platformUserId: string;
  /** карточка, из которой пришёл запрос; `null` — сообщение неизвестно */
  ref: LiveCardRef | null;
  /** `v<версия>:<действие>[:<аргумент>]` до 64 байт — разбирает ответчик */
  data: string;
}

export interface LiveCardAnswerer {
  /** Всегда строка до 1024 байт: на любой запрос площадка обязана получить ответ, в том числе ошибкой. */
  answer(query: LiveCardQuery): Promise<string>;
}

export const LIVE_CARD_ANSWERER = Symbol("LIVE_CARD_ANSWERER");
