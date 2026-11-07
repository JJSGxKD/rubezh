---
id: T-0376
title: Задания «главный экран» и «история» — порт площадки и экран заданий
epic: E16
priority: P2
status: draft
owner:
author: claude-lead2-3
size: M
depends_on: [T-0375, T-0373]
zones:
  - packages/adapter-telegram/src/home-screen.ts
  - packages/adapter-telegram/src/story.ts
  - packages/adapter-telegram/src/index.ts
  - packages/adapter-telegram/test/home-screen.test.ts
  - packages/adapter-telegram/test/story.test.ts
  - packages/app-shell/src/state/client-signals.ts
  - packages/app-shell/src/state/tasks-api.ts
  - packages/app-shell/src/screens/meta/client-signal-actions.tsx
  - packages/app-shell/src/screens/meta/task-row.tsx
  - packages/app-shell/src/screens/meta/achievement-card.tsx
  - packages/app-shell/src/screens/meta/achievements.tsx
  - packages/app-shell/src/screens/meta/tasks.tsx
  - packages/app-shell/src/assets/story/**
  - packages/app-shell/test/client-signals.test.ts
  - packages/app-shell/test/tasks-api.test.ts
shared:
  - packages/shared-types/src/index.ts
  - packages/app-shell/src/i18n/ru-tasks.json
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0376. Задания «главный экран» и «история» — порт площадки и экран заданий

## Зачем

T-0375 заводит задания «главный экран» и «история» на сервере. Здесь — что
видит игрок: кнопка в задании вызывает возможность площадки (добавить игру на
главный экран, открыть редактор истории с нашей картинкой и ссылкой), клиент
сообщает серверу о действии, и задание забирается обычным «Забрать». Где
клиент этого не умеет, задания нет.

## Решения

Записаны в `docs/35-stage4-plan.md` Р187 и Р18. Исполнитель их не пересматривает.

1. **«Главный экран»** засчитывается по событию площадки «добавлено»: Telegram —
   `addToHomeScreen`, событие `homeScreenAdded`, статус `checkHomeScreenStatus`,
   клиенты 8.0+.
2. **«История»** засчитывается по открытию редактора истории с нашей картинкой
   и ссылкой: `shareToStory`, клиенты 7.8+. Вышла ли история, площадка не
   сообщает.
3. **Задание показывается только там, где клиент это умеет.** Минимальная
   версия Bot API (Р18) остаётся 7.7: возможность проверяется по версии клиента.
4. **Площадки без возможности — «не умеет»**: MAX и VK метода не дают
   (`adapter-max`, `adapter-vk` не меняются: отсутствие метода и есть «не
   умеет», как у `requestBotMessages`).

Решения `claude-lead2-3` по устройству, по коду:

5. **Порт — необязательные методы `PlatformAdapter`**, как `openInvoice`,
   `requestBotMessages`: нет метода — не умеет. В `TelegramAdapter` метод
   ставится в конструкторе, только если `clientSupports(...)` пускает метод
   моста (образец — `requestBotMessages`, `adapter-telegram/src/index.ts:54`).
   Версия проверяется тем же `supports` из `@tma.js/sdk`, что и у
   `inviteMethods`; `isVersionAtLeast` из `webapp-compat.ts` — только для
   чужих SDK.
6. **Статус «уже добавлено»** (`checkHomeScreenStatus` → `added`) засчитывается
   так же, как событие «добавлено»: игра уже на главном экране — задание
   выполнено. Чтение статуса — при открытии витрины, если задание видно и не
   выполнено.
7. **Ссылка в истории** — ссылка дружбы игрока
   (`friendInviteUrl(botUrl, startParam)`, `state/friends-api.ts:94`): друг,
   пришедший по истории, засчитывается так же, как по приглашению; без входа
   или без ответа сервера — прямая ссылка на игру `botUrl`. Тот же путь, что у
   «Поделиться» на экране итогов (`state/run-share.ts:44`).
8. **Ссылка-виджет истории** (`widget_link`) по правилам Telegram доступна
   только Premium: адаптер ставит её, если `clientInfo().premium === true`;
   иначе ссылка идёт в текст истории. Решает адаптер, порт отдаёт и текст, и
   ссылку.
9. **Скрыто, если не умеет и не выполнено.** Выполненное на другом устройстве
   задание остаётся видно, чтобы забрать награду.

## Как сейчас

- `packages/shared-types/src/index.ts:198` — `PlatformAdapter`; образцы
  необязательных методов — `openInvoice`, `requestBotMessages`,
  `sharePreparedMessage`. `share(payload)` в Telegram — пустая заглушка.
- `packages/adapter-telegram/src/index.ts:41` — `clientSupports(method)` по
  версии клиента; `:137` `inviteMethods`; `invite.ts:63–90` — событие моста через
  `on(...)` и `postEvent` с отпиской (образец для «добавлено»);
  `describeTelegramClient()` — `isPremium`.
- `packages/app-shell/src/state/tasks-api.ts` — `TaskItem.kind` строкой, API
  заданий; `screens/meta/task-row.tsx` — строка задания («Перейти», «Проверить»,
  «Забрать»); `screens/meta/achievement-card.tsx` — карточка витрины;
  `achievements.tsx` — витрина, забор; `tasks.tsx` — экран.
- `state/run-share.ts`, `state/friends-api.ts` — ссылка дружбы для шеринга.
- Готовой картинки 9:16 с публичным `https`-адресом нет: в
  `packages/promo-kit/src/formats.ts:19` есть только формат `story` 1080×1920;
  фоны `apps/admin/src/screens/promo/art-starters/art_story_challenge.webp` и
  `art_story_code.webp` (1080×1920) лежат в исходниках панели и игроку не
  раздаются; пресеты промо на сервере (T-0273–T-0277) ещё не сделаны. Вопрос 1.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Порт** — `packages/shared-types/src/index.ts`, рядом с `requestBotMessages`:

   ```ts
   /** Что площадка знает о значке игры на главном экране устройства. */
   export type HomeScreenStatus = "added" | "missed" | "unknown";
   export interface HomeScreen {
     status(): Promise<HomeScreenStatus>;
     /** открыть системное окно «добавить на главный экран» */
     add(): void;
     /** площадка сообщила «добавлено»; отписка — вызовом результата */
     onAdded(listener: () => void): Unsubscribe;
   }
   export interface StoryPayload {
     /** картинка 9:16, полный https-адрес */
     mediaUrl: string;
     text: string;
     link: { url: string; name: string };
   }
   export type StoryResult = "opened" | "unavailable";
   // в PlatformAdapter:
   /** Значок игры на главном экране (Р187). Нет — площадка или клиент не умеют. */
   homeScreen?: HomeScreen;
   /** Открыть редактор истории с картинкой и ссылкой (Р187, Р18). Нет — не умеет. */
   shareStory?(story: StoryPayload): Promise<StoryResult>;
   ```

3. **Telegram — `adapter-telegram/src/home-screen.ts`** (ленивый модуль не нужен —
   это обёртка моста в несколько строк):
   - `createHomeScreen(sdk)`: `status()` — `postEvent("web_app_check_home_screen")`
     и ожидание `home_screen_checked` до 2 с; `unsupported` и тишина → `unknown`;
   - `add()` — `postEvent("web_app_add_to_home_screen")`;
   - `onAdded` — `on("home_screen_added", …)`;
   - `sdk` — интерфейс с `postEvent` и `on`, подменяется в тестах.
4. **Telegram — `adapter-telegram/src/story.ts`**: `shareStoryWith(sdk, story,
   premium)` — `postEvent("web_app_share_to_story", { media_url, text,
   widget_link? })`; `widget_link: { url, name }` только при `premium`, иначе в
   текст дописывается ` ${url}`; текст режется до 200 знаков (лимит без
   Premium), у Premium — до 2048; исключение моста → `unavailable`.
5. **`TelegramAdapter`** (`index.ts`): в конструкторе
   `if (clientSupports("web_app_add_to_home_screen")) this.homeScreen = …` и
   `if (clientSupports("web_app_share_to_story")) this.shareStory = …`; поля
   `readonly … ?`.
6. **`app-shell/src/state/client-signals.ts`**:
   - `CLIENT_KINDS = ["home_screen", "story_share"]`, `isClientKind(kind)`;
   - `clientCan(kind, adapter)` — есть ли метод порта;
   - `visibleForClient(task, adapter)` — скрыть невыполненное, если не умеет;
   - `storyPayload(link, deps)` — картинка (вопрос 1), текст и ссылка
     (вопрос 2); ссылка — по решению 7.
7. **`state/tasks-api.ts`** — `signal(kind): Promise<ApiResult<{ tasks: TaskItem[] }>>`
   → `POST /api/v1/tasks/signals/<kind>` без тела (T-0375).
8. **`screens/meta/client-signal-actions.tsx`** — кнопки для строки и карточки:
   - «главный экран»: при монтировании `status()`; `added` → `signal`; иначе
     кнопка; нажатие → `add()`; `onAdded` → `signal`, затем перечитать витрину;
     отписка при размонтировании;
   - «история»: нажатие → ссылка (решение 7) → `shareStory(payload)` →
     `opened` → `signal` и перечитать задания; `unavailable` → строка под
     кнопкой (вопрос 2).
9. **Строка и карточка**: `task-row.tsx` — у невыполненного `story_share`
   кнопка истории вместо полосы прогресса; `achievement-card.tsx` — у
   невыполненного `home_screen` кнопка главного экрана. Заголовок без `title`
   из панели — ключом `task.kind.<вид>` (вопрос 2); у достижения
   `achievementTitle` берёт тот же ключ, если нет `achievement.<id>.name`.
10. **Видимость**: `tasks.tsx` и `achievements.tsx` пропускают задания через
    `visibleForClient`; знак вкладки считает только видимые.
11. **Картинка** — по ответу на вопрос 1, в `packages/app-shell/src/assets/story/`;
    адрес — `new URL(url, document.baseURI).href`.
12. **Документы** — раздел «Документы».

## Чего не трогаем

- Сервер и панель — T-0375.
- `adapter-max`, `adapter-vk` — отсутствие метода уже значит «не умеет».
- `share(payload)` Telegram-адаптера (заглушка) — не эта задача.
- Минимальную версию Bot API (Р18) и проверку версии при запуске.
- Порядок и группу «Можно забрать» (T-0373): выполненное задание встаёт туда само.

## Сценарий и интерфейс

- **Telegram 8.0+, «Достижения»:** карточка «главный экран» с кнопкой → окно
  Telegram «добавить» → после «добавлено» карточка «Выполнено» и «Забрать».
  Игра уже на главном экране — при открытии витрины сразу «Забрать».
- **Telegram 7.8+, «Неделя»:** строка «история» с кнопкой → редактор истории
  с картинкой → вернулся в игру — «Забрать». На следующей неделе — снова.
- **Старый клиент, MAX, VK, браузер:** невыполненных заданий нет.
- **Ошибка сигнала** (нет сети, лимит): строка под кнопкой (вопрос 2), задание
  остаётся невыполненным, нажать можно снова.
- **Без входа** — плашка экрана заданий, как сейчас.

Анимаций и звуков нет; забор — прежний звук и выброс награды. Снимки строки и
карточки в обоих состояниях на 320, 390, 768, 1440, 667×375 и 640×360 в PR;
проверка на телефоне с Telegram 8.0+ — строкой в PR, если есть.

## Тесты

Первым коммитом.

- `packages/adapter-telegram/test/home-screen.test.ts` (подменённый мост):
  `status` → `home_screen_checked` `{ status: "added" }` → `added`; `missed` →
  `missed`; `unsupported` → `unknown`; нет ответа 2 с (фальшивые таймеры) →
  `unknown`; `onAdded` вызывает слушателя на `home_screen_added` и отписывается.
- `packages/adapter-telegram/test/story.test.ts`: Premium — `widget_link` есть,
  текст без ссылки; без Premium — `widget_link` нет, ссылка в конце текста;
  текст длиннее 200 знаков без Premium режется; исключение моста → `unavailable`.
- `packages/app-shell/test/client-signals.test.ts`: адаптер без `homeScreen` →
  невыполненное `home_screen` скрыто, выполненное видно; с методом — видно;
  `isClientKind`; `storyPayload` — ссылка дружбы, без `startParam` — `botUrl`;
  `mediaUrl` — абсолютный `https`.
- `packages/app-shell/test/tasks-api.test.ts` (дописать): `signal("story_share")`
  шлёт `POST /api/v1/tasks/signals/story_share` без тела и разбирает `{ tasks }`.

## Аналитика

- История: `share_offered` `{ context: "task_story", method: "story" }` при
  нажатии и `share_completed` с `result` `shared` (редактор открыт) или
  `unavailable` — события и поля уже в словаре, новых нет; в
  `docs/22-analytics-and-metrics.md` строка `share_offered`, `share_completed`
  (~192) дописывает значения `context` `task_story` и `method` `story`.
- Главный экран: событий сверх `achievement_unlocked` при заборе нет.

## Настройки и окружение

Нет. Порог ожидания статуса (2 с) и предел текста — константы в
`home-screen.ts` и `story.ts`.

## Документы

- `docs/27-design-system-and-app-shell.md`, строка «Задания» (~1381): одно
  предложение в конец — задания «главный экран» (витрина) и «история» (неделя)
  видны только там, где клиент умеет (Р187), засчитываются сообщением клиента.
- `docs/30-configuration-map.md`, строка «Задания и достижения»: картинка и
  тексты истории — где лежат.
- `docs/22-analytics-and-metrics.md` — раздел «Аналитика».

## Вопросы к тимлиду

1. **Картинка истории 9:16 (1080×1920) и её публичный адрес.** Готовой нет
   (раздел «Как сейчас»). `shareToStory` берёт `media_url` — `https`-адрес,
   который Telegram скачает сам.
   - **(а) (Рекомендуется)** Дизайнер собирает одну картинку из готового фона
     `art_story_challenge.webp` с логотипом и призывом (JPEG 1080×1920, до
     500 КБ) в `design/art/`; задача кладёт её в `packages/app-shell/src/assets/story/`,
     сборка раздаёт её с адреса игры. Нужна задача дизайнеру до этой.
   - **(б)** Отдельный рисунок дизайнера под историю, не из пресетов промо —
     то же размещение, дольше.
   - **(в)** Картинка из медиатеки панели (`/api/v1/media/<хэш>.webp`, адрес
     API) — команда меняет её без релиза; нужно убедиться, что Telegram
     принимает WebP в истории, и ключ настройки с id картинки (T-0375 его не
     заводит).
2. **Тексты для игрока** (в словаре `ru-tasks.json` игра говорит на «ты»,
   Р187 записан на «вы»). Предлагаю, подтвердите или поправьте:
   - `task.kind.home_screen` — «Добавь игру на главный экран»;
   - `task.kind.story_share` — «Поделись историей с игрой»;
   - кнопки: `tasks.homeScreen.add` — «На главный экран»,
     `tasks.story.share` — «Поделиться историей»;
   - текст истории `tasks.story.text` — «Держу рубеж. Сколько продержишься ты?»;
     имя ссылки-виджета `tasks.story.linkName` — «Играть»;
   - отказ `tasks.story.failed` — «Не получилось открыть историю — попробуй ещё
     раз»; `tasks.signal.failed` — «Не удалось засчитать — попробуй ещё раз».

## Критерии приёмки

- [ ] Порт: `homeScreen` и `shareStory` есть у Telegram 8.0+ и 7.8+
  соответственно, у старых клиентов, MAX, VK и браузера — нет.
- [ ] Невыполненное задание скрыто там, где клиент не умеет; выполненное видно.
- [ ] «Добавлено» или статус `added` → сигнал серверу → «Забрать»; открытый
  редактор истории → сигнал → «Забрать».
- [ ] История идёт с картинкой 1080×1920 по `https` и ссылкой дружбы игрока.
- [ ] Снимки в PR; гейт (`CLAUDE.md`), `pnpm budget` и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Задания «главный экран» и «история»`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: задание «Добавь игру на главный экран» в «Достижениях»`
  - `- новое: еженедельное задание «Поделись историей с игрой»`
- **Сводка для команды** — исполнитель переносит блок в описание PR как есть и
  вписывает номер PR:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАДАНИЯ «ГЛАВНЫЙ ЭКРАН» И «ИСТОРИЯ»**

  Игрок Telegram может добавить игру на главный экран и раз в неделю поделиться историей с игрой — за это задание с наградой из панели. Где клиент так не умеет, задания нет.

  🛠 **Что внутри**

  • порт площадки: главный экран (Telegram 8.0+) и история (7.8+)
  • в истории — картинка игры и ссылка дружбы игрока: друг по ней засчитывается
  • засчитывает сообщение клиента, награда — обычным «Забрать»

  ❓ **Нужно от команды**

  • @владелец — завести оба задания в панели (T-0375), если ещё не заведены
  ```
