import type { CommandsLanguage } from "./telegram-bot-api.js";

/**
 * Профиль бота на языках интерфейса Telegram (bot-profile.ts). Русский — по
 * умолчанию: закрытый тест русскоязычный, и так же выбирает язык приветствие
 * (welcome-texts.ts). Английский — тем, у кого Telegram по-английски.
 *
 * Пределы Telegram: имя — до 64 знаков, короткое описание — до 120, описание
 * в пустом чате — до 512. Их проверяет тест, а не Telegram в момент выката.
 */
export interface BotProfileTexts {
  name: string;
  /** в профиле бота и при пересылке ссылки на него */
  shortDescription: string;
  /** в пустом чате до первого `/start`: что это и зачем нажимать */
  description: string;
  /** надпись кнопки меню, открывающей Mini App */
  menuButton: string;
}

export const DEFAULT_PROFILE_LANGUAGE: CommandsLanguage = "ru";

export const BOT_PROFILE_TEXTS: Record<CommandsLanguage, BotProfileTexts> = {
  ru: {
    name: "Рубеж",
    shortDescription: "Держи рубеж, пока хватает сил: бесконечный забег против волн врагов прямо в Telegram.",
    description: [
      "Рубеж — бесконечный забег на выживание. Волны врагов не кончаются, оружие бьёт само — ты ведёшь героя пальцем.",
      "",
      "• собирай кристаллы и выбирай улучшения",
      "• стихии, боссы и рекорды на каждой сложности",
      "• забег — пара минут, пауза в любой момент",
      "",
      "Идёт закрытый тест. Жми «Играть» или /start.",
    ].join("\n"),
    menuButton: "Играть",
  },
  en: {
    name: "Rubezh",
    shortDescription: "Hold the line as long as you can: an endless survival run against enemy waves, right in Telegram.",
    description: [
      "Rubezh is an endless survival run. Enemy waves never stop, your weapons fire on their own — you steer the hero with a finger.",
      "",
      "• collect crystals and pick upgrades",
      "• elements, bosses and records on every difficulty",
      "• a run takes a couple of minutes, pause anytime",
      "",
      "Closed test in progress. Tap “Play” or /start.",
    ].join("\n"),
    menuButton: "Play",
  },
};
