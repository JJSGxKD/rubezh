---
id: T-0090
title: QR входа на https, домен ссылок Telegram — настройкой в панели
epic: E14
priority: P2
status: done
owner: claude-5 / sonnet-5.5 / high
author: claude-lead2-10
size: M
depends_on: [T-0091, T-0055]
zones:
  - backend/api/src/platforms/telegram/settings-link-origin.ts
  - backend/api/src/platforms/platforms.module.ts
  - backend/api/test/telegram-link-host.test.ts
  - apps/admin/src/screens/Login.tsx
  - apps/admin/src/screens/login-links.ts
  - apps/admin/test/login-links.test.ts
  - packages/adapter-telegram/src/links.ts
  - packages/adapter-telegram/test/links.test.ts
shared:
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/24-attribution-and-sharing.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 1
---

# T-0090. QR входа на https, домен ссылок Telegram — настройкой в панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0090.json)](README.md#значки-статуса) [![T-0091](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0091.json&label=T-0091)](T-0091-telegram-link-single-point.md) [![T-0055](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0055.json&label=T-0055)](T-0055-external-scripts-switches.md)

## Зачем

Решение пользователя от 13.10.2026 (Р100), две проблемы со ссылками Telegram:

1. QR входа в панель кодирует диплинк `tg://resolve`: камеры Android и Google
   Lens часто показывают его текстом без кнопки «Открыть» (приёмка #285).
   После задачи QR ведёт на `https://t.me/…`, кнопка «Открыть Telegram»
   остаётся диплинком.
2. Пару месяцев назад t.me был недоступен, а все ссылки сервера зашиты на этот
   домен. После задачи домен выбирается настройкой в панели, без релиза.

## Решения

- **QR** — поле `link` ответа входа (`https://t.me/<бот>?start=panel-<id>`),
  **кнопка** — `deepLink ?? link`, **«Открыть в браузере»** — `link`. Бэкенд
  входа (`panel-login.service.ts`) не меняется: обе ссылки он уже отдаёт.
- **Домен** — ключ каталога `telegram.link-host`, умолчание `https://t.me`,
  значения только из списка `https://t.me`, `https://telegram.me`,
  `https://telegram.dog`. По `core.telegram.org/api/links` это равнозначные
  домены ссылок; `telegram.org` там не назван (сайт, а не домен ссылок на бота
  и Mini App), в список не входит. См. «Вопросы к тимлиду».
- **Источник домена** — `LinkOrigin` из T-0091; здесь вместо константы он
  читает настройку. Домен спрашивается в момент сборки ссылки, поэтому панель
  действует без перезапуска. Ссылка кампании `/r/<код>` строится при клике и
  меняется сразу; ссылки, уже лежащие в чатах игроков, не меняются.
- **Диплинки `tg://resolve` от домена не зависят.**
- **Окружения у ключа нет** (`fromEnv: () => null`): решение команды на ходу
  правится в панели (`CLAUDE.md`, «Порты и переменные окружения»). Нового вида
  поля нет: вид `url` (панель проверяет https), а список допустимых значений
  проверяет сервер и отвечает понятным текстом.

## Как сейчас

- `apps/admin/src/screens/Login.tsx`: `:40` — `<QrCode value={bot.deepLink ?? bot.link} …>`;
  `:46` — `href={bot.deepLink ?? bot.link}` у кнопки; `:51` — `href={bot.link}` у
  запасной ссылки. Комментарий над компонентом (`:10-14`) говорит, что QR
  ведёт диплинком.
- `panel-login.service.ts:88,102` — `link` из `links.chat(…)`, `deepLink` из
  `links.chatDeep(…)`. Не меняется.
- `setting-catalog.ts`: виды поля `chat | boolean | url | number` (`:15`);
  образец ссылки — `shopTributeUrl` (`kind: "url"`, `urlSchema`).
  `admin-settings.service.ts:44-52`: `save` проверяет схемой каталога,
  отвечает `ValidationError` с текстом `<название>: <сообщение схемы>` и пишет
  аудит `settings.save`; право — `settings.edit`.
- `platforms.module.ts` (после T-0091): провайдер `TELEGRAM_LINK_ORIGIN` с
  `useValue: fixedLinkOrigin`. Читать настройки из `platforms/telegram` уже
  принято: `welcome.command.ts:12` импортирует `FeatureSwitches`. `SettingsReader`
  и `SETTINGS_READER` — в `modules/settings/settings.service.ts`.
- `packages/adapter-telegram/src/links.ts:32` — `TELEGRAM_HOSTS = new Set(["t.me", "telegram.me"])`
  решает, открывать ли ссылку через `openTelegramLink`; ссылка на
  `telegram.dog` ушла бы во встроенный браузер.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`apps/admin/src/screens/login-links.ts` (новый):**

   ```ts
   /** Что куда ведёт на странице входа: QR — обычная ссылка, кнопка — диплинк. */
   export interface LoginLinks {
     qr: string;
     button: string;
     fallback: string;
   }

   export function loginLinks(bot: { link: string; deepLink?: string | null | undefined }): LoginLinks {
     return { qr: bot.link, button: bot.deepLink ?? bot.link, fallback: bot.link };
   }
   ```

3. **`Login.tsx`:** в ветке `bot.status === "waiting"` — `const links = loginLinks(bot)`;
   `QrCode value={links.qr}`, кнопка `href={links.button}`, запасная ссылка
   `href={links.fallback}`. Комментарий над компонентом: QR ведёт на
   https-ссылку t.me, потому что камеры Android не открывают `tg://`, кнопка —
   диплинком сразу в приложение. Без истории правок.
4. **`setting-catalog.ts`:** рядом с `shopTributeUrl`

   ```ts
   const LINKS_GROUP = "Ссылки Telegram";

   /** Равнозначные домены ссылок Telegram (core.telegram.org/api/links); telegram.org — сайт, в списке его нет. */
   export const TELEGRAM_LINK_ORIGINS: readonly string[] = ["https://t.me", "https://telegram.me", "https://telegram.dog"];

   /** Домен из списка без пути, параметров и учётных данных; иначе `null`. */
   export function telegramLinkOriginOf(value: string): string | null {
     if (!URL.canParse(value)) return null;
     const url = new URL(value);
     const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
     return bare && TELEGRAM_LINK_ORIGINS.includes(url.origin) ? url.origin : null;
   }
   ```

   запись в `SETTINGS`:

   ```ts
   telegramLinkHost: {
     key: "telegram.link-host",
     group: LINKS_GROUP,
     title: "Домен ссылок Telegram",
     hint: "Каким адресом начинаются ссылки на бота и Mini App, которые строит сервер: приглашения, кнопки бота, ссылки кампаний, вход в панель. Допустимы https://t.me (умолчание), https://telegram.me и https://telegram.dog — переключите, если t.me недоступен. Уже разосланные ссылки не меняются",
     kind: "url",
     schema: z
       .string()
       .trim()
       .refine((value) => telegramLinkOriginOf(value) !== null, { message: "один из https://t.me, https://telegram.me, https://telegram.dog" }),
     fromEnv: () => null,
     fallback: "https://t.me",
   } satisfies SettingDefinition<string>,
   ```

5. **`platforms/telegram/settings-link-origin.ts` (новый):**

   ```ts
   import { SETTINGS, telegramLinkOriginOf } from "../../modules/settings/setting-catalog.js";
   import type { SettingsReader } from "../../modules/settings/settings.service.js";
   import { DEFAULT_LINK_ORIGIN, type LinkOrigin } from "./telegram-link-format.js";

   /** Домен ссылок из настройки `telegram.link-host` (Р100); значение, не прошедшее проверку, до ссылки не доходит. */
   export class SettingsLinkOrigin implements LinkOrigin {
     constructor(private readonly settings: Pick<SettingsReader, "get">) {}

     origin(): string {
       return telegramLinkOriginOf(this.settings.get(SETTINGS.telegramLinkHost)) ?? DEFAULT_LINK_ORIGIN;
     }
   }
   ```

6. **`platforms.module.ts`:** провайдер
   `{ provide: TELEGRAM_LINK_ORIGIN, inject: [SETTINGS_READER], useFactory: linkOriginFor }`,
   `export function linkOriginFor(settings: SettingsReader): LinkOrigin { return new SettingsLinkOrigin(settings); }`.
   `SettingsModule` глобальный, импорт не нужен; `PlatformsModule` подключает
   только `app.module.ts`, тестов с ним без настроек нет (найдётся —
   перечислить в PR).
7. **`packages/adapter-telegram/src/links.ts:32`:** добавить `"telegram.dog"` в `TELEGRAM_HOSTS`.
8. **Документы** — раздел «Документы».

## Чего не трогаем

- `panel-login.service.ts`, `admin-session.controller.ts`, `apps/admin/src/api/session.ts`.
- Новый вид поля «выпадающий список» (`SettingsScreen.tsx`, `api/settings.ts`, `SettingKind`).
- Ссылки, которые клиент строит сам: `botUrl()` в `apps/web-telegram/src/main.tsx:70`
  (из `VITE_TELEGRAM_BOT_USERNAME` при сборке); аватарки с `t.me/i/userpic` и
  CSP `AVATAR_ORIGINS`.
- Переходник кампаний (T-0057, T-0058): они берут адрес из `launch`/`chat` и
  подхватят домен сами.
- Чужие записи каталога (T-0070–T-0073 добавляют свои): здесь одна запись и
  функция, конфликт решается перебазированием.

## Сценарий и интерфейс

Вход: QR с https-ссылкой, под ним код, кнопка «Открыть Telegram» (диплинк),
мелкая ссылка «Открыть в браузере». Тексты, загрузка, ошибка и «время вышло»
прежние.

«Настройки» → «Ссылки Telegram» → «Домен ссылок Telegram» (право `settings.edit`):

- значение `https://t.me`, источник «умолчание»;
- «Изменить» → `https://telegram.me` → «Сохранить» → плашка «Домен ссылок
  Telegram»: https://telegram.me;
- `https://telegram.org`, `https://t.me/bot`, `t.me`: панель пропускает всё с
  https, сервер отвечает плашкой «Домен ссылок Telegram: один из https://t.me,
  https://telegram.me, https://telegram.dog»;
- «Сбросить» → «снова из умолчания: https://t.me»;
- загрузка, ошибка и нет сети — общие состояния экрана настроек.

## Тесты

Первым коммитом.

`backend/api/test/telegram-link-host.test.ts` (новый):

- схема `SETTINGS.telegramLinkHost.schema` принимает `https://t.me`,
  `https://telegram.me`, `https://telegram.dog`, `https://t.me/`,
  `  https://telegram.dog  `; отклоняет пустое, `t.me`, `http://t.me`,
  `https://telegram.org`, `https://t.me/rubezh_bot`, `https://t.me.example.com`,
  `https://user@t.me`, `https://t.me:8443`; сообщение отказа содержит `telegram.dog`;
- запись каталога: ключ проходит `SETTING_KEY`, `kind` — `url`, группа «Ссылки
  Telegram», умолчание проходит свою схему, `fromEnv` даёт `null`;
- `telegramLinkOriginOf("https://telegram.me/")` → `https://telegram.me`; `мусор` → `null`;
- `SettingsLinkOrigin` с заглушкой `get`: `https://telegram.dog` → тот же;
  `https://telegram.me/` → `https://telegram.me`; битое `https://evil.example`
  → `https://t.me`; значение меняют между вызовами — результат меняется;
- сквозной: `BotIdentity` (заглушка `getMe`, конфиг как в `welcome.test.ts:144`,
  после `refresh()`) и `appLinksFor(identity, origin)` с общим
  `SettingsLinkOrigin`. При `https://t.me`: `launch("telegram", "c-1")` →
  `https://t.me/rubezh_bot?startapp=c-1`, `chat("telegram", "panel-X")` →
  `https://t.me/rubezh_bot?start=panel-X`. После переключения на
  `https://telegram.me` те же вызовы дают `https://telegram.me/…` с теми же
  параметрами, а `launchDeep`/`chatDeep` прежние (`tg://resolve?domain=rubezh_bot&startapp=c-1`,
  `…&start=panel-X`);
- `linkOriginFor(reader).origin()` читает настройку.

`apps/admin/test/login-links.test.ts` (новый):

- есть `link` и `deepLink` → `qr` = `link`, `button` = `deepLink`, `fallback` = `link`;
- `deepLink: null` и `deepLink` не задан (старый сервер) → `button` = `link`;
- `qr` начинается с `https://` при любом `deepLink`.

`packages/adapter-telegram/test/links.test.ts` (правка кейса `:22`):
`isTelegramLink("https://telegram.dog/rubezh_game")` → `true`;
`http://telegram.dog/x` и `https://telegram.org/x` → `false`.

Существующие `app-links.test.ts`, `panel-login.test.ts`, `settings.test.ts`
правок не требуют и остаются зелёными.

## Аналитика

Нет: события не добавляются. Смена настройки уже попадает в журнал аудита
(`settings.save`), метрик с меткой домена не заводим.

## Настройки и окружение

Новый ключ каталога `telegram.link-host` (раздел «Ссылки Telegram», вид `url`,
умолчание `https://t.me`). Переменной окружения нет, `.env.example` и схема
конфигурации не меняются.

## Документы

- `docs/30-configuration-map.md`: строка рядом с Tribute (искать
  `shop.tribute-url`): «Домен ссылок Telegram, которые строит сервер (бот,
  Mini App, приглашения, ссылки кампаний, вход в панель); t.me недоступен —
  `telegram.me` или `telegram.dog` | панель → «Настройки» → «Ссылки Telegram»
  (`telegram.link-host`, `settings/setting-catalog.ts`); умолчание
  `https://t.me`; разосланные ссылки не меняются | —».
- `docs/29-admin-panel.md`, §8 (искать `Р94`): QR ведёт на https-ссылку t.me,
  кнопка «Открыть Telegram» — диплинком; причина — камеры Android (Р100).
- `docs/24-attribution-and-sharing.md` (искать `в бота`): одной фразой —
  домен ссылок, собираемых сервером, задаёт `telegram.link-host`; ссылка
  кампании строится при клике.

## Вопросы к тимлиду

- **telegram.org не включён.** В `core.telegram.org/api/links` равнозначны
  `t.me`, `telegram.me`, `telegram.dog` и серверный `me_url_prefix`; `telegram.org`
  — сайт. Живой проверки из заблокированной сети нет. *Принято по умолчанию,
  подтвердить:* три домена; четвёртый — правка `TELEGRAM_LINK_ORIGINS` и теста.
- **Редактор — поле `url`, не выпадающий список.** *Принято по умолчанию,
  подтвердить:* вид поля «список» в панели — отдельной задачей, если неверный
  ввод станет мешать.
- **Клиентские ссылки остаются на t.me** (`botUrl()`, CSP аватарок). *Подтверждено
  `claude-lead-1` 13.10.2026:* отдавать ли клиенту домен в ответе входа — отдельной задачей.
- Какой из запасных доменов открывается в заблокированной сети, проверяет
  человек из этой сети.

## Критерии приёмки

- [ ] QR на странице входа кодирует `link` (`https://t.me/…`), кнопка ведёт
  диплинком, запасная ссылка — на `link`.
- [ ] `telegram.link-host` виден в панели, принимает только три домена из
  списка, сброс возвращает `https://t.me`.
- [ ] После переключения `launch`, `chat`, `miniAppLink` и ссылка входа
  собираются с новым доменом без перезапуска; диплинки прежние.
- [ ] `isTelegramLink` принимает `telegram.dog`.
- [ ] Существующие тесты не правились, кроме кейса `links.test.ts:22`; дифф
  только в зонах и в записях `shared`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): QR входа на https и домен ссылок Telegram`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — QR ВХОДА НА HTTPS И ДОМЕН ССЫЛОК TELEGRAM**

  QR на странице входа в панель ведёт на https://t.me, и камеры Android открывают Telegram сразу. Домен ссылок сервера переключается из панели, если t.me снова станет недоступен.

  🔗 **Ссылки Telegram**

  • «Настройки» → «Ссылки Telegram»: t.me, telegram.me или telegram.dog
  • разосланные ссылки не меняются, ссылки кампаний подхватывают домен сразу

  ❓ **Нужно от команды**

  • @участник1 — если t.me недоступен, проверить из этой сети, какой запасной домен открывается
  ```
