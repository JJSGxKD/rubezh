---
id: T-0402
title: Итог сезона оформленным сообщением и конец сезона — временем в поясе читателя
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0394, T-0255, T-0256]
zones:
  - backend/api/src/modules/notifications-bot/bot-notify-rich.ts
  - backend/api/test/bot-notify-rich.test.ts
  - backend/api/test/telegram-messenger-rich-image.test.ts
shared:
  - backend/api/src/modules/notifications-bot/bot-notify-sender.ts
  - backend/api/src/modules/notifications-bot/bot-notify-texts.ts
  - backend/api/src/platforms/ports/messenger.ts
  - backend/api/src/platforms/telegram/telegram-messenger.ts
  - backend/api/test/notifications-bot-policy.test.ts
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: null
batch: 5
---

# T-0402. Итог сезона оформленным сообщением и конец сезона — временем в поясе читателя

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0402.json)](README.md#значки-статуса) [![T-0394](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0394.json&label=T-0394)](T-0394-rich-message-port.md) [![T-0255](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0255.json&label=T-0255)](T-0255-reminders-with-images.md) [![T-0256](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0256.json&label=T-0256)](T-0256-season-result-message.md)

## Зачем

После T-0256 итог недели приходит в бота картинкой с подписью. После этой
задачи под картинкой — таблица «место · из скольких · лучшее · награда»,
раскрывающийся блок «Как считается место» и строка «Следующая неделя
закончится …» временем в поясе читателя. Напоминание «Сезон закрывается»
тоже называет время в поясе читателя, а не «по Москве» (Р199, сценарии
«Итог сезона» и «Сезон закрывается»). На MAX и VK, со старым клиентом и при
выключенных ключах — прежний текст.

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, сценарии «Итог сезона» и «Сезон
  закрывается», правила 1, 5, 6, 8, 9):
  - оформленное сообщение — только при включённых `bot.formats.enabled` и
    `bot.rich.enabled` (решает `BotMessages.compose`, T-0394);
  - время — сущность `date_time` (`dateTime` в `RichDocument`), запасной
    текст — прежний «по Москве»;
  - итог сезона — сообщение, которое бот пишет сам: в тихие часы ждёт их
    конца. Это уже делает `BotMessagePolicy` в дубле уведомлений (T-0394,
    шаг 7), здесь — только тест. Сезон закрывается в 03:00 МСК, итог
    приходит в 10:00;
  - только настоящие числа: место, размер доски, лучшее, награда из данных
    T-0256; без «сгорит» и «последний шанс».
- **Картинка и оформление вместе.** Решения тимлида (технические):
  - картинка T-0255/T-0256 — первым фото-блоком оформленного сообщения;
    решает адаптер Telegram по паре `image` + `rich` у `OutgoingMessage`.
    Домен картинку в документ не кладёт: `file_id` ему неизвестен;
  - `file_id` берётся из кэша по `image.key`; нет — PNG загружается в том же
    `sendRichMessage` (`InputFile`): у каждого игрока своя картинка;
  - отказ Telegram на оформленном сообщении с картинкой → путь T-0255:
    картинка с подписью `text`;
  - кнопка — та же, что у T-0256 («Забрать награды» или «▶ Играть»),
    клавиатурой под сообщением. В документе она не повторяется: два
    одинаковых адреса под одним сообщением путают.
- **Формат времени** — `wDt`: день недели, дата длинной формой, время без
  секунд (`core.telegram.org/bots/api`, «Date-time entity formatting»).
- **«Следующая неделя закончится»** — конец текущего сезона на момент
  отправки, `seasonOf(now).endsAt` (`seasons/season-rules.ts`). Итог
  приходит уже в новой неделе, это её конец.

## Как сейчас

