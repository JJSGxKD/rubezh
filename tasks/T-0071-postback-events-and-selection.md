---
id: T-0071
title: Постбэки — покупки и возврат на следующий день, выбор событий у назначения
epic: E14
priority: P3
status: ready
owner:
author: claude-lead2-2
size: M
depends_on: [T-0069, T-0070]
zones:
  - backend/api/src/modules/ad-conversions/**
  - backend/api/src/modules/links/links.service.ts
  - backend/api/src/modules/links/links.repository.ts
  - backend/api/src/modules/admin/admin-links.controller.ts
  - backend/api/src/modules/admin/admin-partners.controller.ts
  - backend/api/src/modules/partners/**
  - backend/api/test/postback-events.test.ts
  - backend/api/test/postback-events.integration.test.ts
  - apps/admin/src/api/links.ts
  - apps/admin/src/api/partners.ts
  - apps/admin/src/screens/links/**
  - apps/admin/src/screens/partners/**
  - apps/admin/test/postbacks.test.ts
shared:
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/23-referral-and-partner-program.md
  - docs/35-stage4-plan.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0071. Постбэки — покупки и возврат на следующий день, выбор событий у назначения

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0071.json)](README.md#значки-статуса) [![T-0069](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0069.json&label=T-0069)](T-0069-postback-destinations-layer.md) [![T-0070](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0070.json&label=T-0070)](T-0070-postback-s2s-and-partner.md)

## Зачем

Партнёру и сети мало знать о регистрации: им нужны оплаты (по ним считают
выручку и оптимизируют закупку) и возврат игрока на следующий день (по нему
видно, играют ли привезённые игроки). После задачи в карточке ссылки и партнёра
отмечается, какие события уходят на адрес, а к ним добавляется новое событие
«возврат на следующий день».

## Решения

Записаны в `docs/35-stage4-plan.md` Р86, Р96, О39 и в `tasks/inbox.md` («Постбэки — общий слой
адаптеров»). Слой назначений и колонки — T-0069 и T-0070.

- **События:** `registration`, `purchase_first`, `purchase_repeat`, `d1_return`. Первые три уже
  порождает проход из T-0069; здесь добавляется `d1_return` и выбор.
- **По умолчанию у назначения только `registration`**; `d1_return` включают руками. У AdsGram выбора
  нет: три фиксированных события, `d1_return` он не получает никогда (`accepts`, T-0069).
- **`d1_return`:** засчитанный сервером забег (те же правила, что у регистрации: завершён, без читов,
  не короче `CONVERSION_WINDOWS.minRunSec`, вердикт не `rejected`) **в следующий игровой день после дня
  регистрации**. День регистрации — игровой день **первого засчитанного забега** аккаунта (того, что
  даёт событие `registration`), а не создания аккаунта: создал в понедельник, впервые сыграл во
  вторник — это регистрация во вторник, а не возврат (решение `claude-lead-1`, 13.10.2026). Первый
  засчитанный забег должен попасть в окно регистрации от клика (`CONVERSION_WINDOWS`). Игровой день — как у награды дня,
  полночь по Москве (`GAME_DAY_TIME_ZONE`, `backend/api/src/common/game-day.ts`; сутки считает база через
  `AT TIME ZONE`). Только следующий день: на второй и третий событие не выдаётся. Одно событие на клик
  и назначение (ключ T-0069 для цели 4).
- **Суммы:** `{amount}` — `purchase.charged_stars`, `{currency}` — `XTR`, без пересчёта
  (`docs/37-accounting.md`, О44).
- **Выбор событий — у назначения:** `link.postback_events` и `partner.postback_events` (T-0070);
  действует список того объекта, чей адрес используется. Выбирать можно, только когда адрес задан.
  Включение события `postback_since` не меняет.

## Как сейчас

- `conversions.repository.ts` (после T-0069/T-0070): `sweep` — два `INSERT … SELECT` (регистрации и
  покупки) поверх `TARGETS_CTE` (`destinations/destination-targets.ts`): строка пишется, если событие
  есть в `t.events` и клик не раньше `t.since`. Условие «засчитанный забег» записано внутри запроса
  регистраций (`finished_at IS NOT NULL`, `cheats = false`, `survival_sec >= minRunSec`,
  `verdict IS NULL OR <> 'rejected'`). Покупки: `mode = 'live'`, `status = 'paid'`, без запроса
  возврата, не раньше `purchaseSettleMin` минут, в окне `purchaseDays`; первая оплата аккаунта —
  `purchase_first`, остальные — `purchase_repeat`.
- `conversion-rules.ts` — `CONVERSION_WINDOWS`; `postback-events.ts` (T-0069) — `POSTBACK_EVENTS`,
  `EVENT_GOAL`, `eventOfGoal`.
- Таблица `ad_conversion`: цель 4 и ключ `(click_id, goal, destination)` для целей 1, 2, 4 уже есть —
  миграции в этой задаче нет. Колонки `postback_events` на `link` и `partner` (T-0070) менять нечем.
- Образец игрового дня: `daily.repository.ts` — `(at AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date`.
- Панель: блок «Постбэк» в `screens/links/` и поле партнёра (T-0070); `apps/admin/src/api/links.ts` —
  `conversionSchema.goal` пока `1 | 2 | 3`, `GOAL_TITLES`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Рефакторинг отдельным коммитом, поведение то же:** условие засчитанного забега
   вынести из запроса регистраций во фрагмент `COUNTED_RUN` (`Prisma.sql` с
   параметром — псевдоним таблицы `run`) в `ad-conversions/counted-run.ts`; регистрации
   используют его. Тесты регистраций остаются зелёными без правки.
3. **`conversion-rules.ts`:** `CONVERSION_WINDOWS.returnLookbackDays` — с какого
   давнего первого касания искать возвраты: окно регистрации (7 суток) плюс 2 —
   первый засчитанный забег бывает на седьмые сутки после клика, а следующие
   игровые сутки за ним кончаются самое позднее через ~48 часов. Значение —
   выражением от окна регистрации, а не числом, чтобы окна не разошлись.
4. **`conversions.repository.ts`, `sweep`:** третий запрос — возвраты, поверх тех же
   `TARGETS_CTE`:

   ```sql
   INSERT INTO ad_conversion (conversion_id, network, link_code, click_id, account_id, goal, status, reason, next_attempt_at, created_at, destination)
   SELECT gen_random_uuid(), t.destination, l.code, c.click_id, q.account_id, 4,
          (… 'skipped' / 'pending' по account_role, как у регистраций …), (… 'team' …), ${now}, ${now}, t.destination
   FROM targets t
   JOIN link l ON l.code = t.link_code
   JOIN link_click c ON c.link_code = l.code
   JOIN acquisition q ON q.first_start_kind = 'click' AND q.first_start_ref = c.click_id
   JOIN account a ON a.account_id = q.account_id AND a.created_at >= c.at - interval '1 minute'
   WHERE 'd1_return' = ANY(t.events)
     AND c.at >= t.since
     AND q.first_at > ${now}::timestamptz - make_interval(days => ${returnLookbackDays})
     AND EXISTS (
       SELECT 1 FROM run r
       WHERE r.account_id = q.account_id AND <COUNTED_RUN r>
         AND (r.finished_at AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date = (
           -- день регистрации: первый засчитанный забег, и он в окне регистрации от клика
           SELECT (min(f.finished_at) AT TIME ZONE ${GAME_DAY_TIME_ZONE})::date + 1
           FROM run f
           WHERE f.account_id = q.account_id AND <COUNTED_RUN f>
             AND f.finished_at <= c.at + <окно регистрации>))
   ON CONFLICT DO NOTHING
   ```

   Форму запроса исполнитель выверяет по соседним запросам `sweep` (порядок JOIN
   и индексы `(first_start_kind, first_at)`); смысл обязателен: только цели 4, только
   назначения, выбравшие `d1_return`, только новые аккаунты по клику, только следующий
   игровой день. Отчёт прохода `TickReport` получает счётчик `returns`.
5. **Отправка `d1_return`** — через `TemplateDestination` (T-0070) без изменений:
   `{event}` = `d1_return`, `{amount}` = `0`, `{currency}` пусто. Для AdsGram событие не
   порождается (его нет в `events`), а попавшая вручную строка пропускается по
   `accepts` (T-0069).
6. **Тип строки журнала:** `ConversionRow.goal` расширить до `1 | 2 | 3 | 4`
   (`conversions.repository.ts`, `rowOf`); счёт `summaries` по-прежнему считает только
   AdsGram и цели 1–3.
7. **События назначения — `ad-conversions/postback-events.ts`:**

   ```ts
   export const EVENT_TITLES: Record<PostbackEvent, string>;      // «Регистрация», «Первая покупка», «Повторная покупка», «Возврат на следующий день»
   export const DEFAULT_EVENTS: readonly PostbackEvent[];         // ["registration"]
   /** Что не так со списком; пусто — годится. Порядок и повторы нормализует `normalizeEvents`. */
   export function eventsProblems(events: unknown): string[];
   export function normalizeEvents(events: readonly PostbackEvent[]): PostbackEvent[]; // канонический порядок, без повторов
   ```

   Тексты проблем дословно: «События должны быть списком» · «Неизвестное событие: {имя}» ·
   «Выберите хотя бы одно событие».
8. **Админ-API:**
   - `PATCH /api/v1/admin/links/:code` принимает `postbackEvents: PostbackEvent[]`
     (право `links.manage`): `eventsProblems` не пуст → 400; адреса у ссылки нет (и в этом
     же запросе он не задан) → 400 «Сначала задайте адрес постбэка»; значение
     пишется нормализованным; аудит `links.postback.events` с `before`/`after`;
   - `POST /api/v1/admin/partners/:partnerId` принимает `postbackEvents` по тем же
     правилам (право `partners.edit`), аудит «было → стало»;
   - в виде ссылки и партнёра `postbackEvents` уже отдаются (T-0070);
   - снятие адреса возвращает `postbackEvents` к `["registration"]`.
9. **Панель:**
   - `apps/admin/src/api/links.ts`, `partners.ts`: `setLinkPostbackEvents`, поле в обновлении
     партнёра; `conversionSchema.goal` — `1 | 2 | 3 | 4`; `GOAL_TITLES[4] = "Возврат на следующий день"`;
   - в блоке «Постбэк» (T-0070) вместо строки «Получает: регистрация.» — флажки:
     «Регистрация» (подсказка «Новый игрок зарегистрировался — по правилу ссылки»),
     «Первая покупка» («Первая настоящая оплата игрока в течение 30 дней после клика»),
     «Повторная покупка» («Каждая следующая оплата»), «Возврат на следующий день»
     («Игрок вернулся и сыграл засчитанный забег на следующие игровые сутки после дня
     регистрации; сутки — по Москве. По умолчанию выключено»). Кнопка «Сохранить события».
     Ничего не отмечено → «Выберите хотя бы одно событие» под флажками, запрос не уходит.
     Под флажками: «Событие, включённое позже, уйдёт и по игрокам, которые пришли после даты
     начала отправки, пока не закрылось его окно.»;
   - у ссылки партнёра без своего адреса флажки показывают события партнёра с подписью
     «События общего адреса партнёра» и недоступны: меняются в карточке партнёра;
   - у ссылок с сетью AdsGram — строка без флажков: «AdsGram получает: регистрация, первая
     покупка, повторная покупка. Возврат на следующий день AdsGram не принимает.»;
   - журнал: событие 4 в колонке цели подписано «Возврат на следующий день».
10. **Документы** — раздел «Документы».

## Чего не трогаем

- AdsGram: набор событий, формат, токен, окна, паузы — как в T-0069. Шаблон, макросы, проверка адреса,
  click_id и sub — T-0070.
- Миграции: схема готова в T-0069 и T-0070; нехватка колонки — вопрос тимлиду, своей миграции не заводить.
- Правила засчитанного забега (`verdict`, `cheats`, `minRunSec`), граница игровых суток
  (`common/game-day.ts`), пересчёт сумм, переименование событий под сеть.

## Сценарий и интерфейс

Карточка ссылки или партнёра → блок «Постбэк» с заданным адресом → флажки событий → «Сохранить события».

- загрузка: флажки неактивны; пусто (адрес не задан): флажков нет, «Адрес не задан — ничего не отправляем.»;
- ошибка: текст сервера под флажками, отмеченное остаётся; нет сети: «Не удалось сохранить — проверьте
  связь», выбор не сбрасывается;
- нет права: блока нет.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/postback-events.test.ts`:
  - `eventsProblems`: не массив → «События должны быть списком»; `[]` → «Выберите хотя бы одно событие»;
    `["registration","x"]` → «Неизвестное событие: x»; `["d1_return","registration","registration"]` годится,
    `normalizeEvents` → `["registration","d1_return"]`;
  - API: событие без адреса → 400 «Сначала задайте адрес постбэка»; с адресом в том же запросе сохранено;
    без `links.manage` / `partners.edit` — 403; аудит несёт `before`/`after`; снятие адреса возвращает
    `["registration"]`; `AdsgramDestination.accepts` без `d1_return`.
