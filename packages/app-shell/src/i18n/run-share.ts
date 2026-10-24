import { addTranslations } from "./index";
import runShare from "./ru-run-share.json";

/**
 * Строки «Поделиться» на экране итогов — своим словарём: едут в чанке
 * `state/run-share.ts`, который грузится по нажатию, а не в чанке забега.
 */
addTranslations(runShare);

export const RUN_SHARE_TRANSLATIONS_READY = true;
