---
id: T-0252
title: Картинки бота — основа: шрифт Russo One, общая сцена с обликом, кэш file_id, публичный адрес картинки
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0237]
zones:
  - backend/api/src/common/card/scene.ts
  - backend/api/src/common/card/card-cache.ts
  - backend/api/src/common/card/card-store.ts
  - backend/api/src/modules/cards/**
  - backend/api/assets/fonts/**
  - backend/api/test/card-scene.test.ts
  - backend/api/test/card-store.integration.test.ts
shared:
  - backend/api/src/common/card/svg.ts
  - backend/api/src/platforms/telegram/welcome-card.ts
  - backend/api/src/platforms/telegram/welcome.command.ts
  - backend/api/src/platforms/ports/prepared-message.ts
  - backend/api/src/platforms/telegram/telegram-message-preparer.ts
  - backend/api/src/app.module.ts
  - backend/api/Dockerfile
  - docs/12-ip-and-licensing.md
  - docs/21-diagrams.md
  - docs/24-attribution-and-sharing.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/mockups/bot-images-v2.html
batch: 4
---

# T-0252. Картинки бота — основа: шрифт Russo One, общая сцена с обликом, кэш file_id, публичный адрес картинки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0252.json)](README.md#значки-статуса) [![T-0237](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0237.json&label=T-0237)](T-0237-appearance-server.md)

## Зачем

Картинкой сейчас умеет только приветствие по `/start` (`welcome-card.ts`),
и всё нужное ему лежит внутри него. После задачи у сервера есть общая основа
для картинок бота (Р156):
- шрифт игры Russo One;
- сцена 1200×675 с миром, обликом игрока и словесным знаком;
- кэш `file_id` по хэшу видимого;
- публичный адрес картинки, чтобы «Поделиться» несло её крупным
  предпросмотром.

На этой основе T-0253–T-0257 рисуют свои картинки.

## Решения

Решения владельца — `docs/35-stage4-plan.md` Р156:
- каждое сообщение бота — с картинкой мира и облика;
- SVG → resvg → PNG 1200×675, кэш по хэшу видимого (`design/art/meta-v2.md` §3);
- TTF Russo One (OFL) — в образ сервера.

Решения `claude-lead-1` от 24.10.2026:

- **Шрифт** — файл `backend/api/assets/fonts/RussoOne-Regular.ttf` рядом с
  текстом лицензии OFL (`OFL.txt`).
  - Каталог добавляется в `FONT_DIRS` у `renderPng` (`common/card/svg.ts`) — путём от модуля, как сейчас каталог Debian.
  - Dockerfile копирует каталог в образ.
  - Гарнитура заголовков — `Russo One`, запасная — DejaVu Sans.
  - Строка лицензии — в `docs/12`.
- **Сцена** `scene.ts` — `heroScene(input)` → SVG 1200×675:
  - небо, жар и частокол (`twilightBackdrop`);
  - портрет облика (`HERO_PORTRAITS` в `brand-art.ts`, id из T-0237, нет — `keeper`) справа;
  - словесный знак в углу;
  - заголовок Russo One, до трёх строк текста (`wrapWords`) и необязательная «плашка» числа.

  Тон акцента — из `PALETTE`. Раскладка — по макету `mockups/bot-images-v2.html`.
  Приветствие переходит на сцену и меняет `CARD_VERSION`.
- **Кэш `file_id`** — `card-cache.ts`, обобщённый из `welcome.command.ts`
  (Redis, ключ — хэш видимого + версия шаблона; протухший `file_id` —
  нарисовать и загрузить заново). Приветствие пользуется им же.
- **Публичный адрес картинки** — модуль `cards`:
  - `card-store.ts` хранит PNG по хэшу содержимого в Redis, 30 дней;
  - `GET /api/v1/cards/:hash.png` отдаёт PNG с `Cache-Control: public, max-age=31536000, immutable`; адрес не угадывается — хэш содержимого;
  - лимит запросов по адресу — тем же приёмом, что у `media`;
  - вход — `@Public()`.
- **«Поделиться» с картинкой.** У подготовленного сообщения
  (`PreparedMessageInput`) — необязательное `imageUrl`. Telegram-адаптер
  кладёт его как большой предпросмотр над текстом:
  `InputTextMessageContent` с `link_preview_options: { url, prefer_large_media:
  true, show_above_text: true }`.
  - Так PNG годится без загрузки в Telegram: фото по адресу Telegram берёт только JPEG.
  - Площадка без такого предпросмотра шлёт текст без картинки.

## Как сейчас

- `common/card/svg.ts`:
  - `PALETTE`, `FONT`, `text`, `rect`, `wrapWords`, `svgDocument`, `svgImage`, `twilightBackdrop`;
  - `renderPng` (resvg, `FONT_DIRS = ["/usr/share/fonts"]`, `defaultFontFamily: "DejaVu Sans"`).
- `common/card/brand-art.ts` — `WORDMARK_SVG`, `HERO_PORTRAITS`,
  `PORTRAIT_RATIO` (генерирует `design/art/src/bot-art.mjs`).
- `platforms/telegram/welcome-card.ts` (`CARD_VERSION = 4`, 1200×675) и
  `welcome.command.ts:30–90` — кэш `file_id` в Redis.
- `platforms/ports/prepared-message.ts` — `PreparedMessageInput { title,
  description, text, button }`; Telegram — `telegram-message-preparer.ts`
  (`savePreparedInlineMessage`).
- `backend/api/Dockerfile:25` — `fonts-dejavu-core`.
- Модуль `media` — образец отдачи картинок по хэшу.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Шрифт** — файл, лицензия, `FONT_DIRS`, Dockerfile, `docs/12`.
3. **`scene.ts`** — `heroScene`; приветствие — на сцену, `CARD_VERSION` +1.
4. **`card-cache.ts`** — из `welcome.command.ts`, без копии.
5. **`card-store.ts` и модуль `cards`** — хранение, маршрут, лимит, модуль в
   `app.module.ts`.
6. **Подготовленное сообщение** — `imageUrl` в порту и в Telegram-адаптере.
7. **Документы:** `docs/24` (подготовленное сообщение с картинкой), `docs/21`
   (модуль `cards`).

## Чего не трогаем

- Сами картинки сообщений — T-0253–T-0257.
- Тексты и логику приветствия — только раскладку на сцене.

## Тесты

Первым коммитом.

- `card-scene.test.ts`:
  - `heroScene` с обликом `vityaz` вставляет его портрет, с неизвестным — `keeper`;
  - длинное имя переносится, не больше трёх строк;
  - `renderPng` рисует заголовок шрифтом Russo One: у PNG ненулевые пиксели в зоне заголовка;
  - одинаковый вход — одинаковый хэш, другое имя — другой.
- `card-store.integration.test.ts` (живой Redis):
  - сохранение → `GET /cards/<hash>.png` → тот же PNG с `immutable`;
  - чужой хэш → 404;
  - лимит адреса → 429.
- Подготовленное сообщение с `imageUrl` → в запросе к Bot API
  `link_preview_options` с адресом; без `imageUrl` — как сейчас.

## Аналитика

Нет: основа, сообщений не шлёт.

## Настройки и окружение

Нет переменных: адрес картинки строится от публичного адреса API, который
уже есть в конфигурации.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Сцена 1200×675 с обликом и знаком, заголовки шрифтом Russo One в проде.
- [ ] Кэш `file_id` общий; приветствие работает на сцене.
- [ ] Картинка доступна по хэшу, подготовленное сообщение несёт её предпросмотром.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Основа картинок бота`
- **Метка:** `release: minor`
- **Для игроков:** `- изменено: приветствие бота — шрифтом игры`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОСНОВА КАРТИНОК БОТА**

  У сервера общая сцена картинок бота 1200×675: мир, облик игрока, словесный знак, заголовки шрифтом игры Russo One. Кэш file_id общий, картинка доступна по хэшу, и «Поделиться» может нести её крупным предпросмотром. Приветствие уже на новой сцене.
  ```
