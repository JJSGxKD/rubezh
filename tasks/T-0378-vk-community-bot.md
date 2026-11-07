---
id: T-0378
title: Сообщество VK — бот сообщества связывает аккаунт и проверяет вступление
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0377]
zones:
  - backend/api/src/platforms/vk/**
  - backend/api/test/vk-callback.test.ts
  - backend/api/test/vk-channel-membership.test.ts
  - backend/api/test/vk-link-starter.test.ts
shared:
  - backend/api/src/modules/secrets/secret-catalog.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/infra/outbound/outbound-services.ts
  - backend/api/src/app.module.ts
  - docs/20-env-and-ports.md
  - docs/30-configuration-map.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 5
---

# T-0378. Сообщество VK — бот сообщества связывает аккаунт и проверяет вступление

## Зачем

Вторая половина заданий «вступите в сообщество VK» (Р188). Основа — связь
аккаунтов, код и проверка задания — сделана в T-0377. Здесь сообщество VK
становится ботом:
1. игрок Telegram открывает диалог сообщества по ссылке с кодом;
2. сообщество связывает его VK-id с игровым аккаунтом и присылает ссылку
   на сообщество;
3. сервер проверяет вступление через API VK.

## Решения

- **Р188** (`docs/35-stage4-plan.md`): бот VK служит росту сообщества, игру не
  портирует. От владельца — ключ сообщества VK, его вносят в «Ключи
  интеграций».
- **Р53, Р84** — токен внешнего сервиса хранится в каталоге ключей интеграций
  `secret-catalog.ts`. Панель сильнее `.env`, в базе только шифртекст. Не
  секрет и меняется без релиза — каталог настроек.

Уточнения `claude-lead-1` (по Р188, без нового продуктового выбора):

- **Приём событий — Callback API VK** (вебхук), а не Long Poll: сервер уже
  принимает вебхуки Telegram с очередью. Защита — поле `secret` в теле
  события, сравнение за постоянное время. Неверный `secret` — 401 без разбора.
- **Ссылка на бота:** `https://vk.me/<сообщество>?ref=<код>`. Когда игрок
  пишет первое сообщение (или жмёт «Начать»), событие `message_new` несёт поле
  `ref` с кодом и `from_id` — его VK-id.
- **Проверка вступления** — метод `groups.isMember` ключом сообщества.
  `group_id` — из настройки, `user_id` — связанный VK-id.
- **Ответ VK — строка `ok`** (для `confirmation` — строка подтверждения), не JSON
  `{ data }`: так требует Callback API. Это осознанное исключение из формата
  ответа, оно описано в комментарии контроллера.

## Как сейчас

- Основа — T-0377:
  - порт `platforms/ports/external-link.ts` (`ExternalLinkStarter`,
    `ExternalLinkStarters`);
  - `ExternalIdentityService.consume(platform, code, externalUserId)` →
    `linked | already | taken | expired`;
  - порт проверки — `platforms/ports/channel-membership.ts` (`ChannelMembership`,
    `MembershipUnavailableError`, `MembershipRejectedError`).
- Образец вебхука — `platforms/telegram/bot-webhook.controller.ts`:
  - `@Public()`, проверка секрета до разбора;
  - сначала очередь в Redis (`bot-update-queue.ts`), потом ответ;
  - повторы отсекаются по id обновления.
- Образец проверки подписки — `platforms/telegram/telegram-channel-membership.ts`.
- Каталог ключей — `backend/api/src/modules/secrets/secret-catalog.ts` (образец
  записи — `adsgramConversionToken` ~226: `key`, `service`, `title`, `hint`,
  `cabinetUrl`, `pattern`, `example`, `fromEnv`, `check`). Генерируемый секрет —
  `generated` (~239, `adsgramRewardSecret`). Каталог настроек —
  `modules/settings/setting-catalog.ts`.
- Исходящие запросы — только через клиент исходящих
  (`infra/outbound/outbound-services.ts`, `forService(…)`), имя сервиса — в
  `OUTBOUND_SERVICES`.
- Папки `platforms/vk/` нет: VK в бэкенде представлен только портами и
  `unsupported.ts`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Ключи и настройки:**
   - **ключи интеграций (`secret-catalog.ts`)**, сервис «VK»:
     - `vk.community-token` — «Ключ доступа сообщества VK».
       - подсказка: «Сообщество отвечает игрокам и проверяет вступление этим
         ключом. Права: сообщения сообщества, управление. Без ключа задания
         «вступите в сообщество» никому не видны.»;
       - `cabinetUrl: "https://vk.com/groups?tab=admin"`;
       - `pattern` — печатные знаки без пробелов, 32–512;
       - `fromEnv: () => null`;
       - `check` — вызов `groups.getById` этим ключом;
     - `vk.callback-secret` — генерируемый (`generated`), 32–64 знака
       `[A-Za-z0-9]`. `reveal` показывает адрес вебхука и этот секрет,
       `where`: «Управление сообществом → Работа с API → Callback API: адрес и
       секретный ключ»;
     - `vk.callback-confirmation` — строка, которую VK показывает в настройках
       Callback API («Строка, которую должен вернуть сервер»), до 32 знаков.
   - **настройка (`setting-catalog.ts`)** `vk.community` — короткое имя
     сообщества или `club<id>`, по умолчанию пусто. Подсказка: «Сообщество VK
     для заданий: игрок вступает в него, бот пишет от его имени».
3. **`platforms/vk/vk-api.ts`** — клиент методов:
   - запросы через `outbound.forService("vk.api")`: имя добавить в
     `OUTBOUND_SERVICES`;
   - адрес `https://api.vk.com/method/<метод>`, `v` — константа версии API в
     этом файле, ключ — в теле, не в адресе;
   - таймаут 5 с;
   - ответ разбирается Zod-схемой: `response` или `error { error_code, error_msg }`;
   - методы: `isMember(groupId, userId): boolean` (`groups.isMember`),
     `sendMessage(userId, text, keyboard?)` (`messages.send`, `random_id` —
     случайный int32);
   - ошибки:
     - сети и 5xx → `MembershipUnavailableError` (для проверки);
     - ошибки доступа VK (неверный ключ, нет прав, сообщество не найдено) →
       `MembershipRejectedError`.
     Коды сверить с документацией VK на дату работы и перечислить в константе с
     комментарием.
4. **`platforms/vk/vk-callback.controller.ts`** — `POST /api/v1/vk/callback`,
   `@Public()`:
   - нет ключа сообщества или секрета → 404 (`DisabledError`, как у выключенного
     вебхука Telegram);
   - тело — Zod: `{ type, group_id, secret?, event_id?, object? }`, лишнее
     разрешено (VK шлёт много полей);
   - `secret` не совпал (постоянное время) → 401 без разбора дальше;
   - `type: "confirmation"` и `group_id` совпал с настройкой → ответ — текст
     `vk.callback-confirmation`;
   - `type: "message_new"` → в очередь Redis (по образцу `bot-update-queue.ts`,
     свой ключ очереди, повторы отсекаются по `event_id`) → ответ `ok`. Redis
     недоступен → 503, VK повторит;
   - прочие типы → `ok` без обработки;
   - ответ — `text/plain` `ok`, а не `{ data }` (решения).
5. **`platforms/vk/vk-updates.worker.ts`** — разбор `message_new`:
   - `object.message.ref` — код, `object.message.from_id` — VK-id;
   - нет `ref` → ответ «Чтобы связать аккаунт, откройте задание в игре и нажмите
     «Открыть сообщество VK»»;
   - есть → `consume("vk", ref, String(from_id))` → ответ по исходу:
     - `linked` — «Готово! Аккаунт VK связан с игрой. Вступите в сообщество
       и вернитесь в игру — нажмите «Проверить».» + ссылка
       `https://vk.com/<сообщество>`;
     - `already` — «Аккаунт уже связан. Вступите в сообщество и нажмите
       «Проверить» в игре.» + ссылка;
     - `taken` — «Этот аккаунт VK уже связан с другим игроком. Связать его второй
       раз нельзя.»;
     - `expired` — «Ссылка устарела. Откройте задание в игре и нажмите «Открыть
       сообщество VK» ещё раз.»;
   - ошибка отправки ответа — лог, повтора нет: связь уже записана.
6. **`platforms/vk/vk-channel-membership.ts`** — `ChannelMembership` для `vk`:
   `isMember(chat, userId)` → `vkApi.isMember(chat, userId)`. `chat` — то, что
   в задании (`params.chat`): короткое имя или id сообщества.
7. **`platforms/vk/vk-link-starter.ts`** — `ExternalLinkStarter` для `vk`:
   - `startUrl(code)` → `https://vk.me/<vk.community>?ref=<code>`;
   - `null`, если нет ключа сообщества или настройки `vk.community`.
8. **`platforms/vk/vk.module.ts`**:
   - регистрирует контроллер, воркер, адаптеры в `ChannelMemberships` и
     `ExternalLinkStarters` (провайдеры T-0377);
   - подключается в `app.module.ts`;
   - модули домена адаптер не импортируют: только порты (`CLAUDE.md`, границы
     слоёв; проверяет `layer-boundaries.test.ts`).
9. **Документы** — раздел «Документы».

## Чего не трогаем

- **Основа (T-0377):** связь, код, задания, клиент.
- **Бот MAX** — T-0379.
- **Вход и игра во VK:** порт игры на VK — этап 8+ (`02-roadmap.md`).
- **Перепроверка отписки во VK** — отдельной задачей после T-0178.

## Сценарий и интерфейс

Сообщения сообщества — тексты дословно из шагов 5. Ссылки — отдельной строкой.
Если у сообщества включены кнопки — кнопка-ссылка «Перейти в сообщество».
Включены ли кнопки, исполнитель проверяет по документации VK, без своего выбора
оформления.

Панель — «Ключи интеграций», сервис «VK»: три ключа с подсказками и проверкой
первого. Плюс настройка `vk.community` в разделе «Настройки».

## Тесты

Первым коммитом, до кода. Сеть — подмена `fetch`, Redis — живой, как у соседних
вебхуков.

- `backend/api/test/vk-callback.test.ts`:
  - **выключено:** нет ключа или секрета → 404;
  - **секрет:**
    - неверный `secret` → 401, в очередь ничего не попало;
    - секрет другой длины → 401 без исключения;
  - **confirmation:**
    - с верным `group_id` → тело ровно строка подтверждения;
    - с чужим `group_id` → 401;
  - **message_new:**
    - → `ok` (text/plain), событие в очереди;
    - тот же `event_id` дважды → в очереди одно;
  - **Redis недоступен** → 503;
  - **воркер:**
    - `ref` с действующим кодом → `consume` с `"vk"` и `from_id` строкой, ответ
      «Готово!…» со ссылкой;
    - `taken`, `expired`, без `ref` — свои тексты дословно.
- `backend/api/test/vk-channel-membership.test.ts`:
  - ответ `1` → `true`, `0` → `false`;
  - ошибка доступа VK → `MembershipRejectedError`;
  - 5xx и таймаут → `MembershipUnavailableError`;
  - ключ не попадает в адрес запроса и в лог.
- `backend/api/test/vk-link-starter.test.ts`:
  - есть ключ и настройка → `https://vk.me/<имя>?ref=<код>`;
  - нет любого из двух → `null`.

## Аналитика

Нет новых событий: связь пишет `external_account_linked` (T-0377).
Prometheus — `vk_callback_total{type,result}`, низкая кардинальность.

## Настройки и окружение

- Ключи интеграций: `vk.community-token`, `vk.callback-secret` (генерируется),
  `vk.callback-confirmation`.
- Настройка: `vk.community`.
- Переменных окружения нет: ключи только из панели, как у AdsGram.

## Документы

- `docs/30-configuration-map.md` — ключи и настройка VK, где менять.
- `docs/20-env-and-ports.md` — адрес вебхука `/api/v1/vk/callback` в списке
  публичных маршрутов, если он там ведётся.
- `docs/35-stage4-plan.md` — Р188 «Как сделано»: VK.

## Критерии приёмки

- [ ] Вебхук отвергает событие без верного секрета и принимает подтверждение
  сервера только для своего сообщества.
- [ ] Игрок по ссылке с кодом получает связь аккаунта и ссылку на сообщество; повтор,
  чужой и протухший код — свои ответы.
- [ ] Вступление проверяется `groups.isMember` по связанному VK-id; ошибки
  доступа — «настройка задания», сети — «позже».
- [ ] Ключ сообщества не попадает в адреса и логи.
- [ ] Адаптер подключён только через порты, `layer-boundaries.test.ts` зелёный.
- [ ] Гейт и `pnpm docs:check` зелёные. В PR — чек-лист `docs/15` §7 (вебхук,
  секреты) и §8.

## PR

- **Заголовок:** `feat(vk): Сообщество VK связывает аккаунт и проверяет вступление`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: задание «вступите в сообщество VK» с наградой — откройте его во вкладке «Партнёры»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СООБЩЕСТВО VK В ЗАДАНИЯХ**

  Сообщество VK стало ботом для заданий: игрок открывает диалог сообщества по ссылке из задания, сообщество связывает его VK с игрой и присылает ссылку, а сервер проверяет вступление.

  🛠 **Что внутри**

  • вебхук Callback API с секретом, события через очередь
  • проверка вступления — groups.isMember по связанному VK-id
  • ключи — в «Ключах интеграций», сообщество — в «Настройках»

  ❓ **Нужно от команды**

  • @владелец — создать ключ сообщества, вставить адрес и секрет Callback API из панели в настройки сообщества и завести задание «вступите в сообщество» в разделе заданий
  ```
