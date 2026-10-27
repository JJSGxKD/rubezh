---
id: T-0344
title: Кнопка «Связаться с разработчиком» в меню и настройках — ссылка своя на каждую площадку
epic: E6
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - packages/app-shell/src/app/MainMenu.tsx
  - packages/app-shell/src/screens/settings.tsx
  - packages/app-shell/src/state/badges-api.ts
  - packages/app-shell/src/state/contact.ts
  - packages/app-shell/src/state/contact.test.ts
  - backend/api/src/modules/badges/**
  - backend/api/test/badges.test.ts
  - backend/api/test/settings.test.ts
shared:
  - backend/api/src/modules/settings/setting-catalog.ts
  - packages/app-shell/src/i18n/ru.json
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 3
---

# T-0344. Кнопка «Связаться с разработчиком» в меню и настройках

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0344.json)](README.md#значки-статуса)

Строку значков и ячейку эпика ставит `pnpm task fix`.

## Зачем

Форма «Написать разработчикам» — отзыв с данными устройства, живого разговора
она не даёт. Игроку нужен короткий путь к человеку: одно касание в меню или
настройках открывает разговор с разработчиком на его площадке.

## Решения

- Р173 (`docs/35-stage4-plan.md`, 27.10.2026): пункт в меню и в настройках,
  рядом с формой «Написать разработчикам»; форма остаётся. Ссылка — ключом
  панели на каждую площадку; для Telegram — сообщения канала разработчика;
  пусто — пункта нет.
- Номер: в Р173 и в переписке задача названа T-0343, но этот номер занят
  (`T-0343-archive-by-cleanup`), поэтому здесь T-0344. Ссылку в Р173 правит
  тимлид, не исполнитель.
- Формат ссылки для Telegram (пример `https://t.me/<канал>?direct`) владелец
  проверяет сам и вносит в панель. Исполнитель код под конкретный формат не
  подгоняет: ссылка — любая https из ключа.
- Ключи называются по соглашению каталога (`donate.tribute-url-telegram`):
  `contact.url-telegram`, `contact.url-max`, `contact.url-vk`, `contact.url-web`.
- Площадку берёт сервер из токена (`account.platform`), клиент её не называет:
  так же устроены журнал обновлений и Tribute доната.

## Как сейчас

- Меню: `packages/app-shell/src/app/MainMenu.tsx`. Последняя группа
  (`settings.testers` «Помощь в тестировании» и `settings.about`) — строки
  97–101; полноэкранный режим — отдельная группа выше.
- Настройки: `screens/settings.tsx`, блок «Помощь в тестировании» — строки
  204–211 (`settings.testers`, диагностика, `settings.about`). Форма
  «Написать разработчикам» открывается экраном `feedback`
  (`navigation.push("feedback")`, карточка на `home.tsx:110`).
- Ссылка на канал проекта (`home.channel-url`) доходит до клиента через
  сервер: `HomeService` читает `SETTINGS.homeChannelUrl`
  (`modules/home/home.service.ts:73`) и кладёт в слайд. Схема ссылки в каталоге —
  `urlSchema` (`setting-catalog.ts:90`): только https, до 256 знаков, пусто
  разрешено.
- Знаки меню приходят одним запросом `GET /api/v1/me/badges`
  (`modules/badges/badges.service.ts` → `BadgesView`; клиент — `state/badges-api.ts`),
  клиент спрашивает при входе и на возврате. Площадка — `account.platform`
  (`PLATFORM_IDS = telegram | max | vk | web`).
- Открытие ссылок: `state/external-link.ts` → `openExternalLink(url)` зовёт
  `adapter.openLink` (в Telegram — `openTelegramLink` для ссылок t.me,
  `packages/adapter-telegram/src/links.ts`), без адаптера — браузер.
  `app-shell` адаптеры не импортирует и не должен.
- `ListItem` не принимает `track`; нажатие помечают вызовом `trackClick`
  (`state/ui-clicks.ts`) — событие `ui_clicked` из словаря уже есть.

## Шаги по порядку

1. Тесты из раздела «Тесты» — первым коммитом.
2. `setting-catalog.ts`: группа `CONTACT_GROUP = "Связь с разработчиком"` и четыре
   ключа `contactUrlTelegram`, `contactUrlMax`, `contactUrlVk`, `contactUrlWeb`
   (`key: "contact.url-<площадка>"`, `kind: "url"`, `schema: urlSchema`,
   `fromEnv: () => null`, `fallback: ""`). Подсказка в панели: «Куда ведёт кнопка
   «Связаться с разработчиком» у игроков этой площадки — ссылка https://… Для
   Telegram — сообщения канала разработчика. Пусто — кнопки нет».
3. Сервер: `BadgesService.view` дополнить полем `contactUrl: string | null`
   — ссылка ключа площадки аккаунта; пустая строка — `null`. Ключ выбирается
   чистой функцией `contactUrlFor(platform, settings)` в
   `modules/badges/contact-url.ts` (переключение по `PlatformId`, без `default`,
   чтобы новая площадка ломала `typecheck`). `SettingsService` подключить
   конструктором; `badges.module.ts` — импорт модуля настроек, если ещё нет.
4. Клиент: `badges-api.ts` — в схему ответа `contactUrl: z.optional(z.nullable(z.string()))`
   (сервер старее клиента не пришлёт). Значение кладётся в новый стор
   `state/contact.ts` (`useContact`: `url: string | null`, `set(url)`), не в
   `useBadges`: там только числа. Функция `contactHref(): string | null` — url,
   если он начинается с `https://`, иначе `null` (вторая защита после сервера).
5. `state/contact.ts` — `openContact()`: берёт `contactHref()`, `trackClick("contact")`,
   затем `openExternalLink(url)` в том же нажатии. Ссылки нет — ничего не делает.
6. `MainMenu.tsx`: в последней группе, перед «Помощью в тестировании», пункт
   `<ListItem icon={<MessageCircle size={18} />} title={t("menu.contact")} hint={t("menu.contact.hint")} onClick={openContact} />`,
   рисуется только при `contactHref() !== null` (подписка на стор, чтобы пункт
   появлялся после прихода знаков). Меню закрывается перед открытием ссылки не
   нужно: внешняя ссылка открывается поверх.
7. `screens/settings.tsx`: тот же пункт первой строкой блока «Помощь в
   тестировании» (над `settings.testers`) с тем же условием и `openContact`.
8. `i18n/ru.json`: `"menu.contact": "Связаться с разработчиком"`,
   `"menu.contact.hint": "Ответит сам разработчик"`.
9. `docs/30-configuration-map.md`: строка про четыре ключа `contact.url-*` в
   разделе ссылок/главной: что делают, пусто — пункта нет, формат Telegram
   проверяет владелец. `docs/22-analytics-and-metrics.md` не трогаем: имя
   `contact` — значение поля `control` уже существующего `ui_clicked`.

## Чего не трогаем

- Форму «Написать разработчикам» (`feedback`) и её серверную часть — остаётся.
- Слайд «Наш канал» и ключ `home.channel-url`.
- Адаптеры площадок (`packages/adapter-*`): `openLink` уже есть, нового метода
  в `PlatformAdapter` не заводим.
- Дизайн-систему: `track` в `ListItem` не добавляем (отдельная задача при нужде).
- Админ-панель: ключи каталога панель рисует сама по `kind: "url"`.

## Сценарий и интерфейс

Игрок открывает меню: если для его площадки ссылка задана, в последней группе
есть строка «Связаться с разработчиком» с подсказкой «Ответит сам разработчик».
Касание открывает ссылку средствами площадки (в Telegram — внутри клиента).
Те же строка и поведение в настройках над «Помощью в тестировании».

- загрузка: знаки ещё не пришли — пункта нет, он появляется без скачка меню
  после ответа;
- пусто: ключ площадки пуст — пункта нет ни в меню, ни в настройках;
- ошибка/нет сети: ответ знаков не пришёл — пункта нет, всё остальное меню на месте;
- ограничение аккаунта: на пункт не влияет;
- без входа (веб без сессии): знаков нет — пункта нет.

Новых экранов нет, снимки на 320/390/768/1440 и ландшафте — у меню с пунктом
и без него.

## Тесты

- `backend/api/test/settings.test.ts` — ключи `contact.url-*`: `https://t.me/x?direct`
  проходит; `http://…` и `javascript:…` отклоняются; пусто допустимо; умолчание пусто.
- `backend/api/test/badges.test.ts` — `contactUrlFor`: для `telegram`, `max`,
  `vk`, `web` берётся свой ключ, чужой не подставляется; пусто → `null`;
  `view()` с аккаунтом `telegram` возвращает `contactUrl` Telegram.
  Существующие `toEqual` на `view()` дополнить новым полем.
- `packages/app-shell/src/state/contact.test.ts` — `contactHref()`: `https://…`
  → ссылка; пусто, `null`, `http://…`, `javascript:…` → `null`;
  `openContact()` с ссылкой зовёт `openLink` адаптера и шлёт `ui_clicked`
  с `control: "contact"`; без ссылки не зовёт ничего.
- Разметка меню (`MainMenu` с отрисовкой, по образцу соседних тестов
  `app-shell`): ссылка есть — пункт «Связаться с разработчиком» присутствует и
  стоит перед «Помощью в тестировании»; ссылки нет — пункта нет.
  То же для блока настроек.
- `badges-api`: ответ без `contactUrl` (старый сервер) разбирается без ошибки.

## Аналитика

Отдельного события нет. Нажатие — `ui_clicked` с `control: "contact"`
(Р141, T-0226): имя подходит под шаблон `[a-z0-9_-]{1,24}`, экран берётся из
навигации (меню над экраном — текущий экран; настройки — `settings`).
Словарь и Zod-схема событий не меняются.

## Настройки и окружение

Четыре ключа каталога `contact.url-telegram|max|vk|web` (группа «Связь с
разработчиком», вид `url`, только https, пусто — кнопки нет). Переменных
окружения нет. Ссылки вносит владелец в панели; для Telegram — ссылка на
сообщения канала разработчика, пример `https://t.me/<канал>?direct`, формат
владелец проверяет сам.

## Документы

- `docs/30-configuration-map.md` — строка ключей.
- Гайдбук не меняется: это не механика игры.

## Критерии приёмки

- [ ] Ссылка выбирается сервером по площадке из токена; клиент площадку не называет.
- [ ] Пусто или не-https — пункта нет в меню и в настройках; в каталоге не-https отклоняется.
- [ ] Открытие идёт через `openExternalLink`/`adapter.openLink`; `app-shell` не импортирует `adapter-*`.
- [ ] Нажатие шлёт `ui_clicked` с `control: "contact"`; нового события нет.
- [ ] Форма «Написать разработчикам» работает как раньше.
- [ ] Тексты — ключи i18n, к игроку на «ты», без рода.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Кнопка «Связаться с разработчиком»`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: кнопка «Связаться с разработчиком» в меню и настройках — откроет разговор с разработчиком`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КНОПКА «СВЯЗАТЬСЯ С РАЗРАБОТЧИКОМ»**

  В меню и настройках появился пункт «Связаться с разработчиком»: ссылка своя на каждую площадку, пусто — пункта нет.

  🛠 **Что сделано**

  • четыре ключа панели «Связь с разработчиком» (contact.url-telegram, -max, -vk, -web)
  • сервер отдаёт игроку ссылку его площадки вместе со знаками меню
  • нажатие считается как ui_clicked, control contact

  ❓ **Нужно от команды**

  • @участник1 — вписать ссылки в панель; для Telegram проверить формат ссылки на сообщения канала (пример https://t.me/<канал>?direct)
  ```
