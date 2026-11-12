---
id: T-0428
title: Удалить интеграцию AdSonar — сеть закрылась, вырезаем под корень
epic: E7
priority: P2
status: done
owner: claude-lead-1 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: []
zones:
  - packages/adapter-telegram/src/ads/networks.ts
  - packages/adapter-telegram/src/ads/ad-shower.ts
  - packages/adapter-telegram/test/ads.test.ts
  - backend/api/src/modules/ads/ad-networks.ts
  - backend/api/prisma/migrations/20261111090000_remove_adsonar/**
  - backend/api/test/ads.test.ts
  - backend/api/test/ads-tools.test.ts
  - backend/api/test/ads.integration.test.ts
  - backend/api/test/wheel.test.ts
  - backend/api/test/run-ad-continue.test.ts
  - backend/api/test/run-double.test.ts
  - backend/api/test/helpers/memory-ads.ts
  - packages/app-shell/src/screens/ads-check.tsx
  - packages/app-shell/src/i18n/ru-team.json
  - packages/app-shell/test/ads-check-rules.test.ts
  - packages/app-shell/test/ad-watch.test.ts
  - apps/admin/test/overview.test.ts
  - scripts/vite/content-security-policy.ts
  - scripts/test/content-security-policy.test.ts
  - scripts/test/no-adsonar.test.ts
  - scripts/bundle-budget.mjs
  - docs/01-tech-stack.md
  - docs/02-roadmap.md
  - docs/21-diagrams.md
  - docs/27-design-system-and-app-shell.md
  - docs/28-diagnostics.md
shared:
  - backend/api/test/ad-networks.test.ts
  - packages/adapter-telegram/src/index.ts
  - packages/shared-types/src/index.ts
  - apps/admin/src/ui/help.ts
  - apps/admin/src/api/overview.ts
  - apps/admin/src/ui/inline-code.tsx
runner: any
executor: sonnet-5.5
effort: high
release: patch
merge: lead
design: null
batch: 4
---

# T-0428. Удалить интеграцию AdSonar — сеть закрылась, вырезаем под корень

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0428.json)](../README.md#значки-статуса)

## Зачем

AdSonar закрылся 16.10.2026. Мы его так и не подключили: данных от него не
храним, блоков на него не заводили. Но сеть осталась в коде, в профилях
панели, в адресах CSP и в базе выключенной строкой — панель предлагает
завести блок на сеть, которой нет, а CSP пускает скрипты чужого домена.
Интеграция удаляется целиком, остальные сети работают как раньше.

## Решения

- **Р206** (`docs/35-stage4-plan.md`, 10.11.2026, решение владельца): AdSonar
  закрыт, интеграция удаляется. Исполнитель решение не пересматривает.
- **Рефакторинг без смены поведения остальных сетей.** AdsGram, RichAds и
  Taddy, порядок круга и правила ротации не меняются. В тестах `adsonar` был
  всего лишь «вторым именем сети» — его заменяют другой существующей сетью
  (`richads` или `taddy`), а не удаляют кейс.
- **Миграция — только данные, схема не меняется.** `network_key` — строка, а
  не enum, поэтому `schema.prisma` не трогаем и порядок «expand → contract»
  не нужен: убирается одна строка справочника, на которую код уже не
  ссылается. Строка `ad_network` для `adsonar` заведена начальной миграцией
  `20260930105150_ads` выключенной (`active = false`). Старый код при выкате не
  пострадает (он читает сети из базы, а строки нет), новый строку не ждёт.
- **Историю не переписываем:** старые миграции, `tasks/archive`,
  `docs/audit/raw` и исторические разделы «Как сделано» в
  `docs/35-stage4-plan.md` и `docs/36-parallel-work.md` не трогаем — они
  описывают прошлое.

## Как сейчас

Все упоминания (`rg -i "sonar"` без `node_modules`, `dist`, `tasks/archive`,
`docs/audit/raw`):

- **Адаптер Telegram.** `packages/adapter-telegram/src/ads/networks.ts`:
  `SonarShowParams` (стр. 35), поле `Sonar` в `AdGlobals` (67),
  `ADSONAR_SCRIPT` (83), `createAdsonar()` (167–…). `ad-shower.ts`: импорт
  `createAdsonar` (стр. 2) и запись `adsonar: createAdsonar()` (41).
  `adapter-telegram/src/index.ts` (36) — комментарий со списком сетей.
- **Сервер.** `backend/api/src/modules/ads/ad-networks.ts`: комментарий (19) и
  целый профиль `{ key: "adsonar", … }` в `AD_NETWORK_PROFILES` (стр. 174–204).
  `packages/shared-types/src/index.ts` (52) — комментарий к полю `network`.
- **База.** `backend/api/prisma/migrations/20260930105150_ads/migration.sql`
  (стр. 85) вставляет строку `('adsonar', 'AdSonar', false, 20, now())` в
  `ad_network`. Модель `AdNetwork` (`schema.prisma` ~1826): `networkKey`
  `@id`, связи `blocks AdBlock[]` и `networkTask NetworkTask?` с внешними
  ключами без каскада. Своих строк `ad_block` и `network_task` у `adsonar`
  быть не должно (блоков не заводили).
- **Оболочка игры.** `packages/app-shell/src/screens/ads-check.tsx` (85) —
  заметка про режим AdSonar для сети `adsonar`; ключ
  `adsCheck.sonarNote` в `packages/app-shell/src/i18n/ru-team.json` (264).
- **Панель.** `apps/admin/src/api/overview.ts` (208) — `NETWORK_TITLES`
  с `adsonar`; `apps/admin/src/ui/help.ts` (36) — справка про площадки
  сетей; `apps/admin/src/ui/inline-code.tsx` (2) — пример `Sonar.show` в
  комментарии.
- **CSP.** `scripts/vite/content-security-policy.ts` (102–103):
  `https://static.sonartech.io` и `https://*.sonartech.io` в источниках
  скриптов; проверка — `scripts/test/content-security-policy.test.ts` (61).
- **Бюджет.** `scripts/bundle-budget.mjs` (56) — только комментарий; пороги
  не меняем.
- **Тесты, где `adsonar` — второе имя сети:**
  `packages/adapter-telegram/test/ads.test.ts` (кейс «AdSonar: …», стр. 72–105,
  импорты `ADSONAR_SCRIPT`, `SonarShowParams`),
  `backend/api/test/ads.test.ts`, `ads-tools.test.ts`,
  `ads.integration.test.ts` (77–78: ожидает четыре заведённые сети),
  `wheel.test.ts`, `run-ad-continue.test.ts`, `run-double.test.ts`,
  `helpers/memory-ads.ts` (297: ключи `adsonar`),
  `packages/app-shell/test/ad-watch.test.ts`, `ads-check-rules.test.ts`,
  `apps/admin/test/overview.test.ts` (102).
- **Документы:** `docs/01-tech-stack.md` (129), `docs/02-roadmap.md` (303),
  `docs/21-diagrams.md` (792, подпись `network_key`),
  `docs/27-design-system-and-app-shell.md` (255),
  `docs/28-diagnostics.md` (146, режим AdSonar у первого показа).

## Шаги по порядку

1. **Тест до кода** — первым коммитом (раздел «Тесты»), он красный.
2. **Адаптер Telegram.** В `networks.ts` удалить `SonarShowParams`, поле
   `Sonar` из `AdGlobals`, `ADSONAR_SCRIPT`, `createAdsonar()` и всё, что
   осталось без использования (общие помощники, которыми пользовались
   остальные сети, не трогать). В `ad-shower.ts` убрать импорт и запись
   `adsonar`. Комментарий в `index.ts` — список сетей без AdSonar.
3. **Сервер.** В `ad-networks.ts` удалить профиль `adsonar` целиком и
   упоминание в шапке файла. Комментарий в `shared-types` — без `adsonar`.
4. **Миграция** `backend/api/prisma/migrations/20261111090000_remove_adsonar/migration.sql`
   (одна папка; `prisma migrate dev --create-only` не нужен — схема не
   меняется, файл пишется руками). Содержимое, дословно:

   ```sql
   -- AdSonar закрыт 16.10.2026 (Р206): убираем выключенную строку справочника.
   -- Блоки и показы сети не заводились; если они всё же есть, строку не
   -- трогаем — история показов ссылается на сеть.
   DELETE FROM "network_task" WHERE "network_key" = 'adsonar'
     AND NOT EXISTS (SELECT 1 FROM "ad_block" WHERE "network_key" = 'adsonar');
   DELETE FROM "ad_network" WHERE "network_key" = 'adsonar'
     AND NOT EXISTS (SELECT 1 FROM "ad_block" WHERE "network_key" = 'adsonar');
   ```

   Имена таблиц и колонок исполнитель сверяет со `schema.prisma` (`@@map`,
   `@map`) и правит, если они иные, — смысл не меняется. `schema.prisma` и
   старые миграции не трогать.
5. **Оболочка.** В `ads-check.tsx` убрать строку с `adsCheck.sonarNote` и
   ключ из `ru-team.json`. Если после этого в файле остались неиспользуемые
   импорты или переменные — убрать.
6. **Панель.** Убрать `adsonar` из `NETWORK_TITLES`; в `help.ts` — «AdsGram,
   RichAds и Taddy — только Telegram» (остальной текст дословно); в
   комментарии `inline-code.tsx` заменить пример на пример из профиля
   AdsGram или Taddy (какой есть в `ad-networks.ts`).
7. **CSP.** Убрать оба адреса `sonartech.io` из `content-security-policy.ts`.
   Остальные источники и порядок не менять.
8. **Тесты-фикстуры.** Везде, где `adsonar` служил вторым именем сети,
   заменить на `richads` или `taddy` — так, чтобы ожидаемый порядок круга и
   числа остались осмысленными (если ожидание зависело от приоритета 20,
   подставить приоритет заменившей сети из тестового набора и поправить
   порядок в `expect`, а не подгонять приоритет). Кейс AdSonar в
   `adapter-telegram/test/ads.test.ts` удалить целиком. В
   `ads.integration.test.ts` ожидаемый список заведённых сетей — три:
   `adsgram`, `richads`, `taddy`.
9. **Документы.** Убрать AdSonar из текущих описаний в `docs/01`, `02`, `21`
   (подпись `network_key` — `adsgram, richads, taddy`), `27`; в `28` — убрать
   предложение про режим AdSonar, остальное не менять. Если абзац после
   правки остаётся без смысла — переписать его, а не оставлять огрызок.
10. **Бюджет и сборка.** `pnpm build` и `pnpm budget`: чанк рекламы не вырос
    (скорее уменьшился); пороги в `scripts/bundle-budget.mjs` не двигать,
    комментарий там — без AdSonar.
11. Гейт из `CLAUDE.md`, `pnpm docs:check`, затем `rg -i "sonar"` по
    проекту: остаться должны только старая миграция `20260930105150_ads`,
    новая `20261111090000_remove_adsonar`, `tasks/`, `docs/35`, `docs/36`,
    `docs/audit/raw` и сам `no-adsonar.test.ts`.

## Чего не трогаем

- `schema.prisma` и старые миграции — меняется только набор данных новой
  миграцией.
- AdsGram, RichAds и Taddy: профили, обёртки SDK, ключи, приоритеты,
  правила ротации — ни строки (кроме подстановки имён в тестах).
- Исторические разделы «Как сделано» в `docs/35-stage4-plan.md` и таблицу
  `docs/36-parallel-work.md`, `tasks/archive/`, `docs/audit/raw/`.
- Каталог ключей интеграций (`secret-catalog.ts`) и каталог настроек
  (`setting-catalog.ts`): упоминаний AdSonar в них нет (проверено разведкой);
  если найдёшь, это вопрос тимлиду, а не правка «заодно».
- Пороги `scripts/bundle-budget.mjs` и остальные источники CSP.
- Задача T-0409 (архив рекламных блоков) правит соседние файлы модуля
  рекламы: перед правкой `ad-networks.ts` и тестов `ads-tools.test.ts`
  выполни `pnpm task holds <путь>` и не лезь в чужие строки.

## Сценарий и интерфейс

Игрок ничего не заметит: AdSonar не показывался ни разу. В панели «Реклама»
исчезает профиль сети AdSonar: форма блока её не предлагает, в списке сетей
её нет. Экраны и состояния не меняются.

## Тесты

Пишутся первым коммитом, до кода.

- `scripts/test/no-adsonar.test.ts` (новый) — обходит исходники и тесты
  (`backend/api/src`, `backend/api/test`, `packages/*/src`, `packages/*/test`,
  `apps/*/src`, `apps/*/test`, `scripts/vite`, `scripts/bundle-budget.mjs`,
  файлы `i18n/*.json`), без `node_modules` и `dist`, кроме самого себя;
  регулярка `/sonar/i`. Совпадение — падение с путём файла и номером строки
  в сообщении. Пути — через `node:path`, чтение — `node:fs`. Миграции в обход
  не входят, поэтому каталог `backend/api/prisma` не сканируется.
- `scripts/test/content-security-policy.test.ts` — `script-src` с рекламой
  содержит `'self'`, `https://sad.adsgram.ai`, `https://richinfo.co`,
  `https://sdk.taddy.pro` и **не содержит** ни одного адреса с `sonartech`.
- `backend/api/test/ads.integration.test.ts` — после всех миграций в
  `ad_network` нет строки `adsonar`, а `adsgram`, `richads`, `taddy`
  заведены выключенными в прежнем порядке приоритета.
- `backend/api/test/ads-tools.test.ts` — профили сетей в выдаче панели:
  `adsgram`, `richads`, `taddy`; сети `adsonar` нет.
- `backend/api/test/ads.test.ts` — круг сетей, ротация, отказы
  работают на `adsgram`, `richads`, `taddy`; ожидания прежние по смыслу.
- `packages/adapter-telegram/test/ads.test.ts` — оставшиеся сети проходят,
  запрос с `network: "adsonar"` не создаёт обёртку (показ завершается
  отказом `misconfigured` или тем исходом, который адаптер возвращает для
  неизвестной сети — сверить по коду `ad-shower.ts`). Этот кейс — исключение
  из `no-adsonar.test.ts`: строка с именем неизвестной сети собирается в
  тесте из частей (`"ad" + "sonar"`), чтобы проверка упоминаний не падала.
- `packages/app-shell/test/ad-watch.test.ts`, `ads-check-rules.test.ts`,
  `apps/admin/test/overview.test.ts` — те же кейсы на оставшихся сетях;
  `networkTitle` для неизвестной сети возвращает ключ как есть — так же,
  как для любого другого неизвестного ключа (кейс в `overview.test.ts` с
  `"adsonar"` заменить на произвольный неизвестный ключ `"unknown_net"`).
- `scripts/bundle-budget.mjs` — `pnpm budget` проходит без правки порогов.

## Аналитика

Нет: новых событий нет. Сеть `adsonar` не выпускала `ad_*` событий (блоков
не было), словарь `docs/22-analytics-and-metrics.md` её не упоминает.

## Настройки и окружение

Нет. Ключей настроек и секретов AdSonar в каталогах нет. Переменных
окружения нет.

## Документы

`docs/01-tech-stack.md`, `02-roadmap.md`, `21-diagrams.md`,
`27-design-system-and-app-shell.md`, `28-diagnostics.md` — текущие описания
сетей без AdSonar. Схема БД: ER-диаграмма в `docs/21` — только подпись у
`network_key` (структура таблиц не меняется).

## Критерии приёмки

- [ ] `rg -i "sonar"` по проекту находит только перечисленное в шаге 11.
- [ ] `no-adsonar.test.ts` зелёный и падает, если вернуть упоминание.
- [ ] CSP без `sonartech`, остальные источники прежние.
- [ ] Миграция — одна папка, только данные; `schema.prisma` не изменён;
      на живой базе строки `adsonar` нет, остальные три на месте.
- [ ] `pnpm budget` зелёный, пороги не менялись, чанк рекламы не вырос.
- [ ] Поведение AdsGram, RichAds и Taddy не изменилось (их тесты без правок
      ожиданий, кроме подстановки имён).
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `refactor(ads): Удалить интеграцию AdSonar`
- **Метка:** `release: patch`
- **Для игроков:** нет (раздела `## Для игроков` в описании PR нет)
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — УДАЛИТЬ ИНТЕГРАЦИЮ ADSONAR**

  AdSonar закрылся 16.10.2026 (Р206), мы его не подключали. Сеть убрана из
  кода, панели, CSP и базы; AdsGram, RichAds и Taddy работают как прежде.

  🛠 **Реклама**

  • из профилей сетей и формы блока в панели пропал AdSonar
  • в политике источников убраны адреса sonartech.io
  • миграция убирает выключенную строку сети из справочника
  ```
