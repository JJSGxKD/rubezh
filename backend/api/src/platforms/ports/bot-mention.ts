import type { PlatformId } from "./platform.js";

/**
 * Стоит ли юзернейм бота игры в имени или bio игрока на площадке
 * (docs/35-stage4-plan.md Р110, tasks/T-0159). Домен просит порт, а как
 * площадка отдаёт имя и bio — у Telegram это данные чата пользователя у бота
 * (`getChat`), — знает только её адаптер; у площадок без такой возможности
 * заданий нет.
 *
 * Текст имени и bio наружу из адаптера не выходит: порт отдаёт только итог.
 */

/** Где искать: показываемое имя на площадке или поле «о себе». */
export type MentionKind = "name" | "bio";

/**
 * `hidden` — поле проверить нельзя: bio закрыто настройкой приватности или
 * пусто, площадка эти случаи не различает.
 */
export type MentionFinding = "present" | "absent" | "hidden";

export type MentionOutcome =
  | { status: "checked"; findings: Partial<Record<MentionKind, MentionFinding>> }
  /** площадка просит подождать или связь сбойнула: повторить не раньше, чем через `afterSec` */
  | { status: "retry"; afterSec: number }
  /** проверить нельзя и повтор не поможет: нет чата с игроком, это не аккаунт площадки, имя бота неизвестно */
  | { status: "unavailable"; reason: string };

export interface BotMention {
  readonly platform: PlatformId;
  /** бот настроен и имя его известно */
  readonly configured: boolean;
  /** сколько проверок в секунду площадка принимает от бота */
  readonly ratePerSec: number;
  /** юзернейм бота игры без «@»; `null` — не известен */
  botUsername(): string | null;
  /** один запрос площадки на все `kinds`; в `findings` — только запрошенные виды */
  check(platformUserId: string, kinds: readonly MentionKind[]): Promise<MentionOutcome>;
}

/** Проверки всех площадок: домен выбирает по площадке аккаунта. */
export class BotMentions {
  constructor(private readonly all: readonly BotMention[]) {}

  /** Только настроенная: у площадки без бота заданий нет. */
  for(platform: PlatformId): BotMention | null {
    return this.all.find((mention) => mention.platform === platform && mention.configured) ?? null;
  }
}

/** Длиннее юзернейма Telegram не бывает: защита от раздувания выражения. */
const MAX_USERNAME = 64;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/**
 * Есть ли в тексте `@<username>`: без учёта регистра, перед `@` и после имени
 * нет `[A-Za-z0-9_]`. Без `@` не считается — так же юзернейм вырезается из
 * показываемого ника (Р111).
 */
export function containsMention(text: string, username: string): boolean {
  if (text === "" || username === "" || username.length > MAX_USERNAME) return false;
  return new RegExp(`(?<![A-Za-z0-9_])@${escapeRegExp(username)}(?![A-Za-z0-9_])`, "iu").test(text);
}
