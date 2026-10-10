---
id: T-0020
title: Бот говорит «идёт тест» и отвечает на обычное сообщение
epic: E5
priority: P1
status: in-progress
owner: claude-3 / sonnet-5.5
size: M
depends_on: []
zones:
  - backend/api/src/platforms/telegram/welcome-texts.ts
  - backend/api/src/platforms/telegram/bot-profile-texts.ts
  - backend/api/src/platforms/telegram/bot-commands.ts
  - backend/api/src/platforms/telegram/bot-router.ts
  - backend/api/src/platforms/telegram/bot-fallback.ts
  - backend/api/src/platforms/telegram/welcome.command.ts
  - backend/api/src/platforms/telegram/welcome.module.ts
  - backend/api/test/bot-fallback.test.ts
  - backend/api/test/bot.test.ts
  - backend/api/test/bot-commands.test.ts
  - backend/api/test/welcome.test.ts
  - backend/api/test/bot-profile.test.ts
shared:
  - packages/app-shell/src/i18n/ru.json
  - docs/28-diagnostics.md
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
---

# T-0020. Бот говорит «идёт тест» и отвечает на обычное сообщение

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0020.json)](README.md#значки-статуса)

## Зачем

Новые игроки приходят из поста в канале, где игру зовут на тест. Бот говорит им
другое:
- везде называет игру «закрытым тестом»;
- в `/help` отправляет «в чат теста», хотя ссылки на этот чат нет;
- на обычное сообщение («привет», «как играть?», «не работает») молчит.

Человек пишет боту и не получает ответа — это худшее первое впечатление.

## Решения

Решения пользователя от 06.10.2026:

- **Вместо «закрытого теста» — «идёт тест, игра обновляется».** Как в посте:
  игра на тесте, часто меняется, отзывы на неё влияют. Слова «закрытый» в
  текстах для игрока нет.
- **С вопросами и багами бот зовёт в два места:**
  - форма в игре: «Настройки» → «Написать разработчикам»;
  - новости разработки — канал @KennixDev.
- **На обычное сообщение бот отвечает подсказкой и кнопкой «Играть»,** не чаще
  раза в 10 минут одному игроку. Пересылать сообщения команде не нужно.

Решения тимлидов:

- **Ответ — только в личном чате и только на текст.** В группах, в том числе в
  чатах команды, бот на обычные сообщения не отвечает. Служебные сообщения без
  текста (оплата, разрешение писать, стикеры, фото) тоже без ответа.
- **Ответ на обычное сообщение — последний обработчик маршрутизатора.** Он
  срабатывает, только если ни один обработчик не взял обновление. Порядок
  регистрации модулей для этого ненадёжен, поэтому у маршрутизатора появляется
  отдельный обработчик «по умолчанию».
- **Нет Redis — ответа нет.** Без счётчика окна бот отвечал бы на каждое
  сообщение, а молчать безопаснее, чем засыпать человека ответами.
- **Карточка `/start` не меняется,** `CARD_VERSION` не поднимается. Меняются
  только тексты сообщений: подпись под картинкой и подсказка в группе.

## Как сейчас

- `backend/api/src/platforms/telegram/welcome-texts.ts`:
  - строка 10 — комментарий «закрытый тест русскоязычный»;
  - строки 56–59 и 74–77 — подпись `caption` новичку: «добро пожаловать на
    закрытый тест «Рубежа»…» и «welcome to the Rubezh closed test…»;
  - строки 61 и 79 — `groupHint`: «Рубеж — игра закрытого теста…»;
  - строки 60 и 78 — `playButton`: «▶ Играть» и «▶ Play».

  Язык выбирает `languageOf(languageCode)` в том же файле: `ru` — для
  русского, украинского, белорусского, казахского и клиентов без языка,
  иначе `en`.
- `backend/api/src/platforms/telegram/bot-profile-texts.ts`:
  - строки 4–5 — комментарий;
  - строки 34 и 48 — последняя строка описания бота: «Идёт закрытый тест…» и
    «Closed test in progress…».

  Пределы Telegram — имя до 64, короткое описание до 120, описание до 512
  знаков — проверяет `backend/api/test/bot-profile.test.ts`.
- `backend/api/src/platforms/telegram/bot-commands.ts:124-137` — `helpText`:
  первая строка «Рубеж — бот закрытого теста.», последняя для не-администратора —
  «Вопрос или баг — напишите команде в чат теста.»
- `backend/api/src/platforms/telegram/bot-router.ts:37-68` — `BotRouter`:
  - обработчики вызываются по порядку регистрации до первого, вернувшего `true`;
  - упавший обработчик логируется событием `handler_failed`, и разбор
    обновления на этом заканчивается.

  Обработчика «по умолчанию» нет.
- `backend/api/src/platforms/telegram/welcome.command.ts:284-289` — приватный
  `playButton(text)`:
  - `web_app` с `config.telegram.webAppUrl`, если адрес HTTPS;
  - иначе ссылка `identity.miniAppLink`;
  - иначе `null`.

  Такая же кнопка нужна ответу на обычное сообщение.
- `RedisWelcomeCardCache.claimStart` в том же файле — пример окна через
  `SET … NX EX` в Redis.
- `backend/api/src/platforms/telegram/welcome.module.ts` — модуль
  приветствия. Он импортирует `BotModule`, где `BotRouter`; `BotIdentity` и
  `TELEGRAM_BOT_API` даёт `TelegramModule`.
- Отправка сообщения с кнопками —
  `api.sendMessage(chat, text, signal, { keyboard: InlineButton[][] })`
  (`telegram-bot-api.ts:287`).
- Тексты для игрока в клиенте тоже говорят о «закрытом тесте»
  (`packages/app-shell/src/i18n/ru.json`):
  - строка 198 — `rating.soon`;
  - `feedback.intro`, около строки 283.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **Рефакторинг отдельным коммитом, поведение не меняется.** Из
   `welcome.command.ts` вынести кнопку в экспортируемую функцию того же файла:

   ```ts
   /** Кнопка запуска игры: `web_app` только по HTTPS, иначе ссылка на Mini App через бота, иначе кнопки нет. */
   export function playButtonFor(webAppUrl: string, miniAppLink: string | null, text: string): InlineButton | null;
   ```

   Приватный `playButton` в `StartCommand` зовёт её.
3. **`bot-router.ts`:**
   - метод `setFallback(handler: BotUpdateHandler): void`. Повторный вызов
     бросает `Error("Обработчик по умолчанию уже задан")`;
   - в `dispatch` — если ни один обработчик не вернул `true` и ни один не
     упал, вызвать `fallback.handle(update)` с той же обработкой ошибки
     (`handler_failed` с `handler: fallback.name`);
   - в `commands()` обработчик по умолчанию не участвует.
4. **Новый `backend/api/src/platforms/telegram/bot-fallback.ts`** — класс
   `BotFallbackReply implements BotUpdateHandler, OnModuleInit`:
   - `name = "fallback"`, команд нет;
   - зависимости: `APP_CONFIG`, `BotRouter`, `BotIdentity`, `TELEGRAM_BOT_API`
     (тип `Pick<TelegramBotApi, "sendMessage">`), `REDIS`;
   - `onModuleInit`: если `config.telegram.updates !== "off"` —
     `router.setFallback(this)`;
   - `handle(update)` возвращает `true` и ничего не отправляет, если не
     выполнено хотя бы одно условие:
     - `update.message` есть;
     - `message.text` — строка;
     - `message.from` есть и `from.is_bot !== true`;
     - `message.chat.type === "private"`;
   - окно: `SET bot:fallback:<from.id> 1 EX 600 NX` в Redis:
     - ключ уже был — `true`, без ответа;
     - Redis упал — лог `warn` с событием `fallback_window_unavailable` и
       `true`, без ответа;
   - язык — `languageOf(from.language_code)` из `welcome-texts.ts`;
   - текст — `FALLBACK_TEXTS[язык]`. Кнопка —
     `playButtonFor(config.telegram.webAppUrl, identity.miniAppLink, WELCOME_TEXTS[язык].playButton)`:
     - есть — `{ keyboard: [[кнопка]] }`;
     - нет — без клавиатуры;
   - после отправки — лог `log` с событием `fallback_replied` и полем
     `language`, формат как у `this.log` в `welcome.command.ts`;
   - `AbortController` на `onModuleDestroy`, как в `BotCommands`.

   Тексты — константа в том же файле:

   ```ts
   export const FALLBACK_TEXTS: Record<WelcomeLanguage, string> = {
     ru: [
       "Я бот игры «Рубеж» и переписку не читаю.",
       "",
       "Вопрос, баг или идея — напишите команде прямо в игре: «Настройки» → «Написать разработчикам». Новости разработки — в канале @KennixDev.",
     ].join("\n"),
     en: [
       "I'm the Rubezh game bot and I don't read messages.",
       "",
       "Questions, bugs or ideas — write to the team right in the game: «Настройки» → «Написать разработчикам» (the game is in Russian for now). Development news — @KennixDev.",
     ].join("\n"),
   };
   ```

   Окно 600 с — константа `FALLBACK_WINDOW_SEC = 600` с комментарием, почему
   10 минут: человек, который пишет несколько сообщений подряд, получает один
   ответ, а не по ответу на каждое.
5. **`welcome.module.ts`** — `BotFallbackReply` в `providers`.
6. **`welcome-texts.ts`:**
   - `ru.caption`, вариант без рекорда:
     ``${name}, добро пожаловать в «Рубеж»! Идёт тест: игра часто обновляется, а твои отзывы на неё влияют. Открывай кнопкой ниже.``;
   - `ru.groupHint`:
     `«Рубеж» — игра прямо в Telegram, сейчас на тесте. Открывается в личном чате с ботом: там же рекорд и место в рейтинге.`;
   - `en.caption`, вариант без рекорда:
     ``${name}, welcome to Rubezh! The game is in testing and updates often — your feedback shapes it. It opens with the button below and is in Russian for now.``;
   - `en.groupHint`:
     `Rubezh is a game right inside Telegram, now in testing. Open it in a private chat with the bot — your record and rank live there too.`;
   - комментарий строки 10: «закрытый тест русскоязычный» → «игра пока только
     на русском».

   Подпись с рекордом не меняется.
7. **`bot-profile-texts.ts`:**
   - последняя строка `ru.description`:
     `Идёт тест: игра часто обновляется, а отзывы игроков на неё влияют. Жми «Играть» или /start.`;
   - последняя строка `en.description`:
     `The game is in testing and updates often — players' feedback shapes it. Tap “Play” or /start.`;
   - комментарий строк 4–5: «закрытый тест русскоязычный» → «игра пока только
     на русском».

   Описание выходит около 333 и 358 знаков, в пределе 512.
8. **`bot-commands.ts`, `helpText`:**
   - первая строка:
     `«Рубеж» — игра прямо в Telegram. Идёт тест: игра часто обновляется, а отзывы игроков на неё влияют.`;
   - последняя строка для не-администратора:
     `Вопрос, баг или идея — напишите команде в игре: «Настройки» → «Написать разработчикам». Новости разработки — в канале @KennixDev.`

   Список команд и блок администратора не меняются.
9. **`packages/app-shell/src/i18n/ru.json`, только эти две строки:**
   - `rating.soon` → `Рейтинг среди друзей, сезоны и награды за места появятся к релизу.`;
   - `feedback.intro` → `Игра на тесте, и отзывы на неё влияют: скажи, что раздражает и чего не хватает. Ответы уходят команде разработки.`
10. **Документы** — раздел «Документы».

## Чего не трогаем

- Карточку `/start` (`welcome-card.ts`), её тексты на картинке и `CARD_VERSION`.
- Команды администратора и их описания: «Выгрузка данных закрытого теста» —
  текст для команды, не для игрока.
- `notifications-bot`: сообщение о версии убирает T-0019.
- Порт `Messenger` и рассылки.
- Тексты в `ru.json`, кроме двух строк шага 9.

## Сценарий и интерфейс

1. Новичок открывает бота по ссылке из поста. В пустом чате видит описание с
   последней строкой «Идёт тест: игра часто обновляется…».
2. Жмёт `/start` → карточка, под ней «…добро пожаловать в «Рубеж»! Идёт тест…»
   и кнопка «▶ Играть».
3. Пишет «привет» → ответ «Я бот игры «Рубеж» и переписку не читаю…» с кнопкой
   «▶ Играть».
4. Через минуту пишет «а как играть?» → тишина: окно 10 минут.
5. `/help` → первая строка про тест, список команд, внизу — где написать
   команде и @KennixDev.
6. В группе пишут обычное сообщение → бот молчит. `/start` в группе → подсказка
   без «закрытого теста».

## Тесты

Первым коммитом.

- `backend/api/test/bot.test.ts`, маршрутизатор:
  - обработчик по умолчанию получает обновление, только если ни один
    обработчик его не взял;
  - обработчик вернул `true` → по умолчанию не вызывается;
  - обработчик упал → по умолчанию не вызывается, в логе `handler_failed`;
  - `setFallback` дважды → ошибка;
  - `commands()` не включает обработчик по умолчанию.
- Новый `backend/api/test/bot-fallback.test.ts`. Подменный API пишет
  отправленное в массив, Redis — подмена с `set`, которую можно уронить.
  - личка, текст «привет», `language_code: "ru"`, `webAppUrl` HTTPS → одно
    сообщение: текст `FALLBACK_TEXTS.ru`, клавиатура
    `[[{ text: "▶ Играть", web_app: { url } }]]`;
  - тот же игрок второй раз в окне (`set` вернул `null`) → не отправляет;
  - другой игрок → отправляет;
  - `language_code: "en"` → `FALLBACK_TEXTS.en` и «▶ Play»;
  - чат `group` → не отправляет;
  - сообщение без текста (`successful_payment`, стикер) → не отправляет;
  - `from.is_bot: true` → не отправляет;
  - `set` бросает → не отправляет, `handle` не бросает;
  - `webAppUrl` `http://localhost` и `miniAppLink: null` → сообщение без
    клавиатуры;
  - `TELEGRAM_BOT_UPDATES=off` → `setFallback` не вызван.
- `backend/api/test/bot-commands.test.ts`:
  - ответ `/help` игроку начинается с ««Рубеж» — игра прямо в Telegram. Идёт тест»
    и содержит ««Настройки» → «Написать разработчикам»» и «@KennixDev»;
  - в нём нет «закрыт» и «чат теста»;
  - в чате администраторов строки про форму нет, как и раньше.
- `backend/api/test/welcome.test.ts`:
  - подпись новичку на русском содержит «Идёт тест» и не содержит «закрыт»;
  - на английском — «in testing» и не содержит «closed»;
  - подсказка в группе не содержит «закрыт»;
  - `playButtonFor`: HTTPS → `web_app`; HTTP со ссылкой → `url`; HTTP без
    ссылки → `null`.
- `backend/api/test/bot-profile.test.ts` — описание на обоих языках без
  «закрыт» и «Closed test»; пределы длины, как раньше.

## Аналитика

Событий продукта нет: бот не знает аккаунта игрока, а ответ — справка, а не
действие с игроком. Как часто игроки пишут боту, видно по структурному логу
`{ module: "bot", event: "fallback_replied", language }`. Пропуск по окну не
логируется: лог не должен расти с каждым сообщением.

## Настройки и окружение

Нет. Окно 600 с — константа `FALLBACK_WINDOW_SEC` в `bot-fallback.ts`.

## Документы

- `docs/28-diagnostics.md`, §6.1.2, список команд бота (около строк 600–627):
  - пункт `/help`: дописать, что в ответе первой строкой — что это за игра и
    что идёт тест, а внизу у игрока — где написать команде (форма в игре) и
    канал @KennixDev;
  - новый пункт после `/help`: «**Обычное сообщение** в личном чате — ответ
    «бот переписку не читает», куда писать команде и кнопка «Играть», не чаще
    раза в 10 минут одному человеку (`bot-fallback.ts`, ключ
    `bot:fallback:<id>`). В группах и на сообщения без текста бот не
    отвечает».
- `docs/21-diagrams.md` — новый раздел «4.23 Ответ бота на обычное сообщение
  (этап 4, реализовано)» после §4.22: sequence-диаграмма:
  - Игрок → Telegram → `BotRouter`: обработчики по порядку, никто не взял;
  - `BotRouter` → `BotFallbackReply`;
  - `SET bot:fallback:{id} NX EX 600` → Redis;
  - `alt` ключ уже был — без ответа, иначе `sendMessage` с кнопкой «Играть».

## Критерии приёмки

- [ ] В текстах бота для игрока нет «закрытого теста»: описание, подпись
  `/start`, подсказка в группе, `/help`.
- [ ] Обычное сообщение в личке получает ответ с кнопкой «Играть»; второе в
  течение 10 минут — нет; в группе и на служебные сообщения — нет.
- [ ] Обработчик по умолчанию срабатывает только после всех обработчиков:
  `/start`, `/help`, команды администраторов и оплата работают как раньше.
- [ ] Две строки `ru.json` клиента обновлены, других правок словаря нет.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Тексты «идёт тест» и ответ на сообщение`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- изменено [telegram]: Бот рассказывает, что игра на тесте и часто обновляется, и подсказывает, где написать команде.`
  - `- новое [telegram]: На обычное сообщение бот отвечает подсказкой и кнопкой «Играть».`
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — БОТ ГОВОРИТ «ИДЁТ ТЕСТ» И ОТВЕЧАЕТ**

  Бот больше не называет игру закрытым тестом и не молчит в ответ на сообщения. Новички из поста видят то же, что в посте: игра на тесте, часто обновляется, отзывы на неё влияют.

  🤖 **Что изменилось**

  • описание бота, подпись к /start, подсказка в группе и /help — «идёт тест» вместо «закрытого теста»
  • /help и ответ на обычное сообщение зовут в форму в игре («Настройки» → «Написать разработчикам») и на канал @KennixDev
  • на обычное сообщение в личке — подсказка и кнопка «Играть», не чаще раза в 10 минут; в группах бот молчит
  ```
