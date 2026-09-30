import { addTranslations } from "./index";
import testNotice from "./ru-test-notice.json";

/**
 * Тексты предупреждения о тесте (docs/35-stage4-plan.md WP33) — своим
 * словарём: их читают экран предупреждения и «Об игре», первая загрузка за
 * них не платит (docs/27-design-system-and-app-shell.md §3.4). Короткий
 * пересказ для экрана первого запуска — в основном словаре: тот экран
 * открывается раньше всего остального.
 */
addTranslations(testNotice);

export const TEST_NOTICE_TRANSLATIONS_READY = true;
