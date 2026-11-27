import { Inject, Injectable, Logger } from "@nestjs/common";
import { CARD_STORE, type CardStore } from "../../common/card/card-store.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";

/** Адрес картинки под глобальным префиксом API (`app.setGlobalPrefix("api/v1")`). */
export function cardUrl(publicApiUrl: string, hash: string): string {
  return `${publicApiUrl.replace(/\/+$/, "")}/api/v1/cards/${hash}.png`;
}

/**
 * Публичный адрес готовой картинки для сообщений, которые несут её
 * предпросмотром (`PreparedMessageInput.imageUrl`). Картинки сообщений рисуют
 * свои задачи, а здесь — одна точка: сохранить PNG и получить адрес.
 */
@Injectable()
export class CardPublisher {
  private readonly logger = new Logger("cards");

  constructor(
    @Inject(CARD_STORE) private readonly store: CardStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Публичный адрес API задан — картинке есть где жить. */
  get available(): boolean {
    return this.config.telegram.publicApiUrl !== "";
  }

  /**
   * Сохранить PNG и вернуть адрес. `null` — картинки не будет: адрес API не
   * задан или хранилище не ответило; сообщение уйдёт текстом, как у площадки
   * без предпросмотра, — картинка украшает, а не держит отправку.
   */
  async publish(png: Buffer): Promise<string | null> {
    if (!this.available) return null;
    try {
      return cardUrl(this.config.telegram.publicApiUrl, await this.store.save(png));
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "cards", event: "publish_failed", reason: error instanceof Error ? error.message : "unknown" }));
      return null;
    }
  }
}
