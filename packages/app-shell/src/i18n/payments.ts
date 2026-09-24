import { addTranslations } from "./index";
import payments from "./ru-payments.json";

/**
 * Тексты покупки второго шанса. Модуль импортирует сама покупка на экране
 * смерти (`screens/run/PaidContinue.tsx`): словарь дополняется, когда
 * подгружается чанк экрана смерти.
 *
 * Отдельно от основного словаря по той же причине, что тексты гайдбука:
 * основной словарь едет в первую загрузку, а эти строки нужны только
 * умершему игроку там, где второй шанс можно купить.
 */
addTranslations(payments);

export const PAYMENTS_TRANSLATIONS_READY = true;