- `backend/api/test/postback-events.integration.test.ts` (живой Postgres, время — параметром `sweep(now)`):
  - граница суток по Москве: первый засчитанный забег закончен `2026-10-10 20:59:00Z` (23:59 МСК 10.10),
    второй — `2026-10-10 21:01:00Z` (00:01 МСК 11.10) → строка `goal = 4`; второй забег в тот же день
    (`20:59:30Z`) → нет; второй забег `2026-10-11 21:01:00Z` (через день) → нет;
  - аккаунт создан 10.10, первый засчитанный забег 11.10, второй 12.10 → `goal = 4` по забегу 12.10;
    единственный забег 11.10 → строки `goal = 4` нет (это регистрация, а не возврат);
  - короткий забег, с читами, `rejected`, не завершённый — не считаются; события нет в `events` → строки нет,
    есть → есть; ссылка AdsGram → нет; клик раньше `postback_since` → нет; первое касание 4 дня назад не
    перебирается; аккаунт команды — `skipped`, `team`; старый аккаунт — не конверсия;
  - повтор и два параллельных прохода → ровно одна строка на клик и назначение;
  - покупки на `s2s` при `{registration,purchase_first,purchase_repeat}`: первая настоящая оплата → цель 2,
    вторая → 3; тестовая, возвращённая и не отлежавшая 10 минут не уходят; номер оплаты — по аккаунту;
  - через `tick(now, fetch)`: оплата 50 звёзд → `amount=50`, `currency=XTR`, `event=purchase_first`;
    `d1_return` → `amount=0`, `currency=`; повтор строки несёт тот же `event_id`;
  - событие включено после оплаты (клик после `since`, окно открыто) → строка появляется на следующем проходе.
