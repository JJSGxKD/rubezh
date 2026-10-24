---
id: T-0154
title: Политика источников пускает цепочки SDK рекламы и Google Fonts
epic: E3
priority: P1
status: done
owner: claude-3 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - scripts/vite/content-security-policy.ts
  - scripts/test/content-security-policy.test.ts
shared:
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 1
---

# T-0154. Политика источников пускает цепочки SDK рекламы и Google Fonts

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0154.json)](../README.md#значки-статуса)

## Зачем

SDK рекламных сетей догружают чужие скрипты и стили, а политика клиента их
режет: RichAds без вспомогательных скриптов падает целиком, SDK Taddy не
получает свой шрифт. Игрок остаётся без рекламы сети, а мы — без её выручки.
Эта задача добавляет в политику известные адреса, не открывая `https:` для
скриптов.

## Решения

Р108 (`docs/35-stage4-plan.md`, 19.10.2026), дословно:

- известные цепочки включённых сетей — в список разрешённого `script-src`,
  **только вместе с рекламой**, как сами SDK;
- Google Fonts: `fonts.googleapis.com` в `style-src` и `fonts.gstatic.com` в
  `font-src`, тоже **только с рекламой**;
- `https:` для скриптов целиком не открываем.

Адреса цепочек из Р108 (других нет, придумывать не нужно):

| Сеть | Что подтягивает | Источник в политике |
|---|---|---|
| RichAds (`tg-ob.js`) | `md5.js` и другие части SDK с `7ool.net` | `https://7ool.net` |
| RichAds | `/users/info?callback=…` с двух хостов `convers.link` | `https://eu.convers.link`, `https://us.convers.link` |
| RichAds | скрипт Яндекса | `https://yandex.ru/ads/system/context.js` |

Источник с путём в CSP сверяется с путём целиком. `7ool.net` — отдельный домен
сети, с которого SDK догружает свои части (`md5.js` — первая из них), поэтому он
разрешён целиком. Для Яндекса — путь из решения: `yandex.ru` слишком широк. Для
`convers.link` — хосты: скрипт ответа
идёт с параметрами обратного вызова, и путь решение не называет.

**Что грузит сам скрипт Яндекса, из решения не видно.** Тут перечисляется
только то, что названо в Р108. Остальное покажут отчёты о блокировках
(T-0155, T-0156): список дополняется по ним, отдельной задачей, а не
догадкой. Исполнитель ничего сверх таблицы не добавляет.

## Как сейчас

- `scripts/vite/content-security-policy.ts:84–93` — `AD_SCRIPT_ORIGINS`:
  SDK четырёх сетей и их поддомены. Комментарий над ним (строки 79–83)
  говорит «только их SDK» — после задачи это перестаёт быть полной правдой и
  комментарий обновляется.
- там же, строка 120 — `scripts`: набор `script-src` собирается
  из Graspil и `AD_SCRIPT_ORIGINS` только при `ads: true`.
- строка 129 — `style-src`: `'self'`, `'unsafe-inline'`; строка 138 —
  `font-src`: только `'self'`. Креативы (`img-src`, `media-src`, `frame-src`)
  и `connect-src` уже открыты на `https:` при рекламе (строки 102, 121–122,
  132–134).
- `packages/adapter-telegram/src/ads/networks.ts:84` — `RICHADS_SCRIPT`
  (`richinfo.co`, уже разрешён в `AD_SCRIPT_ORIGINS`).
- `scripts/test/content-security-policy.test.ts:57–69` — тест рекламы: что
  скрипты сетей на месте и что `'unsafe-inline'`, `'unsafe-eval'`, `https:`,
  `*` в `script-src` нет. Тестов на `style-src` и `font-src` с рекламой нет.
- Политику без правок читают все: `apps/web-telegram/vite.config.ts:100`
  (файл `csp.txt` для Caddy, `deploy.sh`), `scripts/vite/dev-server.ts:79–86`
  (dev и просмотр сборки). Менять их не нужно: список один на всех.
- MAX и VK рекламу сетей не показывают, `ads: true` у них нет — новые адреса
  в их политику не попадают, и так должно остаться.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. `content-security-policy.ts`: рядом с `AD_SCRIPT_ORIGINS` добавить
   `AD_CHAIN_SCRIPT_SOURCES` — константа `as const` из пяти адресов таблицы,
   в комментарии на русском: какой SDK что подтягивает (по таблице выше) и
   почему путь указан только у Яндекса.
3. Добавить `GOOGLE_FONTS_STYLE_ORIGINS = ["https://fonts.googleapis.com"]` и
   `GOOGLE_FONTS_FONT_ORIGINS = ["https://fonts.gstatic.com"]` с комментарием:
   стиль Roboto тянет SDK Taddy; нужны только при рекламе.
4. В `contentSecurityPolicy`: при `ads` — `scripts` дополняется
   `AD_CHAIN_SCRIPT_SOURCES`, `style-src` — `GOOGLE_FONTS_STYLE_ORIGINS`,
   `font-src` — `GOOGLE_FONTS_FONT_ORIGINS`. Без `ads` оба остаются прежними
   (`style-src`: `'self' 'unsafe-inline'`, `font-src`: `'self'`).
5. Обновить комментарий над `AD_SCRIPT_ORIGINS` и шапку файла (абзац про
   скрипты, строки 10–11): теперь «свои плюс SDK сетей и известные цепочки их
   подгрузки, список — по Р108».
6. `docs/30-configuration-map.md`: строка рядом с Graspil (строка 231 —
   «домены в политике источников»): где лежит список цепочек рекламы
   (`scripts/vite/content-security-policy.ts` → `AD_CHAIN_SCRIPT_SOURCES`) и
   что дополняется он по отчётам о блокировках после T-0155.

## Чего не трогаем

- `https:` в `script-src` и `connect-src` не добавляем сверх нынешнего.
- Яндекс: ни `yastatic.net`, ни `an.yandex.ru`, ни других адресов, которых
  нет в Р108. Список пополнят по отчётам.
- Политику панели (`apps/admin/src/csp.ts`) — у неё сторонних скриптов нет.
- Директиву отчётов (`report-uri`) — это T-0155, и она правит тот же файл.
- `AD_CREATIVE_SOURCES` и поддомены уже перечисленных сетей.

## Тесты

Пишутся первым коммитом, до кода. Файл — `scripts/test/content-security-policy.test.ts`,
рядом с тестом рекламы (строки 57–69).

- с `ads: true` в сборке `script-src` содержит все пять адресов таблицы
  дословно, и по-прежнему не содержит `'unsafe-inline'`, `'unsafe-eval'`,
  `https:`, `*`;
- с `ads: true` `style-src` содержит `https://fonts.googleapis.com` и
  `'unsafe-inline'`, `font-src` равен `'self' https://fonts.gstatic.com`;
- без рекламы (`build`, а также `graspil: true` без `ads`) ни одного из
  новых адресов нет ни в `script-src`, ни в `style-src`, `font-src`;
  `font-src` равен `['self']`;
- в `dev` с рекламой те же адреса присутствуют (политика dev строится из
  того же списка);
- ни один из новых скриптовых источников не начинается с `http:` и не
  содержит `*` — шаблон поддоменов в цепочках не нужен.

## Аналитика

Нет: правка списка разрешённого, событий игрока не порождает.

## Настройки и окружение

Нет: список — константа в коде, как у остальных сетей. Новых переменных и
ключей каталога настроек нет.

## Документы

- `docs/30-configuration-map.md` — строка из шага 6.
- `docs/35-stage4-plan.md` не правится: Р108 уже записано.

## Критерии приёмки

- [ ] В политике Telegram-сборки с рекламой есть ровно пять новых скриптовых
      источников из таблицы, `fonts.googleapis.com` в `style-src` и
      `fonts.gstatic.com` в `font-src`; других новых адресов нет.
- [ ] В политике без рекламы (MAX, VK) нового нет.
- [ ] `script-src` по-прежнему без `https:`, `*`, `'unsafe-eval'`.
- [ ] Тесты из раздела «Тесты» есть и написаны до кода.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(web-telegram): Пустить цепочки SDK рекламы в политику`
- **Метка:** `release: patch`
- **Для игроков:**
  - `- исправлено [telegram]: реклама сети RichAds больше не обрывается из-за блокировки её вспомогательных скриптов`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЦЕПОЧКИ SDK РЕКЛАМЫ В ПОЛИТИКЕ ИСТОЧНИКОВ**

  Политика источников клиента пускает вспомогательные скрипты RichAds (7ool.net, convers.link, Яндекс) и шрифты Google Fonts для SDK Taddy. Только в сборке Telegram с рекламой; https: для скриптов целиком не открыт.

  🛠 **Что дальше**

  • Что ещё подгружает скрипт Яндекса, покажут отчёты о блокировках (T-0155, T-0156)
  ```
