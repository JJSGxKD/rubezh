---
id: T-0181
title: Прямая ссылка на Mini App для рекламы AdsGram — метки сети в стартовом параметре и конверсия по запуску
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0179, T-0180]
zones:
  - backend/api/src/modules/attribution/start-param.ts
  - backend/api/src/modules/auth/auth.service.ts
  - backend/api/src/modules/links/link-targets.ts
  - backend/api/src/modules/links/link-networks.ts
  - backend/api/src/modules/links/links.service.ts
  - backend/api/src/platforms/ports/app-links.ts
  - backend/api/src/platforms/telegram/telegram-app-links.ts
  - backend/api/src/modules/ad-conversions/conversions.repository.ts
  - backend/api/src/modules/ad-conversions/direct-launch-sweep.ts
  - apps/admin/src/api/links.ts
  - apps/admin/src/screens/links/LinkCard.tsx
  - backend/api/test/start-param.test.ts
  - backend/api/test/link-targets.test.ts
  - backend/api/test/app-links.test.ts
  - backend/api/test/ad-conversions.test.ts
  - backend/api/test/ad-conversions.integration.test.ts
  - backend/api/test/channel-entry.test.ts
  - backend/api/test/attribution.integration.test.ts
  - apps/admin/test/links.test.ts
shared:
  - docs/21-diagrams.md
  - docs/24-attribution-and-sharing.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
  - docs/33-telegram-mini-app-pitfalls.md
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0181. Прямая ссылка на Mini App для рекламы AdsGram — метки сети в стартовом параметре и конверсия по запуску

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0181.json)](README.md#значки-статуса) [![T-0179](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0179.json&label=T-0179)](T-0179-start-param-pairs-auto-sources.md) [![T-0180](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0180.json&label=T-0180)](T-0180-links-panel-auto-sources.md)

## Зачем

Модерация AdsGram плохо принимает переходники, и каждое объявление приходится
согласовывать через менеджеров (Р117). Нужна прямая ссылка на Mini App
(`t.me/<бот>?startapp=…`), в которой едут код нашей ссылки и метки клика сети: AdsGram
сам подставляет макросы прямо в стартовый параметр. Запуск по такой ссылке
засчитывается ссылке и уходит сети конверсией — так же, как через переходник.
Переходник `/r/<код>` остаётся для всех остальных мест.

## Решения

Р117 (`docs/35-stage4-plan.md`, 19.10.2026): для рекламы — прямая ссылка на Mini
App; код ссылки и метки клика сети едут в стартовом параметре; переходник
остаётся; у прямой ссылки сервер не видит клика, только запуск — клики дают
кабинеты сетей.

Р121 (`docs/35-stage4-plan.md`, уточнение Р117, 20.10.2026). Ответы пользователя
и решения тимлида от 20.10.2026:

- **AdsGram подставляет макросы в стартовый параметр** ссылки на Mini App. Образец
  из кабинета:
  `https://t.me/PlayRubezhBot?startapp=source-adsgram_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}`.
- **Лимиты Telegram:** стартовый параметр Mini App (`startapp`) — до **512** знаков,
  алфавит `A-Za-z0-9_-`; у `/start` бота по-прежнему до **64**.
- **Состав параметра** (решил тимлид): `source-adsgram` убираем — сеть, кампанию и
  партнёра даёт код нашей ссылки; первым добавляем код ссылки `l-<код>`; оставляем
  `campaign` (запасной постбэк `tgid` + `campaignid` и разрез по кампаниям AdsGram),
  `clickid` (сверка с кабинетом, паритет с переходником) и `record` (основной
  постбэк) — `record` строго последним. Итог, который панель отдаёт кнопкой:
  `https://t.me/<бот>?startapp=l-<код>_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}`
  (макросы без кодирования).
- **Имена ключей — те же, что у параметров переходника** в профиле сети
  (`LINK_NETWORK_PROFILES.adsgram.macros`: `campaign`, `banner`, `pub`, `clickid`,
  `record`), чтобы и клик переходника, и прямой запуск давали одинаковую форму
  `network_params` и один код постбэка. В прямую ссылку входят только три из них.
- **Разбор.** `l-<код>` (`LINK_CODE`, как сейчас), дальше хвост пар `_<ключ>-<значение>`
  с ключом из профиля сети. Значение идёт до следующего `_<известный ключ>-`, а
  значение `record` — до конца строки (в нём бывают `_` и `-`). Значение — по
  правилам `MACRO_VALUE`; неподставленный (пустой) макрос отбрасывается. Хвост не
  разобрался — запуск всё равно вида `link` с кодом ссылки (атрибуцию не теряем),
  параметров сети нет. Разбор `l-<код>_…` стоит раньше пар T-0179.
- **Длина.** Проверка `TELEGRAM_START_PARAM` делится по каналу: Mini App — 512,
  бот — 64. Колонки `start_param` (`account_session`, `acquisition.first_*` и
  `last_*`) — `VarChar(512)`, миграция только расширяет. `start_ref` остаётся 64.
- **Конверсия.** Ветка кандидатов `first_start_kind = 'link'` у ссылки с сетью:
  новичок, те же окна и условия, что у клика, отсчёт — от `acquisition.first_at`.
  Вместо `start_label` у `ad_conversion` — `network_params JSONB` (те же ключи, что у
  клика), `click_id` становится nullable, частичный уникальный индекс
  `(account_id, goal) WHERE click_id IS NULL AND goal IN (1, 2)`. Постбэк — прежний
  `adsgramPostbackUrl`: `record`, иначе `tgid` + `campaignid`, иначе «нет меток».
- **Панель.** У ссылки сети второй адрес — «Прямая ссылка для рекламы» с кнопкой
  «Скопировать» и подсказкой (сервер не видит клика, только запуски; клики — в
  кабинете AdsGram); строка «только через переходник» уходит.
- **Переходник `/r/<код>` и его макросы не меняются.**

Уточнения `claude-lead2-1` внутри Р121 (по записанному решению, без нового
продуктового выбора):

- Прямой адрес для рекламы собирается **только у ссылки с целью `app`**. У цели `bot`
  параметр `/start` — до 64 знаков, меток сети в него не уложить; у `landing` стартового
  параметра нет. У таких ссылок сети `directUrl` остаётся `null`, а панель говорит
  почему.
- Подпись кнопки — «Скопировать» (общий `AddressBox`), подпись блока — «Прямая ссылка для
  рекламы».
- Значение по умолчанию для вызова `parseStartParam` без канала — Mini App (512). Это
  безопасно для сохранённых строк: бот не сохраняет длиннее 64, а Mini App — 512, так
  что повторный разбор уже записанного значения (как в T-0179, `auto-sources.service.ts`)
  даёт тот же вид. Вызовы из бота передают канал явно.

## Как сейчас

- Прямая ссылка: `links/link-targets.ts:70-73` — `directUrl` **возвращает `null`
  для ссылки с сетью** (`link.network !== null`); в шапке файла (строки 12-15) сказано,
  что макросы пишет только переходник. На карточке — строка `NETWORK_NO_DIRECT`
  «Ссылка закупки — только через переходник» (`apps/admin/src/api/links.ts:28`,
  вывод — `LinkCard.tsx:110`).
- Построители: `LinkTargetBuilders.launch(param)` (`link-targets.ts:24-31`) собирает
  `links.service.ts:171-177` через `AppLinks.launch` (`platforms/ports/app-links.ts:34`) →
  `TelegramAppLinks.launch` (`telegram-app-links.ts:20-23`): `${miniAppLink}=${encodeURIComponent(param)}`.
  Фигурные скобки он закодирует в `%7B…`, а сеть ищет макрос буквально
  (`links.service.ts:165-167`, `networkUrl` пишется без кодирования).
- Профиль сети: `link-networks.ts:31-36` — `macros: { campaign, banner, pub, clickid,
  record }`; `networkParamsOf(network, query)` (строки 57-65) берёт из словаря только ключи
  профиля, значение — `MACRO_VALUE` (`[\x21-\x7e]{1,256}`, без `{`).
- Параметр `l-<код>`: `attribution/start-param.ts:79-82`, вид `link`, `ref` — код
  ссылки; всё, что после кода, — `unknown`. Алфавит и длина — `TELEGRAM_START_PARAM`
  (строка 53, 64 знака) — **одна на оба канала**. Вызовы `parseStartParam`:
  `auth.service.ts:107` (Mini App, из подписанного `initData`), `:131` (веб, `null`),
  `:151` (`enterChannel`, бот). После T-0179 в конце разбора добавлены пары
  `ключ-значение` (вид `tagged`).
- Запись сессии: `session-recorder.ts` `sessionOf` кладёт `startParam` (сырой),
  `startRef`; `sessions.repository.ts` пишет их в `account_session` и `acquisition`
  (`first_*` — первое касание, `last_*` — последнее). Колонки `start_param`,
  `first_start_param`, `last_start_param` — `VarChar(64)` (`schema.prisma:588,623,632`);
  индексов и представлений на них нет (кроме миграции `20260924214700_attribution` они
  нигде не упоминаются). Строка длиннее 64 в базу сейчас **не пройдёт**.
- Конверсии: `ad-conversions/conversions.repository.ts` `sweep` (строки 95-157)
  выбирает кандидатов только `first_start_kind = 'click'` через `link_click`; `due`
  (строки 159-176) берёт макросы из `link_click.network_params` внутренним `JOIN`;
  `purgeParams` (202-210) обнуляет только `link_click`. `ad_conversion.click_id` —
  `NOT NULL` с внешним ключом на `link_click` (`schema.prisma:2128,2146`); уникальность —
  `(click_id, goal)` для целей 1 и 2 (частичный индекс в миграции
  `20261002180000_ad_conversions`).
- Постбэк: `conversion-rules.ts:73-88` `adsgramPostbackUrl` — `record`; при только
  `campaign` и числовом Telegram ID — `tgid` + `campaignid`; иначе `null` → отправитель
  пишет `skip(…, "no_macros")` (`conversions.service.ts:118-121`).
- Итог проверки: **у запуска по прямой ссылке нет ни меток, ни конверсии** — разрыв, который
  закрывает задача.
- Файл `conversions.repository.ts` уже 266 строк: прямая ветка уходит в отдельный файл
  (правило «сервис длиннее 300 строк — декомпозиция», `CLAUDE.md`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»), красными.
2. **Профиль сети** (`link-networks.ts`):
   - в `LinkNetworkProfile` поле `direct: readonly string[]` — какие параметры идут в
     прямую ссылку и в каком порядке; у `adsgram`: `["campaign", "clickid", "record"]`
     (`record` обязан быть последним — проверяет тест);
   - `NETWORK_PARAM_KEYS` — объединение ключей `macros` всех профилей (сейчас
     `campaign, banner, pub, clickid, record`);
   - `directMacroTail(network): string` → `_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}`:
     ключи из `direct`, значения — макросы профиля, без кодирования;
   - `networkTailParams(tail: string): Record<string, string> | null` — разбор хвоста после
     кода, хвост начинается с `_`. Хвост должен **начинаться** с `_<ключ>-` из
     `NETWORK_PARAM_KEYS`, иначе `null`. Дальше идём слева направо по маркерам
     `_(campaign|banner|pub|clickid|record)-` (регулярное выражение строится из
     `NETWORK_PARAM_KEYS`): значение — до начала следующего маркера, у `record` — до конца
     строки. Повтор ключа — берётся первый. Пустое значение и значение не по `MACRO_VALUE`
     отбрасываются. Ничего не осталось — `null`.
3. **`start-param.ts`:**
   - `StartChannel = "miniapp" | "bot"`; `START_PARAM_MAX = { miniapp: 512, bot: 64 }`;
     `parseStartParam(value, channel: StartChannel = "miniapp")`. Вместо одной регулярки
     `TELEGRAM_START_PARAM` — проверка алфавита `^[A-Za-z0-9_-]+$` и длины по каналу; не прошло —
     прежний результат `{ kind: "unknown", raw: null, ref: null }`;
   - у `StartParam` необязательное поле `networkParams?: Record<string, string>`: есть только
     у вида `link` и только если хвост разобрался (у остальных, как и у `link` без хвоста, поля
     нет — иначе поедут `toEqual` в тестах);
   - ветка `l-`: `body = value.slice(2)`, `code` — до первого `_` (или вся строка);
     `LINK_CODE.test(code)` → `{ kind: "link", raw: value, ref: code }` плюс
     `networkParams`, если `networkTailParams(body.slice(code.length))` не `null`. Не прошёл
     код — дальше по прежнему пути (пары T-0179 и `unknown`). Ветка стоит там же, где была,
     то есть раньше пар. Обнови шапку-комментарий файла: два лимита вместо «до 64 знаков»;
   - `auth.service.ts:151` (`enterChannel`) передаёт `"bot"`; `:107` — `"miniapp"` явно;
     `:131` (`null`) не меняется.
4. **Адрес** (`link-targets.ts`, `app-links.ts`, `telegram-app-links.ts`, `links.service.ts`):
   - `AppLinkBuilder.launch(startParam, rawTail?: string)` и `AppLinks.launch(platform,
     startParam, rawTail?)`; `LinkTargetBuilders.launch(param, rawTail?)`;
   - `TelegramAppLinks.launch`: `${base}=${encodeURIComponent(startParam)}${rawTail ?? ""}`;
     `rawTail` — часть, которую кодировать нельзя; допускаются только `A-Za-z0-9_-{}`, иначе
     `null` (адрес не собираем, а не отдаём сломанный);
   - `directUrl(link, builders)`: ссылка без сети — как было; с сетью и целью `app` —
     `builders.launch("l-<код>", directMacroTail(network))`; с сетью и целью `bot` или
     `landing` — `null`. `link` в сигнатуре получает `network: string | null` как сейчас;
     неизвестную сеть (`isLinkNetwork` ложно) — `null`. Обнови комментарии файла (строки 12-15,
     69) — «у ссылки сети прямой нет» больше не верно;
   - `links.service.ts` `builders()` пробрасывает `rawTail`; `LinkView` не меняется, `directUrl`
     у ссылки сети теперь адрес с макросами.
5. **Миграция** по процедуре «Общие файлы» из `tasks/README.md` (`prisma migrate dev
   --create-only` один раз, на отдельной базе, после перебазирования на свежий `dev`;
   проверить, что папка миграции одна). Только расширения:
   - `ALTER COLUMN … TYPE VARCHAR(512)` для `account_session.start_param`,
     `acquisition.first_start_param`, `acquisition.last_start_param`. В Postgres увеличение
     предела `varchar` не переписывает таблицу (метаданные, короткая блокировка); проверить, что
     Prisma не добавила ничего кроме трёх `ALTER`, и записать это в описание PR;
   - `ad_conversion`: `ALTER COLUMN click_id DROP NOT NULL`; `ADD COLUMN network_params JSONB`
     (`/// метки сети с прямого запуска: те же ключи, что у link_click.network_params; у конверсии по
     клику пусто, метки лежат на клике; обнуляются через 31 сутки`);
   - частичные индексы **только в миграции**, как существующий `ad_conversion_click_id_goal_key`
     (Prisma их не выражает; после миграции `prisma migrate diff` не должен предлагать их
     удалить): `CREATE UNIQUE INDEX "ad_conversion_account_goal_direct_key" ON
     "ad_conversion"("account_id", "goal") WHERE "click_id" IS NULL AND "goal" IN (1, 2)` и
     `CREATE INDEX "ad_conversion_network_params_created_at_idx" ON
     "ad_conversion"("created_at") WHERE "network_params" IS NOT NULL` (отбор для обнуления);
   - `schema.prisma`: `clickId String?`, `click LinkClick?`, `networkParams Json?`, три
     `@db.VarChar(512)`. Комментарии `///` — на русском, без истории.
   - **План отката** (в описание PR): схема расширяется, откат кода без отката схемы безопасен —
     старый код пишет не длиннее 64. Одно исключение: строки `ad_conversion` с `click_id IS NULL`
     старый Prisma-клиент прочитать не сможет (поле было обязательным) — журнал ссылки сети
     упадёт. Поэтому откат ниже этой версии — только после `DELETE FROM ad_conversion WHERE
     click_id IS NULL` (теряется журнал прямых конверсий) либо вперёд, исправлением.
6. **Новый `ad-conversions/direct-launch-sweep.ts`** — `sweepDirectLaunches(prisma, now): Promise<{
   registrations: number; purchases: number }>`; вызывается из `PrismaConversionsRepository.sweep`
   после ветки клика, счётчики складываются. Разбор параметра — в TypeScript, не в SQL:
   - **кандидаты регистрации** (SQL, до 500 за проход, `ORDER BY q.first_at`): `acquisition q`
     `JOIN link l ON l.code = q.first_start_ref AND l.network IS NOT NULL`
     `JOIN account a ON a.account_id = q.account_id AND a.created_at >= q.first_at - interval '1 minute'`
     `WHERE q.first_start_kind = 'link' AND q.first_at > now - (registrationDays + 1) суток`
     `AND NOT EXISTS (SELECT 1 FROM ad_conversion v WHERE v.account_id = q.account_id AND v.goal = 1)`
     и условие регистрации как у клика: `l.registration_on = 'launch'` либо есть забег
     (`finished_at IS NOT NULL`, `cheats = false`, `survival_sec >= minRunSec`, вердикт не
     `rejected`) с `finished_at <= q.first_at + registrationDays`. Колонки: `account_id`,
     `link_code`, `network`, `first_start_param`, признак команды
     (`EXISTS … account_role`). Цель ссылки (`target`) в отборе **не участвует**: запуск по
     `startapp` доказал, что игрок пришёл по ней, а цель ссылки меняется;
   - **кандидаты покупки** — по той же связке (`first_start_kind = 'link'`, ссылка с сетью,
     новичок, `q.first_at > now - (purchaseDays + 1) суток`): настоящие, не возвращённые
     покупки (`mode = 'live'`, `status = 'paid'`, `paid_at IS NOT NULL`,
     `refund_requested_at IS NULL`); номер покупки `row_number() OVER (PARTITION BY account_id
     ORDER BY paid_at, purchase_id)` считается **до** отбора уже заведённых (иначе после отправки
     первой вторая стала бы «первой»); затем `paid_at <= q.first_at + purchaseDays`, `paid_at <=
     now - purchaseSettleMin` и `NOT EXISTS (SELECT 1 FROM ad_conversion v WHERE v.purchase_id =
     p.purchase_id)`; цель — 2 для первой, 3 для остальных; до 500 за проход;
   - **чистая функция** `directConversionRows(candidates, now)`: для каждого кандидата
     `parseStartParam(first_start_param, "miniapp")`; вид не `link` или `ref` не равен коду
     ссылки — меток нет; иначе `networkParamsOf(network, parsed.networkParams ?? {})` (фильтр по
     ключам профиля сети ссылки, та же проверка значений, что у клика); пустой результат —
     `null`. Строка: `status = 'skipped'`, `reason = 'team'` для аккаунта команды, иначе
     `pending`; `click_id = null`; `network_params` — результат; `next_attempt_at = created_at =
     now`. Метки нет — строка всё равно пишется (с `null`): отправитель пропустит её как «нет
     меток», и кандидат больше не выбирается;
   - вставка — `prisma.adConversion.createMany({ data, skipDuplicates: true })`
     (`ON CONFLICT DO NOTHING`: частичные индексы и `purchase_id` держат повтор и гонку; сам проход
     идёт под локом Redis, но целостность не должна на нём держаться). Возвращает число вставленных.
7. **`conversions.repository.ts`:**
   - `due`: `LEFT JOIN link_click c`, метки — `COALESCE(c.network_params, v.network_params)`;
     остальное без изменений;
   - `purgeParams`: второй `UPDATE ad_conversion SET network_params = NULL` для строк со
     `created_at` старше `paramsKeepDays` (отбор по индексу из шага 5, порциями `limit`); возвращает
     сумму обеих порций. Повторы отправки живут не дольше двух суток, так что окно с запасом;
   - `sweep` вызывает `sweepDirectLaunches`; остальное — как есть.
8. **Панель.** `apps/admin/src/api/links.ts`: уберите `NETWORK_NO_DIRECT`; добавьте тексты
   `NETWORK_DIRECT_LABEL = "Прямая ссылка для рекламы"`, `NETWORK_DIRECT_HINT = "Для рекламы AdsGram:
   вставьте целиком, вместе с метками в фигурных скобках — сеть сама подставит данные клика. Сервер
   не видит клика, только запуск: клики и расходы смотрите в кабинете AdsGram. Запуск по этой
   ссылке засчитывается ссылке и уходит сети конверсией, как через переходник."`,
   `NETWORK_DIRECT_NEEDS_APP = "Прямая ссылка для рекламы есть только у ссылки с целью Mini App: в чат с
   ботом параметр запуска — до 64 знаков, меток сети в него не уложить."` (словарь подсказок панели
   `ui/help.ts` вне зон, тексты — рядом с подписями, как `DIRECT_HINT`). Чистая функция
   `networkDirectState(link): "ready" | "needs_app" | "unavailable"` (есть адрес — `ready`; цель не
   `app` — `needs_app`; иначе `unavailable`) — её и тестируют. `LinkCard.tsx`: в блоке ссылки сети
   после адреса для кабинета — `AddressBox` «Прямая ссылка для рекламы» с `NETWORK_DIRECT_HINT`
   (`needs_app` — `NETWORK_DIRECT_NEEDS_APP`, `unavailable` — `DIRECT_UNAVAILABLE`); строка
   `NETWORK_NO_DIRECT` уходит; в списке шагов — пункт «Если модерация сети не принимает
   переходник, вставьте прямую ссылку для рекламы вместо него». Счёт «через переходник» и «по
   прямой ссылке» в карточке уже раздельный — не трогать.
9. **Документы:**
   - `docs/24` §3.4: строка про сеть («у ссылки с сетью прямой ссылки нет») заменяется — у
     ссылки сети с целью `app` прямая есть, с метками; §3.5: новый подраздел «Прямая ссылка для
     рекламы» — образец, список ключей, правило разбора, лимиты 512/64, откуда метки, какой
     постбэк, что сервер не видит клика; §5: вид `l-<код>_<метки>` и два лимита;
   - `docs/21`: ER `AD_CONVERSION` (`click_id` необязателен, `network_params`), `ACCOUNT_SESSION` и
     `ACQUISITION` (длина параметра), поток конверсий — вторая ветка по запуску;
   - `docs/29` строка «Ссылки» — два адреса у ссылки сети; `docs/30` строка «Конверсии закупок»
     — метки живут и на конверсии, прямой запуск; `docs/33` §5.1 «У нас» — теперь на сторонней
     рекламе в `startapp` едут код ссылки и метки сети, лимит 512, а не один `click_id`.

## Чего не трогаем

- Переходник `/r/<код>`, его страницу, клики и макросы на клике: путь через переходник работает как
  раньше (тест на это — в списке).
- `adsgramPostbackUrl`, `conversion-rules.ts`, отправитель `conversions.service.ts`, токен
  конверсий, журнал и повторы отправки.
- Автоисточники по ключам (T-0179), панель к ним (T-0180) и `auto-sources.service.ts`: он
  разбирает сырую строку без канала и получает умолчание «Mini App».
- Проверка `^[A-Za-z0-9_-]{1,64}$` в `modules/ads/ad-audience.ts:67` — это `/start` бота, там 64.
- `start_ref` и его длину (64), `link.code` (16), `LINK_CODE`.
- Другие сети: профиль один — AdsGram. Макросы `banner` и `pub` в прямую ссылку не входят.
- Источник переноса (`vpnsibcom_api`): механизм `source-…_compaing-…_record-…` — только как список
  краевых случаев, код не копируется (`CLAUDE.md`, «Перенос кода»).

## Сценарий и интерфейс

Карточка ссылки сети (`#/links/<код>`), блок адресов, сверху вниз:

1. «Адрес для кабинета AdsGram» (переходник с макросами) — как сейчас.
2. «Прямая ссылка для рекламы» — адрес `t.me/<бот>?startapp=l-<код>_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}`,
   кнопка «Скопировать» (тост «Адрес скопирован»), под ним подсказка `NETWORK_DIRECT_HINT`.
3. Шаги настройки, «Адрес без меток — для проверки».

Состояния:

- загрузка и «ссылки нет» — как у карточки сейчас;
- цель ссылки не Mini App — вместо адреса одна строка `NETWORK_DIRECT_NEEDS_APP`;
- бот ещё не представился, адрес собрать нельзя — строка `DIRECT_UNAVAILABLE`;
- ошибка буфера обмена — прежний тост «Браузер не дал скопировать — выделите вручную»;
- нет сети и ограничение аккаунта — на уровне всего экрана, как у остальной карточки.

Адрес длинный — переносится в `AddressBox` (`break-all`), на 320 px не даёт горизонтальной прокрутки.

## Тесты

Пишутся первым коммитом, до кода. Интеграционные — на живых Postgres и Redis
(`docs/17-testing-strategy.md` §4.2).

- `start-param.test.ts` (чистые). Пусть `CODE = "AbC123xyz9"`:
  - полный образец с `record`, содержащим `_` и `-`:
    `l-AbC123xyz9_campaign-55_clickid-3f2a-9c_record-r_5-aB_9` → `{ kind: "link", raw, ref: CODE,
    networkParams: { campaign: "55", clickid: "3f2a-9c", record: "r_5-aB_9" } }`;
  - без `clickid`: `…_campaign-55_record-r1` → `networkParams: { campaign: "55", record: "r1" }`;
  - порядок не важен для обычных ключей: `…_clickid-7_campaign-55_record-r1` → те же значения;
  - без хвоста `l-AbC123xyz9` → ровно `{ kind: "link", raw, ref: CODE }` (поля `networkParams` нет);
  - неподставленные макросы: `…_campaign-_clickid-77_record-` → `networkParams: { clickid: "77" }`;
    `…_campaign-_record-` → вид `link`, поля нет; буквальные `…_campaign-{campaign_id}` →
    `{ kind: "unknown", raw: null, ref: null }` (скобок нет в алфавите Telegram, до разбора хвоста
    не доходит);
  - хвост не разобрался: `…_hello`, `…_`, `…_foo-1`, `…_src-x_cmp-y` → `link`, `ref` код, поля
    `networkParams` нет (в том числе пары T-0179 после кода не превращают `l-` в `tagged`);
  - повтор ключа: `…_campaign-1_campaign-2` → `campaign: "1"`;
  - плохой код: `l-abc_campaign-5` (3 знака) и `l-Ab12Cd34Ef56Gh78X_campaign-5` (17) →
    `unknown` с сырой строкой;
  - длина Mini App: `l-AbC123xyz9_record-` + знаки до ровно 512 → `link`; 513 → `{ kind: "unknown",
    raw: null, ref: null }`; запись `record` длиннее 256 в строке на 512 → `link` без `record`;
  - длина бота: ровно 64 → `link`, 65 → `unknown` с `raw: null`; 65 знаков без канала (умолчание
    Mini App) → `link`;
  - регрессия: `c-AbCdEf123456`, `l-AbC123xyz9`, `f-AbCdEf1234`, `n-friend_request`, `invite`,
    `_tgr_123`, пары T-0179 (`src-tgads_cmp-oct` → `tagged`) разбираются как до задачи;
  - `NETWORK_PARAM_KEYS` = `campaign, banner, pub, clickid, record`.
- `ad-conversions.test.ts` (чистые):
  - `directMacroTail("adsgram")` = `_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}`;
    ключи `direct` входят в `macros`, `record` последний, в хвосте нет знаков вне `A-Za-z0-9_-{}`;
  - круг: из адреса `directUrl` подставить значения вместо макросов, взять часть после `startapp=` →
    `parseStartParam` возвращает вид `link` с теми же значениями;
  - `directConversionRows`: кандидат с полным образцом → `network_params` из трёх ключей,
    `click_id` пуст, `pending`; кандидат команды → `skipped`/`team`; параметр другого вида или
    с другим кодом → метки `null`; ключ, которого нет в профиле сети ссылки, отбрасывается;
  - постбэк из прямых меток: `{ campaign, clickid, record }` → `record` + `goaltype`; только
    `{ campaign }` и Telegram ID → `tgid` + `campaignid`; без меток → `null`.
- `link-targets.test.ts` (в заглушке построителей `launch(param, rawTail)` добавляет `rawTail` без
  кодирования):
  - ссылка с сетью и целью `app` → `https://t.me/rubezh_bot?startapp=l-AbC123xyz9_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}`,
    скобки буквально, без `%7B`;
  - с сетью и целью `bot` или `landing` → `null`; неизвестная сеть → `null`; бот не представился → `null`;
  - ссылка без сети — все три цели как раньше и `rawTail` не передаётся.
- `app-links.test.ts`: `launch("telegram", "l-AbC123xyz9", "_campaign-{campaign_id}")` дописывает
  хвост без кодирования; параметр по-прежнему кодируется; хвост с пробелом, `&`, `?`, `#` или
  кириллицей → `null`; без хвоста — как раньше; бот не представился → `null`.
- `channel-entry.test.ts`: `enterChannel` с параметром `l-<код>_campaign-5_record-` длиной 64 → вид
  `link`; 65 знаков → `unknown` с `raw: null`. Вход Mini App с `start_param` длиной 512
  (`signInitData`) → вид `link`; 513 → `unknown` с `raw: null`.
- `attribution.integration.test.ts`: сессия с `startParam` из 512 знаков записывается в
  `account_session.start_param` и в `acquisition.first_start_param`/`last_start_param`, читается
  обратно целиком (до задачи — ошибка «значение слишком длинное»).
- `ad-conversions.integration.test.ts` (новичок «по прямой ссылке»: аккаунт создан сейчас, сессия
  `startKind: "link"`, `startRef` — код ссылки с сетью, `startParam` — полный образец):
  - забег от 30 с → один проход `sweep` даёт одну регистрацию: `goal 1`, `click_id` пуст,
    `network_params` = `{ campaign, clickid, record }`, `pending`; второй проход и **два прохода
    параллельно** (`Promise.all`) — по-прежнему одна строка;
  - `due` возвращает те же метки; постбэк берёт `record`;
  - забег 29 с, забег с читами, отклонённый вердикт, нет забега при `first_run` → регистрации нет;
    при `registrationOn: "launch"` — есть сразу;
  - забег позже окна (8 суток после `first_at`) — не считается;
  - без `clickid` и `record` (только `campaign`) → строка с `{ campaign }`; хвост не разобрался →
    строка с `network_params` пустым, отправитель пропускает её как `no_macros`;
  - старый игрок: аккаунт создан за сутки до первой записанной сессии по ссылке → конверсии нет;
    игрок, у которого первое касание органическое, а по ссылке он пришёл позже, — конверсии нет;
  - аккаунт команды → `skipped`, `reason = 'team'`, повтор из панели (`requeue`) работает;
  - ссылка без сети с тем же параметром → конверсий нет;
  - покупки: первая — цель 2, следующие — 3, метки копируются из параметра; возвращённая, тестовая
    и неотлежавшаяся не уходят; покупка позже 30 суток от `first_at` — нет; повторный проход не
    задваивает; после отправки первой следующая остаётся «3», а не становится «2»;
  - путь переходника прежний: игрок по клику даёт ту же конверсию, что до задачи (`click_id`
    заполнен, `ad_conversion.network_params` пуст, метки берутся с клика) — все существующие тесты
    файла остаются без правок;
  - обнуление: у конверсии со `created_at` старше 31 суток `network_params` обнуляется, у свежей —
    нет; обнуление макросов клика работает как раньше.
- `apps/admin/test/links.test.ts`: `networkDirectState` — адрес есть → `ready`; цель `bot` →
  `needs_app`; адреса нет при цели `app` → `unavailable`; ответ списка со ссылкой сети и
  непустым `directUrl` разбирается, макросы в адресе остаются буквально; существующий тест «у
  ссылки сети прямой ссылки нет» переписать на новое правило (цель `bot` — `null`, цель `app` —
  адрес).

## Аналитика

Новых событий нет: запуск — сессия вида `link` (`start_kind = 'link'`, в `start_ref` код ссылки,
в `start_param` весь параметр с метками), конверсия — строка `ad_conversion` (`docs/24` §8,
`docs/22`, «Клики по ссылкам — таблица, а не события»). Метки сети лежат в `network_params`
не дольше 31 суток, значения в логи не пишутся (в логе постбэка уже стоит `redacted`).

## Настройки и окружение

Нет: токен конверсий, окна и паузы — прежние (`CONVERSION_WINDOWS`, `RETRY_DELAYS_MIN`),
переменных и ключей каталога не добавляется. Лимиты Telegram (512 и 64) — константы в коде
(`START_PARAM_MAX`), это не настройка, а правило площадки; строка в `docs/30` сообщает, где они.

## Документы

См. шаг 9: `docs/24` (§3.4, §3.5, §5), `docs/21`, `docs/29`, `docs/30`, `docs/33` §5.1.
Если тест границ слоёв или словарь потребует правки — в тех же файлах. `pnpm docs:check` —
в гейте.

## Критерии приёмки

- [ ] У ссылки сети с целью Mini App есть прямой адрес с `l-<код>`, `campaign`, `clickid` и
  `record` (последним), макросы в нём без кодирования; у ссылки сети с другой целью адреса нет
  и панель говорит почему.
- [ ] `l-<код>_…` разбирается в вид `link` с параметрами сети; нераспознанный хвост не теряет
  атрибуцию; неподставленные макросы отбрасываются.
- [ ] Длина параметра проверяется по каналу: Mini App — 512, бот — 64; колонки `start_param`
  расширены, миграция только добавляет, папка миграции одна, в описании PR — что таблицы не
  переписываются и план отката.
- [ ] Новичок по прямой ссылке, сыгравший засчитанный забег, даёт сети одну регистрацию; покупки —
  цели 2 и 3; повторный и параллельный проходы ничего не дублируют.
- [ ] Старый игрок и аккаунт команды — по тем же правилам, что у клика.
- [ ] Путь через переходник и все его тесты не изменились.
- [ ] Прямая ветка вынесена из `conversions.repository.ts` (файл не длиннее 300 строк).
- [ ] На карточке ссылки сети два адреса и подсказка; строки «только через переходник» нет.
- [ ] Документы из шага 9 обновлены; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(links): Прямая ссылка на Mini App для рекламы AdsGram`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРЯМАЯ ССЫЛКА НА MINI APP ДЛЯ РЕКЛАМЫ ADSGRAM**

  У ссылки закупки в AdsGram появился второй адрес — прямая ссылка на Mini App: модерация сети не видит переходника, AdsGram сам подставляет метки клика в стартовый параметр, а запуск по ссылке засчитывается ссылке и уходит сети конверсией, как через переходник.

  🛠 **Что важно**

  • переходник /r/<код> остаётся и работает как раньше
  • у прямой ссылки сервер не видит клика, только запуск — клики и расходы смотреть в кабинете сети
  • прямая ссылка для рекламы есть только у ссылок с целью Mini App
  • лимит стартового параметра Mini App теперь 512 знаков, бота — по-прежнему 64
  • откат ниже этой версии — только после чистки журнала прямых конверсий, подробности в PR

  ❓ **Нужно от команды**

  • @участник1 — вставить новый адрес в тестовое объявление AdsGram, пройти ссылку до забега от 30 секунд и убедиться, что конверсия есть в журнале ссылки
  ```