- `apps/admin/test/postbacks.test.ts` (дополнение): подписи событий; «Получает: …» в каноническом порядке;
  пустой выбор не отправляется; у ссылки партнёра без своего адреса флажки недоступны; у AdsGram строка
  без флажков дословно из «Шагов».

## Аналитика

Нет. Журнал отправок — таблица `ad_conversion`; событие серверу не нужно
(`docs/35-stage4-plan.md` WP43, «Аналитика»). Метки Prometheus с `link_code`/`partner_id`
не заводим.

## Настройки и окружение

Нет новых переменных и ключей `setting-catalog.ts`. Новая константа
`CONVERSION_WINDOWS.returnLookbackDays` — в `conversion-rules.ts`, где остальные окна.

## Документы

- `docs/35-stage4-plan.md`: WP43 и WP49 часть 4 «Как сделано» — события `purchase_first`,
  `purchase_repeat`, `d1_return`, выбор событий, правило игрового дня.
- `docs/23-referral-and-partner-program.md`: какие события получает партнёр и как включить.
- `docs/21-diagrams.md`: схема потока конверсий — третий запрос прохода (возвраты).
- `docs/30-configuration-map.md`: `returnLookbackDays` и где выбираются события.

## Вопросы к тимлиду

Подтверждено `claude-lead-1` 13.10.2026; первый пункт изменён.