- `modules/notifications-bot/bot-notify-texts.ts`:
  - `botMessageOf(kind, payload, launch)` → `{ text, button }`;
  - `season_closing` — строки 69–73: «…закрывается завтра в ЧЧ:ММ по
    Москве…», время — `moscowTime(endsAt)`, данные —
    `NOTIFICATION_KINDS.season_closing` (`{ endsAt }`, ISO).
- После T-0256:
  - вид уведомления `season_result` — данные, правило дубля, текст и
    картинка;
  - данные — схема `NOTIFICATION_KINDS.season_result`
    (`modules/notifications/notification-kinds.ts`): место, размер доски,
    награда и лучший результат недели.

  **Сверь имена полей после влития T-0256.** Если лучшего результата в данных
  нет, ряда «Лучшее» в таблице нет. Добавлять поля в схему вида эта задача не
  будет — вопрос в PR.
- После T-0255:
  - `OutgoingMessage.image: { key, render: () => Buffer }`;
  - Telegram шлёт фото из кэша `file_id` по `key` или рисует и загружает;
  - нет картинки или фото не ушло — текст.
- После T-0394:
  - `BotMessages.compose(doc, { button, action?, topic? })` → `OutgoingMessage`
    с `text = plainTextOf(doc)` и `rich` при включённых ключах;
  - отправитель дубля (`bot-notify-sender.ts`) получил `policy` и `events`
    последними `@Optional()`-параметрами, T-0398 — `routes`;
  - `telegram-messenger.ts` шлёт `rich` через `rich.sendRichMessage`, отказ
    400/404 — простым текстом и `fallback: true`;
  - `toTelegramRich` — `platforms/telegram/telegram-rich-render.ts`.
- Тип фото-блока Telegram — `InputRichBlockPhoto<F>` в `@grammyjs/types`
  5.0.0 (`rich.d.ts`): `{ type: "photo", photo: InputMediaPhoto<F>, caption? }`.
  `InputRichMessage<InputFile>` допускает загрузку файла в `sendRichMessage`.
- Правила наград для блока «Как считается место» — `seasons/season-rules.ts`:
  `MIN_BOARD` (10), `PLACE_LADDER` (последнее награждаемое место — 50).

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`modules/notifications-bot/bot-notify-rich.ts`** — чистая функция
   `botRichOf(kind: string, payload: unknown, now: Date): RichDocument | null`.
   Данные разбираются схемой вида; не по схеме или вид без оформления →
   `null`.
   - **`season_closing`** — один абзац из трёх частей:
     - «Недельный сезон «Рубежа» закрывается »;
     - `dateTime` с `unix` = `endsAt` в секундах, `format: "wDt"`,
       `fallback` — `завтра в ${moscowTime(endsAt)} по Москве`;
     - «. Награды за порог и за место получат те, кто попал в таблицу, —
       успей улучшить результат.»

     `plainTextOf` документа обязан совпасть с прежним текстом слово в
     слово. `moscowTime` — экспорт из `bot-notify-texts.ts` (сделать
     экспортируемым, тело не менять).
   - **`season_result`**:
     - заголовок — `Неделя закрыта — ${place}-е место`;
     - таблица без заголовка, два столбца:
       - «Место» — `${place} из ${boardSize}`;
       - «Лучшее» — очки с пробелом между тысячами или время
         `formatDuration`, по данным T-0256; данных нет — ряда нет;
       - «Награда» — `1 000 монет, 100 престижа`, слова по числу
         (`pluralRu`); награды нет — ряда нет;
     - `details` со сводкой «Как считается место», два абзаца:
       - «Место — по лучшему забегу недели на «Сложной»: тот же счёт, что в
         таблице сезона в игре.»;
       - `Награду за место получают первые ${последнее toPlace PLACE_LADDER} мест, если на доске не меньше ${MIN_BOARD} игроков. Остальным, кто дотянул до порога недели, — награда за участие.`;
     - абзац — «Следующая неделя закончится » и `dateTime`
       (`unix` = `seasonOf(now).endsAt` в секундах, `format: "wDt"`,
       `fallback: "в понедельник, 03:00 по Москве"`).
   - Числа — только из данных и правил; `plainTextOf(season_result)` не
     длиннее 1 000 знаков: отказ оформления уходит подписью к картинке, у
     подписи предел 1 024.
