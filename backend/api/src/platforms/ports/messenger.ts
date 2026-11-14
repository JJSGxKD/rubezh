import type { ChatTarget } from "./chat-target.js";
import type { PlatformId } from "./platform.js";
import type { RichDocument } from "./rich-message.js";

/** Тема сообщений в личном чате: новости, награды, поддержка (Р199, WP52). Площадка без тем поле пропускает. */
export type MessageTopic = "news" | "rewards" | "support";

/**
 * Сообщение игроку от бота площадки (docs/35-stage4-plan.md §3.10, §3.11):
 * рассылки, а дальше — уведомления о заявке в друзья, подарке, сезоне. Домен
 * не знает, как площадка доставляет сообщение и чем отвечает на отказ, —
 * адаптер переводит её ответ в исход ниже.
 */
export interface OutgoingMessage {
  /** простой текст без разметки: разметка из панели — это ещё и способ сломать сообщение */
  text: string;
  /** кнопка-ссылка под сообщением; `null` — без кнопки */
  button: { text: string; url: string } | null;
  /**
   * Кнопка с действием под ссылкой: нажатие приходит боту обновлением с
   * `data` (tasks/T-0128, «Не напоминать»). Площадка без таких кнопок шлёт
   * сообщение без неё; рассылки поле не заполняют.
   */
  action?: { text: string; data: string };
  /**
   * Оформленный вид сообщения (Р199). Поле необязательное: фейки тестов и
   * площадки без оформления работают как раньше. `text` при нём — всегда
   * `plainTextOf(rich)`: его шлёт и площадка без оформления, и Telegram при отказе.
   */
  rich?: RichDocument;
  /** без звука уведомления; не задано — как решит площадка (со звуком) */
  silent?: boolean;
  /** тема в личном чате; адаптер без тем поле пропускает (тема в Telegram — отдельная задача WP52) */
  topic?: MessageTopic;
}

export type SendOutcome =
  /** `fallback` — оформленное не ушло, ушёл простой текст того же документа */
  | { status: "sent"; fallback?: true }
  /** писать этому игроку нельзя: заблокировал бота или не начинал с ним разговор */
  | { status: "blocked" }
  /** площадка просит подождать: превышен темп или сбой связи — повторить не раньше, чем через `afterSec` */
  | { status: "retry"; afterSec: number }
  /** не доставлено и повтор не поможет — код ответа для итога рассылки */
  | { status: "failed"; reason: string };

export interface Messenger {
  readonly platform: PlatformId;
  /** бот настроен и может писать */
  readonly configured: boolean;
  /** сколько сообщений в секунду площадка принимает от бота на массовой отправке */
  readonly ratePerSec: number;
  /**
   * Что площадка умеет сверх простого текста. Поле необязательное: нет поля —
   * площадка умеет только простой текст. Возможность спрашивают у порта, а не
   * по имени площадки.
   */
  readonly capabilities?: { rich: boolean; topics: boolean };
  send(platformUserId: string, message: OutgoingMessage): Promise<SendOutcome>;
  /**
   * Простой текст в чат команды (с темой, если она есть) — суточные отчёты
   * модулей, которым нельзя знать адаптер площадки. Не у каждой площадки есть.
   */
  sendToChat?(target: ChatTarget, text: string): Promise<SendOutcome>;
}

export class Messengers {
  private readonly byPlatform: ReadonlyMap<PlatformId, Messenger>;

  constructor(messengers: readonly Messenger[]) {
    this.byPlatform = new Map(messengers.map((messenger) => [messenger.platform, messenger]));
  }

  /** `null` — у площадки нет бота, которым мы пишем, или он не настроен. */
  for(platform: PlatformId): Messenger | null {
    const messenger = this.byPlatform.get(platform);
    return messenger === undefined || !messenger.configured ? null : messenger;
  }
}
