import type { PlatformId } from "./platform.js";

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
}

export type SendOutcome =
  | { status: "sent" }
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
  send(platformUserId: string, message: OutgoingMessage): Promise<SendOutcome>;
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