3. **`bot-notify-sender.ts`**:
   - `@Optional() composer?: BotMessages` — последним параметром;
   - после сборки `message` (текст, кнопка, `action`, `image` T-0255) и до
     `claim`: `doc = botRichOf(job.kind, job.payload, now)`;
   - `doc` есть и `composer` есть →
     `message = { ...message, ...composer.compose(doc, { button: message.button, action: message.action }) }`.
     `image` и `action` остаются, `text` — простой текст документа;
   - `format` в `events.sent`:
     - `rich` — у сообщения был `rich` и исход не `fallback`;
     - `photo` — была картинка, оформление не ушло;
     - иначе `text`.
4. **`ports/messenger.ts`** — комментарий у `rich`: «есть и `image` —
   площадка с оформлением ставит картинку первым фото-блоком; отказ
   оформления — картинка с подписью `text`». Типы не меняются.
5. **`telegram-messenger.ts`** — `rich` и `image` вместе:
   - первым блоком перед `toTelegramRich(rich)` —
     `{ type: "photo", photo: { type: "photo", media } }`;
   - `media` — `file_id` из кэша по `image.key` (тот же кэш, что у пути
     T-0255); нет — `new InputFile(image.render(), "card.png")`. Кэш здесь не
     пополняется;
   - отказ 400/404 на оформленном → путь T-0255 (фото с подписью
     `message.text`); не ушло фото → текст, как у T-0255. Итог —
     `{ status: "sent", fallback: true }`;
   - `rich` без `image` и `image` без `rich` — как после T-0394 и T-0255.

## Чего не трогаем

- Закрытие сезона, выбор получателей и картинку итога — T-0256.
- Прежние тексты `bot-notify-texts.ts`: запасной текст обязан совпадать с
  ними.
- Правила напоминаний T-0128: окно, пропуск в тихие часы, кнопка «Не
  напоминать».
- `BotMessagePolicy` — только тест, что итог ждёт 10:00.
- Темы в личке — T-0406.

## Сценарий и интерфейс

Игрок в Telegram, бот нового поколения включён:

1. **Воскресенье вечером** — напоминание «Недельный сезон «Рубежа»
   закрывается пн, 16 ноября 2026 г., 03:00. Награды…». Время — в поясе
   читателя: у игрока в Новосибирске — 07:00. Кнопки «▶ Открыть игру» и
   «🔕 Не напоминать» — как раньше.
2. **Понедельник, 10:00 МСК** — итог недели:
   - картинка T-0256;
   - «Неделя закрыта — 14-е место»;
   - таблица «Место 14 из 230 · Лучшее 12 480 · Награда 250 монет, 10
     престижа»;
   - свёрнуто «Как считается место»;
   - «Следующая неделя закончится пн, 23 ноября 2026 г., 03:00»;
   - кнопка T-0256 под сообщением.

Состояния:
- старый клиент без оформления — Telegram показывает запасной текст;
- отказ Telegram на оформлении — картинка с подписью, как после T-0256;
- выключены `bot.formats.enabled` или `bot.rich.enabled` — как после T-0256;
- MAX и VK — простой текст того же документа.

## Тесты

Первым коммитом.

- `backend/api/test/bot-notify-rich.test.ts`:
  - `season_closing` с `endsAt: "2026-11-16T00:00:00.000Z"`:
    - `dateTime` с `unix: 1794787200`, `format: "wDt"`,
      `fallback: "завтра в 03:00 по Москве"`;
    - `plainTextOf` равен `botMessageOf("season_closing", …).text`;
  - `season_result` с местом 14, доской 230, наградой 250 монет и 10
    престижа → `plainTextOf` — ровно ожидаемая строка (снимок строкой);
    `richProblems` пуст; длина ≤ 1 000;
  - без награды — ряда «Награда» нет; без лучшего — ряда «Лучшее» нет;
  - «Следующая неделя закончится» на `now = 2026-11-16T07:00:00Z` → `unix`
    конца недели 23.11 00:00 UTC (`1795392000`);
  - битые данные и вид `friend_request` → `null`.
