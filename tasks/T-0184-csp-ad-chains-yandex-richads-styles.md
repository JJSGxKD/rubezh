---
id: T-0184
title: Политика источников пускает сборки Яндекса и стили RichAds — вторая волна цепочек рекламы
epic: E3
priority: P1
status: done
owner: claude-12 / sonnet-5.5 / medium
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
batch: 2
---

# T-0184. Политика источников пускает сборки Яндекса и стили RichAds — вторая волна цепочек рекламы

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0184.json)](README.md#значки-статуса)

## Зачем

После T-0154 на проде (`v0.9.0`) реклама RichAds всё ещё не показывается:
политика клиента режет то, что подтягивает скрипт Яндекса, и стили самой сети.
Игрок остаётся без объявления, а мы — без выручки сети. Задача добавляет в
политику адреса из консоли игрока, по-прежнему не открывая `https:` для
скриптов.

## Решения

Р122 (`docs/35-stage4-plan.md`, 20.10.2026), по консоли Telegram Web участника 1
на `v0.9.0`:

- новые адреса — **только вместе с рекламой**, как SDK сетей и цепочки T-0154;
- скрипты и шрифты Яндекса — **с путём**, а не весь `yastatic.net`: с этого
  хоста Яндекс раздаёт всё подряд, а реклама берёт только два каталога;
- стили RichAds — с хостов сети целиком: путь у их стилей содержит номер
  площадки и меняется;
- `https:` для скриптов и стилей целиком не открываем.

| Что блокировалось | Директива | Источник в политике |
|---|---|---|
| `yastatic.net/partner-code-bundles/…js` — сборки, которые грузит `yandex.ru/ads/system/context.js` | `script-src` | `https://yastatic.net/partner-code-bundles/` |
| `yastatic.net/s3/home/fonts/ys/3/text-variable-full.woff2` — шрифт объявления Яндекса | `font-src` | `https://yastatic.net/s3/home/fonts/` |
| `7ool.net/richpartners/telegram/css/style.css` — стиль `tg-ob.js` | `style-src` | `https://7ool.net` |
| `cdn.adx1.com/publisher-config/<площадка>.css` — настройки площадки, грузит `tg-ob.js` | `style-src` | `https://cdn.adx1.com` |

Источник, кончающийся на `/`, CSP сверяет как приставку пути: под него попадают
все файлы каталога. Без завершающего `/` это был бы один файл.

**Не CSP:** в той же консоли `sad.adsgram.ai/js/sad.min.js` упал с
`net::ERR_TIMED_OUT` — это сеть игрока, а не политика. Загрузчик SDK уже ждёт
15 секунд и отдаёт показ следующей сети (`adapter-telegram/src/ads/script-loader.ts`,
`SCRIPT_TIMEOUT_MS`), здесь ничего не меняется.

## Как сейчас

- `scripts/vite/content-security-policy.ts`:
  - `AD_CHAIN_SCRIPT_SOURCES` (строки 110-115) — цепочки скриптов T-0154;
  - `GOOGLE_FONTS_STYLE_ORIGINS`, `GOOGLE_FONTS_FONT_ORIGINS` (строки 121-122) —
    стиль и шрифт Taddy;
  - `contentSecurityPolicy` (строка 146): `scripts` собирает SDK и цепочки при
    `ads`, `style-src` (строка 158) и `font-src` (строка 167) добавляют Google
    Fonts при `ads`.
- `scripts/test/content-security-policy.test.ts`: `CHAIN_SCRIPTS` (строка 72) и
  тесты «с рекламой скрипты цепочек RichAds из Р108 разрешены дословно…»
  (строка 74), «новые источники скриптов — без шаблонов поддоменов и без http:»
  (строка 81), «с рекламой стиль Google Fonts…» (строка 90), «без рекламы нового
  нет…: MAX и VK» (строка 96), «в dev с рекламой те же адреса» (строка 106).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»): падают, пока адресов нет.
