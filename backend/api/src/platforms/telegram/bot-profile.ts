import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { BOT_AVATAR_SVG, renderBotAvatar } from "./bot-avatar.js";
import { BOT_PROFILE_TEXTS, DEFAULT_PROFILE_LANGUAGE } from "./bot-profile-texts.js";
import type { CommandsLanguage, TelegramBotApi } from "./telegram-bot-api.js";
import { TELEGRAM_BOT_API } from "./telegram-bot-api.js";

/**
 * Профиль бота из кода, а не руками в BotFather (docs/28-diagnostics.md
 * §6.1.2): имя, описание в пустом чате, короткое описание, кнопка меню с
 * Mini App и фото — на каждом языке свои. Бот без этого «голый», а правка в
 * BotFather расходится с репозиторием и теряется при смене бота.
 *
 * Применяется при старте API — и только если профиль изменился: его
 * отпечаток лежит в Redis. Вызовы профиля у Telegram редкие по природе и с
 * жёсткими лимитами, а рестарты API — частые.
 */

export type ProfileBotApi = Pick<
  TelegramBotApi,
  "setMyName" | "setMyDescription" | "setMyShortDescription" | "setMenuWebApp" | "setMyProfilePhoto"
>;

export interface BotProfileState {
  applied(): Promise<string | null>;
  remember(fingerprint: string): Promise<void>;
}

export const BOT_PROFILE_STATE = Symbol("BOT_PROFILE_STATE");

@Injectable()
export class RedisBotProfileState implements BotProfileState {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  applied(): Promise<string | null> {
    return this.redis.get("bot:profile");
  }

  async remember(fingerprint: string): Promise<void> {
    await this.redis.set("bot:profile", fingerprint);
  }
}

/**
 * Отпечаток всего, что уходит в профиль: тексты, адрес Mini App и сам знак.
 * Поменялась строка или картинка — профиль применяется заново.
 */
export function profileFingerprint(webAppUrl: string): string {
  return createHash("sha256").update(JSON.stringify([BOT_PROFILE_TEXTS, webAppUrl, BOT_AVATAR_SVG])).digest("hex");
}

@Injectable()
export class BotProfile implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("bot");
  private readonly stop = new AbortController();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TELEGRAM_BOT_API) private readonly api: ProfileBotApi,
    @Inject(BOT_PROFILE_STATE) private readonly state: BotProfileState,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.telegram.updates === "off") return;
    void this.publish().catch((error: unknown) => this.log("warn", "profile_not_set", { reason: reasonOf(error) }));
  }

  onModuleDestroy(): void {
    this.stop.abort();
  }

  /** `applied` — профиль ушёл в Telegram, `unchanged` — он уже такой. */
  async publish(): Promise<"applied" | "unchanged"> {
    const url = this.config.telegram.webAppUrl;
    const fingerprint = profileFingerprint(url);
    if ((await this.state.applied()) === fingerprint) return "unchanged";

    const signal = this.stop.signal;
    // Без языка — для всех остальных: им достаётся язык по умолчанию.
    const targets: [CommandsLanguage | null, CommandsLanguage][] = [
      [null, DEFAULT_PROFILE_LANGUAGE],
      ...(Object.keys(BOT_PROFILE_TEXTS) as CommandsLanguage[]).map((language): [CommandsLanguage, CommandsLanguage] => [language, language]),
    ];
    for (const [languageCode, language] of targets) {
      const texts = BOT_PROFILE_TEXTS[language];
      await this.api.setMyName(texts.name, languageCode, signal);
      await this.api.setMyDescription(texts.description, languageCode, signal);
      await this.api.setMyShortDescription(texts.shortDescription, languageCode, signal);
    }
    // Без адреса Mini App кнопке нечего открывать — остаётся кнопка команд.
    if (url !== "") await this.api.setMenuWebApp(BOT_PROFILE_TEXTS[DEFAULT_PROFILE_LANGUAGE].menuButton, url, null, signal);
    await this.api.setMyProfilePhoto(renderBotAvatar(), signal);

    // Отпечаток — только после всего профиля: оборвалось посередине —
    // следующий старт применит профиль заново.
    await this.state.remember(fingerprint);
    this.log("log", "profile_applied", { languages: targets.length - 1, menu: url !== "" });
    return "applied";
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "bot", event, ...fields }));
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}
