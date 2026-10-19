import { addTranslations } from "./index";
import runInterrupted from "./ru-run-interrupted.json";

/**
 * Тексты карточки «Игра обновилась — забег засчитан» (tasks/T-0163) — своим
 * словарём: её видит игрок, чей забег прервало обновление, один раз; первая
 * загрузка за неё не платит (docs/27-design-system-and-app-shell.md §3.4).
 */
addTranslations(runInterrupted);

export const RUN_INTERRUPTED_TRANSLATIONS_READY = true;
