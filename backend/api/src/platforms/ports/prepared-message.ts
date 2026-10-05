import type { PlatformId } from "./platform.js";

/**
 * Подготовленное сообщение (docs/35-stage4-plan.md Р63): бот площадки заранее
 * собирает сообщение с кнопкой в игру, а игрок в приложении сам выбирает, в
 * какой чат его отправить. Это не рассылка — пишет игрок, бот только собрал
 * текст и кнопку. Домен не знает, как площадка это делает: у Telegram —
 * `savePreparedInlineMessage` и `shareMessage` в Mini App.
 */
export interface PreparedMessageInput {
  /** заголовок в окне выбора чата */
  title: string;
  /** подпись под заголовком в окне выбора чата */
  description: string;
  /** простой текст сообщения — без разметки: её ломает имя игрока */
  text: string;
  button: { text: string; url: string };
}

export interface PreparedMessage {
  /** что передать приложению площадки, чтобы открыть выбор чата */
  id: string;
  /** до какого времени сообщение можно отправить; `null` — площадка не сказала */
  expiresAt: Date | null;
}

export interface MessagePreparer {
  readonly platform: PlatformId;
  /** бот настроен и умеет готовить сообщения */
  readonly configured: boolean;
  /** `null` — этому игроку площадка сообщение не подготовит: аккаунт не её, чата с ботом быть не может */
  prepare(platformUserId: string, message: PreparedMessageInput): Promise<PreparedMessage | null>;
}

export class MessagePreparers {
  private readonly byPlatform: ReadonlyMap<PlatformId, MessagePreparer>;

  constructor(preparers: readonly MessagePreparer[]) {
    this.byPlatform = new Map(preparers.map((preparer) => [preparer.platform, preparer]));
  }

  /** `null` — площадка так не умеет или её бот не настроен. */
  for(platform: PlatformId): MessagePreparer | null {
    const preparer = this.byPlatform.get(platform);
    return preparer === undefined || !preparer.configured ? null : preparer;
  }
}
