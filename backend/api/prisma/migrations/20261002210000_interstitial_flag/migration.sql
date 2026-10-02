-- Флаг выката межстраничной (docs/35-stage4-plan.md WP12, часть 10, Р79):
-- строка заводится выключенной, чтобы команда нашла флаг в панели готовым —
-- Telegram и десятая доля игроков — и включила одним нажатием. Без строки
-- межстраничную не видит никто. Заведённую вручную строку не трогаем.

INSERT INTO "feature_flag" ("key", "enabled", "platforms", "percent", "note", "updated_at")
VALUES ('ads.interstitial', false, ARRAY['telegram']::"Platform"[], 10,
        'Межстраничная при старте забега. Оставить — по удержанию D1/D7 и доходу на игрока этой доли против остальных',
        CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
