import type { PlatformId } from "./platform.js";

/**
 * Ссылка на бота площадки для связи аккаунтов (docs/35-stage4-plan.md Р188,
 * tasks/T-0377): чтобы проверить подписку игрока на канал MAX или VK, сервер
 * должен знать, кто этот игрок там. Игрок открывает бота по ссылке с
 * одноразовым кодом, бот получает код вместе с id игрока и отдаёт их
 * серверу — как бот ответит игроку и как вызовет сервер, знает только адаптер
 * площадки.
 */
export interface ExternalLinkStarter {
  readonly platform: PlatformId;
  /**
   * Ссылка, которую открывает игрок; `null` — площадка сейчас не настроена
   * (нет бота или ключа). Чистая функция: ничего не отправляет и не читает по
   * сети, поэтому её можно спрашивать при каждом показе заданий.
   */
  startUrl(code: string): string | null;
}

/** Стартеры всех площадок: домен выбирает по площадке канала. */
export class ExternalLinkStarters {
  private readonly all: ExternalLinkStarter[];

  constructor(all: readonly ExternalLinkStarter[]) {
    this.all = [...all];
  }

  /** Адаптер площадки подключает себя сам при старте своего модуля; повтор заменяет стартер той же площадки. */
  register(starter: ExternalLinkStarter): void {
    const index = this.all.findIndex((item) => item.platform === starter.platform);
    if (index === -1) this.all.push(starter);
    else this.all[index] = starter;
  }

  for(platform: PlatformId): ExternalLinkStarter | null {
    return this.all.find((starter) => starter.platform === platform) ?? null;
  }
}
