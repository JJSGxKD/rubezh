---
id: T-0414
title: Флаги стран у узлов Xray и ручных прокси
epic: E13
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0413, T-0384, T-0385]
zones:
  - apps/admin/src/ui/country-codes.ts
  - apps/admin/src/ui/country-flag.tsx
  - apps/admin/src/screens/proxies/ProxyCard.tsx
  - apps/admin/src/screens/proxies/SubscriptionNodes.tsx
  - apps/admin/src/screens/proxies/subscription-view.ts
  - apps/admin/test/country-flag.test.ts
  - apps/admin/test/proxy-subscription.test.ts
shared:
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: self
design: null
batch: 5
---

# T-0414. Флаги стран у узлов Xray и ручных прокси

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0414.json)](README.md#значки-статуса) [![T-0413](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0413.json&label=T-0413)](T-0413-country-flags-import.md) [![T-0384](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0384.json&label=T-0384)](T-0384-xray-multi-subscription.md) [![T-0385](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0385.json&label=T-0385)](T-0385-xray-node-transport-security.md)

## Зачем

В разделе «Прокси» страна узла Xray и ручного прокси — код текстом («NL»).
В таблице из десятков узлов его читают по буквам. После задачи рядом с
кодом стоит флаг, а название страны всплывает по наведению. Флаги лежат в
панели с T-0413.

## Решения

- **Р201** (`docs/35-stage4-plan.md`), решение владельца:
  - у узлов Xray и ручных прокси вместо кода страны текстом — флаг и код
    рядом;
  - узлы и прокси хранят код из двух букв, файлы флагов названы тремя —
    таблица соответствия в панели;
  - флаги грузятся по одному и лениво, код панели от них не тяжелеет;
  - нет флага или страны — только код или «—», без картинки.

Решения `claude-lead-1` по коду:

1. **Таблица кодов** — `ui/country-codes.ts`. Это ISO 3166-1, пары «две
   буквы → три буквы». Пара заводится, только если для её трёх букв есть
   файл в `apps/admin/public/flags/`. Это проверяет тест.
2. **Псевдоним `UK` → `GBR`** — решение тимлида, подтвердить владельцу.
   Поставщики подписок часто пишут Британию как `[UK]`, а `countryOfName`
   (`packages/proxy-kit/src/country.ts`) отдаёт такой код как есть. Других
   псевдонимов нет.
3. **Флаг — `<img>` по адресу файла**, а не импорт SVG в код. Атрибуты:
   `loading="lazy"`, `decoding="async"`, `width={21}`, `height={16}` (рамка
   флагов 52×40), `alt=""`. Код страны стоит рядом текстом, поэтому
   картинка для диктора лишняя.
4. **Название страны** — `title` у обёртки, через
   `Intl.DisplayNames(["ru"], { type: "region" })`: «Нидерланды». Это
   встроено в браузер, бандл не растёт. Если `Intl` не знает код или
   бросает — в `title` сам код.
5. **Файл не загрузился** (`onError`) — картинка прячется, код остаётся.
6. **Где флаги:**
   - колонка «Страна» в таблице узлов подписки (`SubscriptionNodes`);
   - строка «логин · страна · порядок» в карточке ручного прокси
     (`ProxyCard`).

   Строка «Страны узлов: DE, NL» в карточке подписки, диалоги и трафик —
   без флагов: владелец назвал списки узлов и карточки прокси.

## Как сейчас

- `apps/admin/src/screens/proxies/ProxyCard.tsx:24–26` — строка
  ``{row.username === null ? "Без логина" : …} · {row.country} · порядок {row.priority}``.
  `ProxyRow.country` — строка из двух букв (`api/proxies.ts:27`).
- Таблица узлов: после T-0384 — `SubscriptionNodes.tsx` (колонки «Узел»,
  «Состояние», «Протокол», после T-0385 — «Транспорт», «Безопасность»,
  затем «Страна», «Хост», «Задержка»). Колонка «Страна» —
  `render: (row) => row.countryText`.
- `apps/admin/src/screens/proxies/subscription-view.ts:96–129`:
  - `NodeRow.countryText` (`:103`);
  - `nodeRows` (`:124`) кладёт `countryText: node.country ?? "—"`;
  - `node.country` — `string | null` (`api/proxy-subscription.ts:21`).
- `apps/admin/test/proxy-subscription.test.ts:118` —
  `expect(rows[1]?.countryText).toBe("—")`.
- Флаги — `apps/admin/public/flags/<три буквы строчными>.svg` (T-0413). От
  `index.html` панели адрес — `./flags/nld.svg`: `base: "./"`, маршруты в
  хэше.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`apps/admin/src/ui/country-codes.ts`**:

   ```ts
   /**
    * Код страны из двух букв (ISO 3166-1 alpha-2) → три буквы (alpha-3): так названы
    * файлы флагов в `public/flags/` (Р201, T-0413). Пара — только при файле флага.
    */
   export const ALPHA2_TO_ALPHA3: Readonly<Record<string, string>> = { AD: "AND", AE: "ARE", /* … */ UK: "GBR" /* псевдоним, решение 2 */ };
   /** Адрес флага от страницы панели; кода нет в таблице — `null`. Регистр и пробелы по краям не важны. */
   export function flagSrc(code: string | null): string | null; // "nl" → "./flags/nld.svg"
   /** Название страны по-русски; не знает — сам код. */
   export function countryName(code: string): string;
   ```

   Пары — по ISO 3166-1, по алфавиту двух букв. `UK` — последней строкой с
   комментарием-причиной.
3. **`apps/admin/src/ui/country-flag.tsx`**:

   ```tsx
   /** Флаг и код страны рядом; кода нет — «—», флага нет — только код (Р201). */
   export function CountryFlag({ code }: { code: string | null }): ReactNode;
   ```

   - **`code` пустой или `null`** — `<span className="text-text-muted">—</span>`.
   - **Иначе** —
     `<span className="inline-flex items-center gap-1.5 whitespace-nowrap align-middle" title={countryName(CODE)}>`.
     Внутри — `<img>` по решению 3 (если `flagSrc` не `null` и файл
     загрузился) с `className="shrink-0 rounded-[2px]"` и `<span>{CODE}</span>`.
     `CODE` — код заглавными без пробелов.
   - **`onError`** — `useState` прячет `<img>` (решение 5).
4. **`subscription-view.ts`** — в `NodeRow` поле `countryText: string`
   заменить на `country: string | null`, в `nodeRows` — `country: node.country`.
5. **`SubscriptionNodes.tsx`** — колонка «Страна»:
   `render: (row) => <CountryFlag code={row.country} />`. Остальные колонки
   не трогать.
6. **`ProxyCard.tsx`** — в строке логина вместо `{row.country}` —
   `<CountryFlag code={row.country} />`. Разделители « · » и порядок
   строки — как есть.
7. **Документы** — раздел «Документы».

## Чего не трогаем

- `apps/admin/public/flags/**` и скрипт импорта — T-0413. Флага не хватает —
  вопрос тимлиду, файл руками не добавлять.
- `SubscriptionCard.tsx` (строка «Страны узлов»), `ProxyDialog.tsx`,
  `SubscriptionDialog.tsx`, `TrafficPanel.tsx` — решение 6.
- `ProxiesScreen.tsx` — вкладки, T-0411.
- `packages/proxy-kit` (`countryOfName`) и сервер: коды стран не меняются.

## Сценарий и интерфейс

- **«Прокси» → подписка → таблица узлов:** в колонке «Страна» — флаг 21×16
  и «NL». Наведение на ячейку — «Нидерланды». Флаги грузятся, когда
  таблица на экране: у свёрнутой подписки узлы не рисуются, запросов нет.
- **Узел без страны** — «—» приглушённым, как сейчас.
- **Код, которого нет в таблице** (`XX`, опечатка поставщика), — только
  «XX», без картинки и без запроса.
- **Файл не загрузился** (сеть, 404) — флаг пропадает, код остаётся, строка
  не прыгает.
- **Карточка ручного прокси:** «Без логина · ‹флаг› NL · порядок 1» — флаг
  внутри строки, по высоте строки.
- **Телефон (390 px):** в карточке строки таблицы флаг и код не
  переносятся порознь (`whitespace-nowrap`).

Снимки (таблица узлов и карточка прокси на 390 и 1440 px) — в PR, если у
потока есть dev-сервер; иначе их делает тимлид на приёмке.

## Тесты

Первым коммитом.

- `apps/admin/test/country-flag.test.ts`:
  - **каждая пара `ALPHA2_TO_ALPHA3`:**
    - ключ подходит под `/^[A-Z]{2}$/`, значение — под `/^[A-Z]{3}$/`;
    - есть файл `apps/admin/public/flags/<значение строчными>.svg`
      (`node:fs`, путь от `import.meta.url`).
  - **значения уникальны**, кроме `UK` и `GB` → `GBR`;
  - **пар не меньше 240;**
  - **выборочные пары** — ловят частые путаницы: `NL→NLD`, `DE→DEU`,
    `GB→GBR`, `UK→GBR`, `US→USA`, `RU→RUS`, `AT→AUT`, `AU→AUS`, `NE→NER`,
    `NG→NGA`, `SK→SVK`, `SI→SVN`, `KR→KOR`, `KP→PRK`, `CH→CHE`, `CN→CHN`,
    `CZ→CZE`, `AE→ARE`, `TR→TUR`, `HK→HKG`, `TW→TWN`, `MD→MDA`, `ME→MNE`,
    `MK→MKD`, `KZ→KAZ`, `UA→UKR`, `BY→BLR`;
  - **`flagSrc`:**
    - `flagSrc(" nl ")` → `"./flags/nld.svg"`;
    - `flagSrc("XX")` → `null`;
    - `flagSrc(null)` → `null`;
  - **`countryName`:** `countryName("NL")` → «Нидерланды»; `countryName("XX")`
    — непустая строка, без исключения;
  - **`CountryFlag`** (`renderToStaticMarkup`):
    - `code="nl"` → есть `<img` с `src="./flags/nld.svg"`, `loading="lazy"`,
      `alt=""`, `width="21"`, `height="16"`; текст `NL`, `title="Нидерланды"`;
    - `code="XX"` → `<img` нет, текст `XX`;
    - `code={null}` → `—`, `<img` нет.
  - **SVG в код панели не попадает:** ни один файл `apps/admin/src/**/*.ts(x)`
    не импортирует `.svg`, обход каталога через `node:fs`.
- `apps/admin/test/proxy-subscription.test.ts:118` — ожидание
  `rows[1]?.countryText === "—"` заменить на `rows[1]?.country === null`. В
  соседнем кейсе с заданной страной ожидать `country: "NL"` (или ту, что в
  данных теста).
- Существующие `proxies.test.ts` и `proxy-subscription.test.ts` зелёные.

## Аналитика

Нет: интерфейс панели.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md`, строка «Прокси» в таблице модулей:
  - у списка прокси и у таблицы узлов «страна» — «страна флагом и кодом,
    название — по наведению (Р201, T-0414)»;
  - одной фразой: «флаги — статические файлы `public/flags/` (T-0413),
    грузятся лениво; код без флага показывается текстом».

## Критерии приёмки

- [ ] В таблице узлов и в карточке ручного прокси — флаг и код. По
  наведению — название страны.
- [ ] Нет страны — «—», кода нет в таблице — только код, без запроса
  картинки.
- [ ] Каждая пара таблицы указывает на существующий файл. Выборочные пары
  верны.
- [ ] SVG не импортируются в код панели, `<img>` с `loading="lazy"`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Флаги стран у узлов Xray и прокси`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет
- **Сводка для команды** — исполнитель переносит блок в описание PR как есть и
  вписывает номер PR:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ФЛАГИ СТРАН В РАЗДЕЛЕ «ПРОКСИ»**

  У узлов подписок Xray и ручных прокси страна теперь видна флагом рядом с кодом, название страны — по наведению.

  🛠 **Что важно**

  • флаги грузятся по одному, когда строка на экране
  • код без флага или опечатка поставщика — просто текстом
  • «UK» в названиях узлов читается как Британия
  ```