- `backend/api/test/notifications-bot-policy.test.ts` (T-0394, дописать):
  - `season_result` в 03:05 МСК при включённом формате → `deferred` до
    10:00;
  - отправитель с `composer` → `messenger.send` получил `rich`, `image` и
    `text = plainTextOf`; `events.sent` с `format: "rich"`;
  - `composer` вернул без `rich` (ключ выкл.) → `format: "photo"` при
    картинке.
- `backend/api/test/telegram-messenger-rich-image.test.ts` (фейк
  `TelegramBotApi` и кэша):
  - `rich` и `image`, `file_id` в кэше → `sendRichMessage`, первый блок —
    фото с этим `file_id`, дальше — блоки документа;
  - `file_id` нет → первый блок — фото с `InputFile`;
    `image.render` вызван один раз;
  - `sendRichMessage` бросает 400 → фото с подписью `text`, исход
    `{ status: "sent", fallback: true }`;
  - `rich` без `image` — без фото-блока, как в T-0394.
- Существующие `notifications-bot.test.ts`, `reminders.test.ts` и тесты
  T-0255/T-0256 проходят без правок.

## Аналитика

`bot_message_sent` (T-0394): `kind` — `season_result` или `season_closing`,
`format` — `rich`, `photo` или `text` по шагу 3. Возврат — сессии с
`start_ref` `n-season_result` и `n-season_closing`, как уже собирает кнопка
дубля. Новых событий нет.

## Настройки и окружение

Нет: ключи `bot.formats.enabled` и `bot.rich.enabled` вводит T-0394.

## Документы

Нет: сценарии записаны в WP52 (`docs/35-stage4-plan.md`), строка 90
`docs/30-configuration-map.md` их ключи уже называет.

## Критерии приёмки

- [ ] При включённых ключах итог сезона — оформленное сообщение: картинка
      первым блоком, таблица, «Как считается место», время конца следующей
      недели в поясе читателя; кнопка T-0256 — клавиатурой.
- [ ] «Сезон закрывается» называет время сущностью `date_time`; его простой
      текст совпадает с прежним слово в слово.
- [ ] Итог, пришедший в тихие часы, ждёт 10:00 МСК.
- [ ] Отказ оформления — картинка с подписью, как до задачи; выключенные
      ключи и площадки без оформления — прежний вид.
- [ ] Числа — только из данных вида и правил сезона.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Итог сезона таблицей и время в поясе читателя`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое [telegram]: итог недели в боте — таблицей с местом, лучшим и наградой, конец следующей недели — в твоём часовом поясе`
  - `- новое [telegram]: напоминание о закрытии сезона называет время в твоём часовом поясе`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ИТОГ СЕЗОНА ОФОРМЛЕННЫМ СООБЩЕНИЕМ**

  Итог недели в боте — картинка и под ней таблица «место · из скольких · лучшее · награда», раскрывающийся блок «Как считается место» и конец следующей недели в поясе читателя. Напоминание «Сезон закрывается» тоже называет время в поясе читателя (Р199).

  🛠 **Что внутри**

  • картинка — первым блоком оформленного сообщения; отказ Telegram — картинка с подписью, как раньше
  • итог, пришедший ночью, ждёт 10:00 МСК
  • запасной текст напоминания совпадает с прежним слово в слово

  ⚙️ **Настройки**

  • работает при включённых bot.formats.enabled и bot.rich.enabled

  ❓ **Нужно от команды**

  • @владелец — посмотреть итог сезона на деве в новом и старом клиенте
  ```
