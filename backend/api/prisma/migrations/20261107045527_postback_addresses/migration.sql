-- Адрес постбэка у ссылки и у партнёра (tasks/T-0070, docs/35-stage4-plan.md Р86, Р96):
-- события игрока по кликам уходят на него GET-запросом с макросами. Только расширения:
-- ничего не удаляется, код прошлого релиза на такой схеме работает.
--
-- postback_url   — адрес с макросами, до 1024 знаков; пусто — не отправляем.
-- postback_since — с какого времени по кликам он действует; прошлое не досылается. Задан тогда
--                  и только тогда, когда задан адрес (CHECK ниже).
-- postback_events — какие события уходят; по умолчанию одна регистрация. Список событий —
--                  имена из `ad-conversions/postback-events.ts`; новое имя — миграция с новым CHECK.
--
-- У ссылки адрес важнее: нет своего — действует общий адрес партнёра-владельца.
-- Проверка адреса (https, без логина, пароля и порта, без внутренних адресов) — в коде.

-- Колонки с постоянным умолчанием добавляются без переписывания таблицы; CHECK проверяет
-- несколько сотен строк `link` и несколько десятков `partner` — блокировка короткая.
ALTER TABLE "link"
  ADD COLUMN "postback_url" VARCHAR(1024),
  ADD COLUMN "postback_since" TIMESTAMPTZ(3),
  ADD COLUMN "postback_events" VARCHAR(24)[] NOT NULL DEFAULT ARRAY['registration']::VARCHAR(24)[],
  ADD CONSTRAINT "link_postback_events_check" CHECK ("postback_events" <@ ARRAY['registration', 'purchase_first', 'purchase_repeat', 'd1_return']::VARCHAR(24)[]),
  ADD CONSTRAINT "link_postback_since_check" CHECK (("postback_url" IS NULL) = ("postback_since" IS NULL));

ALTER TABLE "partner"
  ADD COLUMN "postback_url" VARCHAR(1024),
  ADD COLUMN "postback_since" TIMESTAMPTZ(3),
  ADD COLUMN "postback_events" VARCHAR(24)[] NOT NULL DEFAULT ARRAY['registration']::VARCHAR(24)[],
  ADD CONSTRAINT "partner_postback_events_check" CHECK ("postback_events" <@ ARRAY['registration', 'purchase_first', 'purchase_repeat', 'd1_return']::VARCHAR(24)[]),
  ADD CONSTRAINT "partner_postback_since_check" CHECK (("postback_url" IS NULL) = ("postback_since" IS NULL));
