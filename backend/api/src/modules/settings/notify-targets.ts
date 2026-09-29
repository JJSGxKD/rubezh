import { Inject, Injectable } from "@nestjs/common";
import { parseChatTarget, type ChatTarget } from "../../platforms/ports/chat-target.js";
import { SETTINGS, type SettingDefinition } from "./setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "./settings.service.js";

/**
 * Адреса чатов команды. Общий адрес — у каждого потока свой может
 * отличаться темой или чатом: сводка, стресс-тесты и проблемные забеги не
 * должны мешаться в одной ленте.
 */
export interface AdminChats {
  /** общий адрес: меню команд администратора и всё, у чего нет своего потока */
  general: ChatTarget | null;
  /** сводка и ответы на `/stats` */
  stats: ChatTarget | null;
  /** карточки стресс-тестов */
  stressReports: ChatTarget | null;
  /** карточки проблемных забегов */
  runReports: ChatTarget | null;
  /** отзывы игроков с формы обратной связи */
  feedback: ChatTarget | null;
  /** подозрительные и отклонённые забеги — очередь разбора антифрода */
  runReview: ChatTarget | null;
}

/**
 * Куда писать команде — по настройкам (база → окружение). Адрес берётся на
 * момент отправки, а не при старте: чат, поменянный в панели, начинает
 * получать сообщения без перезапуска.
 */
@Injectable()
export class NotifyTargets {
  constructor(@Inject(SETTINGS_READER) private readonly settings: SettingsReader) {}

  chats(): AdminChats {
    const general = this.chat(SETTINGS.chatGeneral);
    const orGeneral = (setting: SettingDefinition<string>): ChatTarget | null => this.chat(setting) ?? general;
    return {
      general,
      stats: orGeneral(SETTINGS.chatStats),
      stressReports: orGeneral(SETTINGS.chatStress),
      runReports: orGeneral(SETTINGS.chatRuns),
      feedback: orGeneral(SETTINGS.chatFeedback),
      runReview: orGeneral(SETTINGS.chatRunReview),
    };
  }

  /** Слать ли карточки отчётов диагностики. */
  reportsEnabled(): boolean {
    return this.settings.get(SETTINGS.notifyReports);
  }

  /** Поменялся какой-нибудь из адресов — меню команд в чатах пора переставить. */
  onChatsChange(listener: () => void): void {
    this.settings.onChange((changed) => {
      if (changed.some((key) => key.startsWith("notify.chat."))) listener();
    });
  }

  private chat(setting: SettingDefinition<string>): ChatTarget | null {
    return parseChatTarget(this.settings.get(setting));
  }
}
