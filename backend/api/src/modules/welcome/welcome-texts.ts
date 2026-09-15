import { pluralRu } from "../../common/card/labels.js";

/**
 * Тексты приветствия по `/start` на языке пользователя
 * (docs/28-diagnostics.md §6.1.2). Игра пока только на русском, но бот
 * отвечает и тем, у кого Telegram по-английски: приглашение должно быть
 * понятно до того, как человек открыл игру.
 *
 * Русский — для русского и близких к нему языков интерфейса, и для тех, чей
 * клиент язык не сообщил: закрытый тест русскоязычный. Остальным — английский.
 */
export type WelcomeLanguage = "ru" | "en";

const RUSSIAN_READERS = new Set(["ru", "uk", "be", "kk"]);

export function languageOf(languageCode: string | undefined): WelcomeLanguage {
  if (languageCode === undefined || languageCode === "") return "ru";
  const base = languageCode.toLowerCase().split("-")[0] ?? "";
  return RUSSIAN_READERS.has(base) ? "ru" : "en";
}

export type Difficulty = "easy" | "normal" | "hard";

export interface WelcomeTexts {
  brand: string;
  greeting(name: string): string;
  fallbackName: string;
  newcomerLead: string;
  newcomerPoints: readonly string[];
  newcomerCall: string;
  recordLabel(difficulty: Difficulty): string;
  rank(rank: number, total: number): string;
  runs(count: number): string;
  veteranCall: string;
  caption(name: string, hasRecord: boolean): string;
  playButton: string;
}

const RU_DIFFICULTIES: Record<Difficulty, string> = { easy: "Лёгкая", normal: "Нормальная", hard: "Сложная" };
const EN_DIFFICULTIES: Record<Difficulty, string> = { easy: "Easy", normal: "Normal", hard: "Hard" };

export const WELCOME_TEXTS: Record<WelcomeLanguage, WelcomeTexts> = {
  ru: {
    brand: "РУБЕЖ",
    greeting: (name) => `Привет, ${name}!`,
    fallbackName: "боец",
    newcomerLead: "Продержись как можно дольше против волн, которые не кончаются.",
    newcomerPoints: ["Персонаж атакует сам — ты ведёшь его пальцем", "Собирай кристаллы и выбирай улучшения", "Каждая минута злее предыдущей"],
    newcomerCall: "Жми «Играть» — первый забег займёт пару минут",
    recordLabel: (difficulty) => `рекорд · ${RU_DIFFICULTIES[difficulty]}`,
    rank: (rank, total) => `#${rank} из ${total}`,
    runs: (count) => `${count} ${pluralRu(count, "забег", "забега", "забегов")}`,
    veteranCall: "Побьёшь свой рекорд?",
    caption: (name, hasRecord) =>
      hasRecord
        ? `${name}, рубеж ждёт. Рекорд на картинке — побьёшь?`
        : `${name}, добро пожаловать на закрытый тест «Рубежа». Игра открывается кнопкой ниже.`,
    playButton: "▶ Играть",
  },
  en: {
    brand: "RUBEZH",
    greeting: (name) => `Hi, ${name}!`,
    fallbackName: "fighter",
    newcomerLead: "Hold out as long as you can against waves that never end.",
    newcomerPoints: ["Your hero attacks on its own — you steer", "Collect crystals and pick upgrades", "Every minute is harder than the last"],
    newcomerCall: "Tap “Play” — your first run takes a couple of minutes",
    recordLabel: (difficulty) => `best · ${EN_DIFFICULTIES[difficulty]}`,
    rank: (rank, total) => `#${rank} of ${total}`,
    runs: (count) => `${count} ${count === 1 ? "run" : "runs"}`,
    veteranCall: "Can you beat your record?",
    caption: (name, hasRecord) =>
      hasRecord
        ? `${name}, the line is waiting. Can you beat the record on the card?`
        : `${name}, welcome to the Rubezh closed test. The game opens with the button below — it is in Russian for now.`,
    playButton: "▶ Play",
  },
};
