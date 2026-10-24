---
id: T-0091
title: Ссылки Telegram собираются в одном месте — подготовка к смене домена
epic: E14
priority: P2
status: done
owner: claude-3 / sonnet-5.5 / medium
author: claude-lead2-10
size: S
depends_on: []
zones:
  - backend/api/src/platforms/telegram/telegram-link-format.ts
  - backend/api/src/platforms/telegram/telegram-app-links.ts
  - backend/api/src/platforms/telegram/bot-identity.ts
  - backend/api/src/platforms/platforms.module.ts
  - backend/api/test/telegram-link-format.test.ts
  - backend/api/test/telegram-link-origin.test.ts
  - backend/api/test/telegram-link-single-point.test.ts
shared: []
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 1
---

# T-0091. Ссылки Telegram собираются в одном месте — подготовка к смене домена

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0091.json)](../README.md#значки-статуса)

## Зачем

Сервер собирает ссылки на бота и Mini App в двух местах: `BotIdentity.miniAppLink`
и `TelegramAppLinks`, и в обоих `https://t.me` зашит в строку. Когда t.me
окажется недоступен, домен придётся менять в нескольких файлах. Задача ничего
не меняет для игрока: все ссылки остаются прежними, но собираются одной
функцией из одного источника домена. На нём строится T-0090 (настройка домена).

## Решения

- **Р100 (13.10.2026):** все ссылки Telegram, которые строит сервер, идут с
  настраиваемым доменом; смена — одной настройкой, без правок по модулям. Эта
  задача — рефакторинг до поведения, настройки здесь нет (`docs/35-stage4-plan.md`).
- **Форму ссылки знает один файл** — `telegram-link-format.ts`. Остальные
  строят ссылки только через его функции. Это проверяет тест-сторож по
  исходникам (шаг 6).
- **Источник домена — объект `LinkOrigin`** с методом `origin()`, который
  спрашивают в момент сборки ссылки, а не при старте: настройка из панели
  начнёт действовать без перезапуска. Здесь `origin()` всегда `https://t.me`.
- **Конструкторы остаются совместимыми.** `new TelegramAppLinks({ miniAppLink,
  username })` и `new BotIdentity(config, api)` вызывают 14 существующих
  тестов; новые параметры необязательные, а существующие тесты не правятся.
- **Диплинки `tg://resolve` от домена не зависят**, но их форму тоже знает
  только форматтер.

## Как сейчас

- `backend/api/src/platforms/telegram/telegram-app-links.ts` (34 строки):
  - `13` — `constructor(private readonly identity: Pick<BotIdentity, "miniAppLink" | "username">)`;
  - `15-18` — `launch`: `` `${base}=${encodeURIComponent(startParam)}` `` от `identity.miniAppLink`;
  - `20-23` — `chat`: `` `https://t.me/${username}?start=…` `` — домен зашит;
  - `25-33` — `launchDeep` и `chatDeep`: `` `tg://resolve?domain=${username}&startapp=…` `` и `…&start=…`.
- `backend/api/src/platforms/telegram/bot-identity.ts:32-34` — геттер
  `miniAppLink`: `` `https://t.me/${this.botUsername}?startapp` `` — домен зашит.
  Конструктор — строки 21-24: `APP_CONFIG`, `TELEGRAM_BOT_API`.
- Потребители `identity.miniAppLink`: `welcome.command.ts:50-53` (`playButtonFor`),
  `:294` и `:300`; `bot-fallback.ts:78`. Их не трогаем: имя геттера и тип
  результата прежние.
- `backend/api/src/platforms/platforms.module.ts:44-46` — `appLinksFor(identity)`;
  `:63` — провайдер `AppLinks` с `inject: [BotIdentity]`; `:68` — `exports`.
- Тесты, которые должны остаться зелёными без правок:
  `new TelegramAppLinks({ miniAppLink: "https://t.me/rubezh_bot?startapp", username: "rubezh_bot" })`
  в 14 файлах `backend/api/test/` (`app-links.test.ts`, `panel-login.test.ts`,
  `admin-session.test.ts`, `links.test.ts` и другие), `new BotIdentity(config, api)`
  в `welcome.test.ts:144` и `bot-fallback.test.ts:47`.
- Других мест, где в коде бэкенда собирается ссылка Telegram, нет: `friend-invite`,
  `friend-notifier`, `bot-notify-sender`, `links.service`, `panel-login`,
  `role-confirmations` просят ссылку у порта `AppLinks`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»). Они падают, пока файла
   форматтера нет.
