---
id: T-0026
title: Команды /paysupport и /terms в боте
epic: E1
priority: P1
status: draft
owner:
size: S
depends_on: []
zones:
  - backend/api/src/platforms/telegram/pay-support.command.ts
  - backend/api/src/platforms/telegram/pay-texts.ts
  - backend/api/src/platforms/telegram/bot.module.ts
  - backend/api/test/pay-support.test.ts
shared:
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/28-diagnostics.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
---

# T-0026. Команды /paysupport и /terms в боте

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0026.json)](README.md#значки-статуса)

## Зачем

Бот продаёт цифровые товары за звёзды. По правилам Telegram для таких ботов
он обязан отвечать на `/paysupport` — куда идти с вопросом об оплате. Условия
покупок (`/terms`) нужны, чтобы игрок знал заранее:
- что он покупает;
- что игра на тесте;
- что будет при возврате звёзд.

Сейчас обеих команд нет. Оплата выключена, и до её включения это нужно
закрыть.

## Решения

Решения пользователя от 06.10.2026:

- **`/paysupport` ведёт на контакт поддержки из панели.** Это новая
  настройка «Поддержка по оплатам» — ссылка `https://t.me/…`. Пока она не
  задана, бот зовёт в форму в игре. Юзернейм в репозиторий не попадает: он
  живёт в базе, его вводят в панели.
- **Текст `/terms` пишут тимлиды, утверждает пользователь.** Текст — в шаге 3.
  Пока он не утверждён, у задачи статус `draft`.

Решения тимлидов:

- **Команды видны всем** в меню Telegram и в `/help`, рядом с `/start` и
  `/help`. Они попадают туда сами из `commands` обработчика.
- **Обе команды отвечают в любом чате,** в том числе в группе. Текст одинаков
  для всех, личных данных в нём нет.
- **Язык один — русский,** как у `/help`. Игра пока только на русском.

## Как сейчас

- **Команды бота** — обработчики `BotUpdateHandler` с полем `commands`,
  регистрируются в `BotRouter` в `onModuleInit`. Образец — `BotCommands`
  (`platforms/telegram/bot-commands.ts`):
  - разбор `/help(@\w+)?(\s|$)`;
  - ответ `api.sendMessage({ chatId, threadId }, text, signal)`;
  - `AbortController` на `onModuleDestroy`.
- **Каталог настроек** — `backend/api/src/modules/settings/setting-catalog.ts`:
  - вид `"url"` и схема `urlSchema`: только https или пусто;
  - образец — `shopTributeUrl` (строки 182–191), группа `SHOP_GROUP`.
- **Чтение настройки:**
  `@Inject(SETTINGS_READER) private readonly settings: SettingsReader`, затем
  `this.settings.get(SETTINGS.<имя>)` — как в `ads.service.ts:154` и `:219`.
- **`bot.module.ts`** — модуль бота. В нём `BotRouter` и `BotCommands`, которой уже
  доступен `TELEGRAM_BOT_API`. `SettingsModule` глобальный, `SETTINGS_READER`
  внедряется без импорта.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **`setting-catalog.ts`**, в группе `SHOP_GROUP` после `shopTributeUrl`:

   ```ts
   supportPaymentsUrl: {
     key: "support.payments-url",
     group: SHOP_GROUP,
     title: "Поддержка по оплатам",
     hint: "Куда /paysupport ведёт с вопросом об оплате — ссылка https://t.me/… на аккаунт поддержки. Пусто — бот зовёт в форму «Написать разработчикам» в игре",
     kind: "url",
     schema: urlSchema,
     fromEnv: () => null,
     fallback: "",
   } satisfies SettingDefinition<string>,
   ```
3. **Новый `platforms/telegram/pay-texts.ts`** — тексты ответов. `TERMS_TEXT`
   задан дословно, менять его без решения пользователя нельзя:

   ```ts
   /** Ответ /paysupport: `contact` — ссылка из настройки «Поддержка по оплатам», `null` — не задана. */
   export function paySupportText(contact: string | null): string {
     const where = contact === null
       ? "напишите команде прямо в игре: «Настройки» → «Написать разработчикам»"
       : `напишите в поддержку: ${contact}`;
     return [
       "Вопрос об оплате в «Рубеже»?",
       "",
       `Если звёзды списались, а покупка не пришла, или что-то не так с подпиской VIP, ${where}.`,
       "Опишите, что купили и когда, — так мы быстрее найдём покупку.",
       "",
       "Условия покупок — /terms.",
     ].join("\n");
   }

   export const TERMS_TEXT = [
     "Условия покупок в «Рубеже»",
     "",
     "1. Что покупается. За звёзды Telegram продаются игровые ценности: самоцветы, наборы самоцветов и подписка VIP. Это цифровые товары только для игры: на деньги они не обмениваются и другим игрокам не передаются.",
     "",
     "2. Игра на тесте. Баланс, цены и содержимое магазина могут меняться. Если перед релизом прогресс придётся обнулить, купленное за звёзды не пропадёт: журнал покупок не стирается, и по нему мы вернём всё купленное.",
     "",
     "3. Выдача. Покупка приходит сразу после оплаты. Если выдать её не удалось, игра повторит выдачу сама, а если товар выдать нельзя — вернёт звёзды.",
     "",
     "4. Подписка VIP продлевается каждые 30 дней, пока вы её не отмените — в игре или в настройках Telegram. Отмена действует со следующего периода: оплаченный остаётся.",
     "",
     "5. Возврат звёзд. Если вы вернули звёзды за покупку через Telegram, мы забираем то, что от неё осталось, а новые покупки закрываются до проверки командой.",
     "",
     "6. Вопросы об оплате — /paysupport.",
   ].join("\n");
   ```
4. **Новый `platforms/telegram/pay-support.command.ts`** — класс
   `PaySupportCommands implements BotUpdateHandler, OnModuleInit, OnModuleDestroy`:
   - `name = "pay-support"`;
   - `commands`:

     ```ts
     [
       { command: "paysupport", description: "Вопрос об оплате", descriptionEn: "Payment support", audience: "everyone" },
       { command: "terms", description: "Условия покупок", descriptionEn: "Terms of purchase", audience: "everyone" },
     ]
     ```

   - зависимости: `APP_CONFIG`, `BotRouter`, `SETTINGS_READER`, `TELEGRAM_BOT_API`
     (тип `Pick<TelegramBotApi, "sendMessage">`);
   - `onModuleInit`: если `config.telegram.updates !== "off"` — `router.register(this)`;
   - `handle(update)`:
     - нет `message.text`, или `message.from` пуст, или `from.is_bot` → `false`;
     - `/paysupport(@\w+)?(\s|$)` → ответ `paySupportText(url === "" ? null : url)`,
       где `url = settings.get(SETTINGS.supportPaymentsUrl)`. Возвращает `true`;
     - `/terms(@\w+)?(\s|$)` → ответ `TERMS_TEXT`, возвращает `true`;
     - иначе `false`;
   - ответ в тот же чат и тему: `{ chatId, threadId: message.message_thread_id ?? null }`.
5. **`bot.module.ts`** — `PaySupportCommands` в `providers`, рядом с `BotCommands`.
6. **Документы** — раздел «Документы».

## Чего не трогаем

- `BotCommands` и `/help`: новые команды попадают в список сами, из `commands`.
- Оплату, проверку оплаты и выдачу.
- Ответ на обычное сообщение — T-0020.

## Тесты

Первым коммитом, новый `backend/api/test/pay-support.test.ts`. Подменный API
пишет отправленное в массив, `SettingsReader` — подмена с заданным значением.

- `/paysupport` в личке, настройка пуста → текст `paySupportText(null)`: в нём
  ««Настройки» → «Написать разработчикам»» и «/terms»;
- настройка `https://t.me/rubezh_support` → в тексте эта ссылка, формы нет;
- `/paysupport@rubezh_bot` в группе → ответ в тот же чат и тему;
- `/terms` → ровно `TERMS_TEXT`;
- `/paysupportx`, `/term`, обычный текст → `handle` вернул `false`, ничего не
  отправлено;
- `from.is_bot: true` → `false`;
- `commands` — две команды для всех с русскими и английскими описаниями;
- `TERMS_TEXT.length` и `paySupportText(<ссылка в 256 знаков>).length` ≤ 4096 —
  предел сообщения Telegram;
- `TELEGRAM_BOT_UPDATES=off` → `register` не вызван.

Каталог настроек: `support.payments-url` принимает `https://t.me/x` и пустую
строку, отклоняет `http://t.me/x`. Кейс — по образцу соседних в тесте
каталога, если он есть; если нет — в этом же файле.

## Аналитика

Нет: справочные ответы бота. Как часто их просят, видно по логам бота.

## Настройки и окружение

- Новый ключ каталога настроек `support.payments-url` — «Поддержка по
  оплатам», группа «Магазин», без окружения. После мерджа его задают в панели.

## Документы

- `docs/28-diagnostics.md` §6.1.2, список команд бота: новые пункты
  «**`/paysupport`** — куда с вопросом об оплате: контакт из настройки
  «Поддержка по оплатам» или форма в игре» и «**`/terms`** — условия покупок,
  текст в `platforms/telegram/pay-texts.ts`; правится только по решению
  пользователя».
- `docs/30-configuration-map.md` — строка «Поддержка по оплатам: куда ведёт
  /paysupport» → панель, раздел «Настройки», группа «Магазин», ключ
  `support.payments-url`.

## Критерии приёмки

- [ ] `/paysupport` отвечает контактом из панели, а без него — формой в игре.
- [ ] `/terms` отвечает утверждённым текстом дословно.
- [ ] Обе команды видны в меню Telegram и в `/help` у всех.
- [ ] Ключ `support.payments-url` есть в панели, в группе «Магазин».
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Команды /paysupport и /terms`
- **Метка:** `release: minor`
- **Для игроков:** `- новое [telegram]: В боте есть команды /paysupport — вопрос об оплате — и /terms — условия покупок.`
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — /PAYSUPPORT И /TERMS В БОТЕ**

  У бота появились команды, которые Telegram требует от тех, кто продаёт цифровые товары: /paysupport — куда идти с вопросом об оплате, и /terms — условия покупок.

  💳 **Что изменилось**

  • /paysupport ведёт на контакт из новой настройки панели «Поддержка по оплатам», а пока её нет — в форму в игре
  • /terms — условия покупок: что покупается, что игра на тесте, как работают выдача, подписка и возврат звёзд

  ❓ **Нужно от команды**

  • @участник1 — задать в панели «Поддержка по оплатам» ссылку на аккаунт поддержки
  ```