2. **`content-security-policy.ts`:**
   - в `AD_CHAIN_SCRIPT_SOURCES` дописать `"https://yastatic.net/partner-code-bundles/"`;
     в комментарии над списком — строка про Яндекс: что эти сборки грузит
     `context.js` и почему источник с путём, а не хост; фраза «что грузит сам
     скрипт Яндекса, из Р108 не видно» заменяется на то, что теперь видно (Р122);
   - новый список `AD_CHAIN_STYLE_ORIGINS = ["https://7ool.net", "https://cdn.adx1.com"] as const`
     с комментарием: стили `tg-ob.js` RichAds, только при рекламе, хосты — потому
     что путь содержит номер площадки;
   - новый список `AD_CHAIN_FONT_SOURCES = ["https://yastatic.net/s3/home/fonts/"] as const`
     с комментарием: шрифт объявлений Яндекса;
   - `style-src`: при `ads` — Google Fonts и `AD_CHAIN_STYLE_ORIGINS`;
     `font-src`: при `ads` — Google Fonts и `AD_CHAIN_FONT_SOURCES`. Порядок
     директив и всё остальное — как было.
3. **`docs/30-configuration-map.md`** — строка политики источников (там, где
   перечислены списки T-0154): упомянуть два новых списка.

## Чего не трогаем

- `AD_SCRIPT_ORIGINS`, адреса SDK в `adapter-telegram/src/ads/networks.ts`.
- `connect-src`, `img-src`, `media-src`, `frame-src`: креативы и так с любого
  `https:` при рекламе.
- Отчёты о блокировках — T-0155 (она правит тот же файл и идёт после этой задачи).
- Загрузчик SDK и его таймаут.

## Тесты

`scripts/test/content-security-policy.test.ts`:

- тест цепочек скриптов (строка 74): в `CHAIN_SCRIPTS` дописан
  `https://yastatic.net/partner-code-bundles/` — с рекламой он в `script-src`
  дословно, с завершающим `/`;
- новый: «с рекламой стили RichAds разрешены в `style-src`» — `https://7ool.net`
  и `https://cdn.adx1.com` есть, `https:` и `*` в `style-src` нет;
- новый: «с рекламой шрифт Яндекса — в `font-src` с путём» —
  `https://yastatic.net/s3/home/fonts/` есть, голого `https://yastatic.net` нет
  ни в `font-src`, ни в `script-src`;
- тест «без рекламы нового нет…» (строка 96) проверяет и новые списки: ни
  `yastatic.net`, ни `cdn.adx1.com`, ни `7ool.net` в политике без рекламы;
- тест «в dev с рекламой те же адреса» (строка 106) — то же для стилей и шрифтов.

## Аналитика

Нет: политика клиента событий не порождает. Видно будет по показам RichAds в
отчёте рекламы (`ad_shown` по сети).

## Настройки и окружение

Нет.

## Документы

`docs/30-configuration-map.md` — шаг 3.

## Критерии приёмки

- [ ] С рекламой в политике есть все четыре источника из таблицы, ровно в этих
  директивах; без рекламы — ни одного.
- [ ] `script-src` по-прежнему без `https:`, `*` и голых хостов Яндекса.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(web): Пустить сборки Яндекса и стили RichAds в политику`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено [telegram]: реклама RichAds снова загружается`
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СБОРКИ ЯНДЕКСА И СТИЛИ RICHADS В ПОЛИТИКЕ ИСТОЧНИКОВ**

  Вторая волна адресов рекламы по консоли игрока на v0.9.0: политика больше не режет сборки и шрифт Яндекса и стили RichAds. Скрипты по-прежнему только из списка, https: целиком не открыт.

  🛠 **Что добавлено (только с рекламой)**

  • скрипты: yastatic.net/partner-code-bundles/
  • шрифты: yastatic.net/s3/home/fonts/
  • стили: 7ool.net, cdn.adx1.com

  ❓ **Нужно от команды**

  • @участник1 — после выката открыть рекламу RichAds в Telegram Web с консолью и прислать, если там остались блокировки политики
  ```