2. **Новый файл `backend/api/src/platforms/telegram/telegram-link-format.ts`:**

   ```ts
   /** Откуда начинается веб-ссылка Telegram: схема и домен, без пути и слэша на конце. */
   export interface LinkOrigin {
     origin(): string;
   }

   export const TELEGRAM_LINK_ORIGIN = Symbol("TELEGRAM_LINK_ORIGIN");
   export const DEFAULT_LINK_ORIGIN = "https://t.me";
   export const fixedLinkOrigin: LinkOrigin = { origin: () => DEFAULT_LINK_ORIGIN };

   /** `app` — Mini App (`startapp`), `chat` — чат с ботом (`start`). */
   export type BotLinkKind = "app" | "chat";

   const PARAM = { app: "startapp", chat: "start" } as const;

   /** `https://t.me/<бот>?startapp` без параметра; с параметром — `…?startapp=<параметр>`. */
   export function webLink(origin: string, username: string, kind: BotLinkKind, startParam?: string): string {
     const base = `${origin}/${username}?${PARAM[kind]}`;
     return startParam === undefined ? base : `${base}=${encodeURIComponent(startParam)}`;
   }

   /** Тот же адрес диплинком в установленный клиент; от домена не зависит. */
   export function deepLink(username: string, kind: BotLinkKind, startParam: string): string {
     return `tg://resolve?domain=${username}&${PARAM[kind]}=${encodeURIComponent(startParam)}`;
   }
   ```

3. **`telegram-app-links.ts`:** конструктор получает необязательный второй
   параметр `private readonly origin: LinkOrigin = fixedLinkOrigin`.
   - `launch` не меняется (строится от `identity.miniAppLink`, а тот — через
     форматтер, шаг 4);
   - `chat`: `username === null ? null : webLink(this.origin.origin(), username, "chat", startParam)`;
   - `launchDeep`: `…deepLink(username, "app", startParam)`; `chatDeep`: `…deepLink(username, "chat", startParam)`.
   Обновить комментарий над классом: домен берётся из `LinkOrigin`, в проде у
   `launch` и `chat` он один и тот же (шаг 5).
4. **`bot-identity.ts`:** третий параметр конструктора

   ```ts
   @Optional() @Inject(TELEGRAM_LINK_ORIGIN) private readonly linkOrigin: LinkOrigin = fixedLinkOrigin,
   ```

   (`Optional` — из `@nestjs/common`). Тесты, поднимающие `BotIdentity`
   без `PlatformsModule`, получат `undefined` и умолчание. Геттер:

   ```ts
   get miniAppLink(): string | null {
     return this.botUsername === null ? null : webLink(this.linkOrigin.origin(), this.botUsername, "app");
   }
   ```

5. **`platforms.module.ts`:** `appLinksFor(identity: BotIdentity, origin: LinkOrigin = fixedLinkOrigin)`
   передаёт `origin` в `new TelegramAppLinks(identity, origin)`; в `providers` —
   `{ provide: TELEGRAM_LINK_ORIGIN, useValue: fixedLinkOrigin }`, провайдер
   `AppLinks` получает `inject: [BotIdentity, TELEGRAM_LINK_ORIGIN]`, токен
   добавляется в `exports`. Сверить, что приложение поднимается: `pnpm build`
   и тесты, где `BotIdentity` лежит в провайдерах Nest-модуля.
6. **Тест-сторож** `telegram-link-single-point.test.ts` (раздел «Тесты»):
   перечисляет нарушителей по имени файла и строке. Найденные им места
   исполнитель переводит на `webLink`/`deepLink`; список разрешённых файлов
   правится только с причиной в комментарии.

## Чего не трогаем

- Настройку домена, ключ каталога, панель и клиент — T-0090.
- `welcome.command.ts`, `bot-fallback.ts`: `identity.miniAppLink` остаётся как есть
  (в `welcome.command.ts` работает T-0057).
- Порт `platforms/ports/app-links.ts`: интерфейс не меняется.
- Существующие тесты ссылок и бота: ни одна строка. Если какой-то упал,
  значит, поведение изменилось, а это ошибка.
- Клиентские ссылки (`apps/web-telegram/src/main.tsx:70`, `packages/adapter-telegram`).

## Сценарий и интерфейс

Нет: поведение для игрока и команды не меняется, все ссылки прежние.

## Тесты

Первым коммитом, три новых файла в `backend/api/test/`.

`telegram-link-format.test.ts`:

- `webLink("https://t.me", "rubezh_bot", "app")` → `https://t.me/rubezh_bot?startapp`;
- `webLink("https://t.me", "rubezh_bot", "app", "c-Ab12")` → `https://t.me/rubezh_bot?startapp=c-Ab12`;
- `webLink("https://t.me", "rubezh_bot", "chat", "panel-Ab_1-2")` → `https://t.me/rubezh_bot?start=panel-Ab_1-2`;
- параметр `"a b&c"` → `…=a%20b%26c`;
- `webLink("https://telegram.me", …)` → ссылка начинается с `https://telegram.me/rubezh_bot`;
- `deepLink("rubezh_bot", "app", "c-1")` → `tg://resolve?domain=rubezh_bot&startapp=c-1`; `chat` → `…&start=c-1`.