- Решено `claude-lead-1` 13.10.2026: день регистрации — игровой день первого засчитанного забега, а не
  создания аккаунта (раздел «Решения»).
- Подтверждено `claude-lead-1` 13.10.2026: `d1_return` — только следующий игровой день, возврат на третий и
  дальше под него не попадает.
- Подтверждено `claude-lead-1` 13.10.2026: событие, включённое позже, досылается по кликам после
  `postback_since`, пока открыто его окно (7 суток для регистрации, 30 для покупок).

## Критерии приёмки

- [ ] События выбираются в карточке ссылки и партнёра; без события сохранить нельзя, без адреса выбор
  недоступен.
- [ ] Покупки уходят с суммой и валютой как заплачено (`XTR`); тестовые, возвращённые и не отлежавшие
  оплаты не уходят.
- [ ] `d1_return` создаётся ровно в следующий игровой день по Москве, один раз на клик и назначение, и
  только там, где выбран; AdsGram его не получает и не меняется.
- [ ] Миграций нет; у назначений без `d1_return` условие `'d1_return' = ANY(t.events)` отсекает строки до
  подзапроса по забегам.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; в PR — чек-листы безопасности и нагрузки
  (`docs/15-engineering-standards.md` §7, §8).

## PR

- **Заголовок:** `feat(api): Выбор событий постбэка и возврат на следующий день`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СОБЫТИЯ ПОСТБЭКА: ПОКУПКИ И ВОЗВРАТ НА СЛЕДУЮЩИЙ ДЕНЬ**

  В карточке ссылки и партнёра можно выбрать, какие события уходят на адрес постбэка: регистрация, первая и повторная покупка, возврат на следующий день. По умолчанию уходит только регистрация.

  🛠 **Что внутри**

  • покупки уходят с суммой и валютой как заплачено (звёзды — XTR)
  • возврат — засчитанный забег в следующие игровые сутки после дня регистрации (полночь по Москве)
  • AdsGram работает как раньше, возврат ему не отправляется
  ```
