import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../../common/with-timeout.js";
import { parseChatTarget } from "../../../platforms/ports/chat-target.js";
import { Messengers } from "../../../platforms/ports/messenger.js";
import { NotifyTargets } from "../../settings/notify-targets.js";
import { SETTINGS } from "../../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../../settings/settings.service.js";

/**
 * Сообщения команде в поток «Бухгалтерия» (`notify.chat.finance`, docs/29-admin-panel.md §4; Р222, tasks/T-0469):
 * пока поток не задан — общий чат, как у остальных потоков. Спор участника по отчёту — первое такое сообщение: владелец
 * должен узнать о нём сразу, а не из панели в день выплаты. Отправка — портом `Messengers`: домен не знает, как площадка
 * шлёт в чат.
 *
 * **Не бросает.** Решение участника уже записано: упавшее сообщение — предупреждение в логе, а не отказ запроса.
 */

const SEND_TIMEOUT_MS = 10_000;

export interface FinanceChatPort {
  send(text: string): Promise<void>;
}

@Injectable()
export class FinanceChat implements FinanceChatPort {
  private readonly logger = new Logger("ledger-payouts");

  constructor(
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly targets: NotifyTargets,
    private readonly messengers: Messengers,
  ) {}

  async send(text: string): Promise<void> {
    try {
      const target = parseChatTarget(this.settings.get(SETTINGS.chatFinance)) ?? this.targets.chats().general;
      const messenger = this.messengers.for("telegram");
      if (target === null || messenger === null || messenger.sendToChat === undefined) {
        this.logger.warn(JSON.stringify({ module: "ledger-payouts", event: "no_chat" }));
        return;
      }
      const outcome = await withTimeout(messenger.sendToChat(target, text), SEND_TIMEOUT_MS, "сообщение в чат команды");
      if (outcome.status !== "sent") this.logger.warn(JSON.stringify({ module: "ledger-payouts", event: "not_sent", outcome: outcome.status }));
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "ledger-payouts", event: "chat_failed", reason: error instanceof Error ? error.message : "unknown" }));
    }
  }
}