`telegram-link-origin.test.ts` (домен спрашивается в момент сборки):

- `BotIdentity` с `getMe`-заглушкой (как в `welcome.test.ts:144`) и `LinkOrigin`
  из переменной: после `refresh()` `miniAppLink` равен
  `https://t.me/rubezh_bot?startapp`; меняем переменную на `https://telegram.me` —
  следующее чтение даёт `https://telegram.me/rubezh_bot?startapp`, без пересоздания;
- `BotIdentity` без третьего параметра → `https://t.me/rubezh_bot?startapp`;
  до `refresh()` → `null`;
- `new TelegramAppLinks({ miniAppLink: null, username: "rubezh_bot" }, origin)`:
  `chat("panel-X")` → `https://telegram.me/rubezh_bot?start=panel-X` при домене
  `telegram.me`; `chatDeep("panel-X")` → `tg://resolve?domain=rubezh_bot&start=panel-X` при любом домене;
- имя бота неизвестно (`username: null`) → `chat` и `chatDeep` дают `null`.

`telegram-link-single-point.test.ts` (по исходникам, `node:fs`
`readdirSync(…, { recursive: true })` по `backend/api/src`, как делает
`scripts/test/layer-boundaries.test.ts`):

- строки кода (не комментарии: пропустить строки, начинающиеся с `*`, `//`,
  `/*` после пробелов) с `https://t.me`, `tg://resolve`, `telegram.me` или
  `telegram.dog` есть только в `platforms/telegram/telegram-link-format.ts` и
  `modules/settings/setting-catalog.ts` (там тексты подсказок панели);
  сообщение теста называет файл и строку;
- в разрешённых файлах это же правило не проверяется.

## Аналитика

Нет: события и метрики не меняются.

## Настройки и окружение

Нет: ключей и переменных нет, настройка появится в T-0090.

## Документы

Нет: схемы и поведение не меняются. Описание единой точки и настройки — в T-0090.

## Вопросы к тимлиду

- **Подтверждено `claude-lead-1` 13.10.2026:** `launch` и `chat` остаются на двух
  входах (`identity.miniAppLink` и собственный `origin`), чтобы не править 14
  существующих тестов; в проде оба получают один объект `LinkOrigin` из
  `PlatformsModule`. Если нужен один вход, тесты правятся отдельной задачей.

## Критерии приёмки

- [ ] Строка `https://t.me` и форма `?start`/`?startapp`/`tg://resolve` в коде
  бэкенда живут только в `telegram-link-format.ts` (тест-сторож зелёный).
- [ ] Все ссылки (`launch`, `chat`, `launchDeep`, `chatDeep`, `miniAppLink`)
  байт в байт прежние при домене по умолчанию; ни один существующий тест не
  правился.
- [ ] Подмена `LinkOrigin` меняет домен у `miniAppLink` и `chat` без перезапуска.
- [ ] Дифф только в зонах задачи.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `refactor(api): Собрать ссылки Telegram в одном месте`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ССЫЛКИ TELEGRAM В ОДНОМ МЕСТЕ**

  Ссылки на бота и Mini App собираются одной функцией из одного источника домена. Игрок и команда ничего не заметят: все ссылки прежние.

  🛠 **Подготовка к смене домена**

  • тест-сторож не даёт снова зашить `t.me` в строку
  • настройка домена — следующей задачей (T-0090)
  ```
