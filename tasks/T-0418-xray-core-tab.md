---
id: T-0418
title: Вкладка «Ядро Xray» — версия, свежий выпуск, совместимость и кнопка «Обновить»
epic: E13
priority: P2
status: done
owner: claude-60 / sonnet-5.5 / medium
author: claude-lead-1
size: M
depends_on: [T-0416, T-0411]
zones:
  - apps/admin/src/api/xray-core.ts
  - apps/admin/src/screens/proxies/XrayCorePanel.tsx
  - apps/admin/src/screens/proxies/xray-core-view.ts
  - apps/admin/src/screens/proxies/proxies-tabs.ts
  - apps/admin/src/screens/proxies/ProxiesScreen.tsx
  - apps/admin/test/xray-core.test.ts
  - apps/admin/test/proxies-tabs.test.ts
shared:
  - apps/admin/src/ui/help.ts
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: null
batch: 5
---

# T-0418. Вкладка «Ядро Xray» — версия, свежий выпуск, совместимость и кнопка «Обновить»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0418.json)](README.md#значки-статуса) [![T-0416](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0416.json&label=T-0416)](T-0416-xray-core-server.md) [![T-0411](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0411.json&label=T-0411)](T-0411-proxies-tabs.md)

## Зачем

Сервер уже знает запущенную версию Xray, свежий выпуск XTLS и совместимость
с нашим конфигом и умеет запустить обновление (T-0416). После задачи всё это
видно во вкладке «Ядро Xray» раздела «Прокси», а владелец одной кнопкой
запускает PR с новой версией (Р202). Если перейти нельзя, вкладка прямо
говорит: «Перейти нельзя, нужно обновить код».

## Решения

- **Р202** (`docs/35-stage4-plan.md`) и **Р201** (вкладки «Прокси»).
  Исполнитель их не пересматривает.
- **Место** — вкладка `core` «Ядро Xray» **после «Трафика»**:
  `xray`, `traffic`, `core`, `manual`, `modes` (T-0411 оставил место
  «по смыслу — после «Трафика»»). Адрес — `#/proxies/core`.
- **Что решает сервер, панель не пересчитывает**: совместимость
  (`compatibility.kind`) и можно ли нажать (`update.blockedBy`) приходят в
  ответе. Панель только переводит коды в слова (`xray-core-view.ts`).
- **Кнопки только у `proxies.edit`** (владелец): «Проверить сейчас» и
  «Обновить до <версия>». У `proxies.view` — те же сведения без кнопок;
  строка «Заводить, менять и проверять прокси может только владелец…» уже
  стоит под вкладками (T-0411).
- **Нет ключа** (`update.configured === false`) — вместо кнопки строка
  «Кнопка «Обновить» появится, когда в «Ключах интеграций» задан
  github.xray-update» со ссылкой на раздел `#/secrets`.
- **Подтверждение** — `ConfirmDialog` (`ui/confirm-dialog.tsx`), без причины:
  действие обратимо (PR можно закрыть).
- **Пока запуск идёт** (`update.lastRun.active`) — вкладка перечитывает
  состояние раз в 15 секунд; закончился или ушли с вкладки — опрос
  останавливается.
- **Тексты для человека — дословно** (раздел «Сценарий и интерфейс»).

## Как сейчас

- После T-0411: `apps/admin/src/screens/proxies/proxies-tabs.ts` —
  `PROXY_TABS` (`xray`, `traffic`, `manual`, `modes`), `proxyTabOf`,
  `proxyTabRoute`; `ProxiesScreen.tsx` рисует `TabBar` и ветку на вкладку;
  `apps/admin/test/proxies-tabs.test.ts` сверяет список id.
- После T-0416: `GET /admin/xray-core` → `{ data: XrayCoreView }`,
  `POST /admin/xray-core/refresh`, `POST /admin/xray-core/update` с телом
  `{ version }`. Форма ответа — `XrayCoreView` в
  `backend/api/src/modules/proxies/xray-core/xray-core.service.ts`; коды
  `blockedBy` — `no_token`, `no_release`, `blocked`, `older`, `up_to_date`,
  `in_code`, `running`, `locked`; `compatibility.kind` — `tested`,
  `untested`, `older`, `blocked` (с `reason`), `unknown`.
- Образцы: `apps/admin/src/api/proxy-subscription.ts` (Zod-схема ответа,
  `api.request`), `screens/proxies/SubscriptionPanel.tsx` (`Panel`,
  `KeyValue`, `Badge`, `Notice`, `ConfirmDialog`, `toast`, `useApi`),
  `ui/kit.tsx` — `blockedReason` для причины выключенной кнопки.
- `apps/admin/src/ui/help.ts:272` — подсказки раздела `proxies`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`apps/admin/src/api/xray-core.ts`** — Zod-схемы `XrayCoreView` (поля —
   как у сервера; `compatibility` — `z.discriminatedUnion("kind", …)`;
   незнакомый `blockedBy` и `kind` не роняют разбор:
   `z.string()` с сужением в `xray-core-view.ts`), функции
   `fetchXrayCore(api)`, `refreshXrayCore(api)` (`timeoutMs: 15_000`),
   `updateXrayCore(api, version)`.
3. **`screens/proxies/xray-core-view.ts`** — чистые функции текстов:
   - `compatibilityText(c): { tone: "success" | "warning" | "danger" | "neutral"; label: string; detail: string | null }`;
   - `blockedText(code: string, lockedUntil: string | null): string`;
   - `runText(run): { tone; label }`;
   - `testedRangeText(min, max): string`;
   - `runningNote(running): { tone: "warning" | "info"; text: string } | null`.
   Незнакомый код — сам код, а не пусто.
4. **`screens/proxies/XrayCorePanel.tsx`** — `XrayCorePanel({ canEdit })`:
   `useApi(fetchXrayCore)`, разметка и состояния по разделу «Сценарий и
   интерфейс», опрос по решению, `ConfirmDialog` для запуска.
5. **`proxies-tabs.ts`** — строка `{ id: "core", title: "Ядро Xray" }` после
   `traffic`; **`ProxiesScreen.tsx`** — ветка `tab === "core"` →
   `<XrayCorePanel canEdit={canEdit} />`.
6. **`ui/help.ts`** — ключ `proxies.core`: «Какая версия Xray запущена на
   сервере, что вышло у XTLS и подойдёт ли нашему конфигу. «Обновить»
   открывает PR с новой версией через GitHub; на прод ядро уезжает выпуском
   после вливания».
7. **Документы** — раздел «Документы».

## Чего не трогаем

- Сервер, ключ интеграций, workflow — T-0416 и T-0417.
- Другие вкладки «Прокси» и `TabBar` — T-0410, T-0411, T-0384…T-0386.
- Раздел «Ключи интеграций» — ключ `github.xray-update` появляется там сам из
  каталога сервера.

## Сценарий и интерфейс

Вкладка — одна `Panel` «Ядро Xray» с подсказкой `HELP.proxies.core`, в шапке
— кнопка «Проверить сейчас» (только `proxies.edit`). Внутри, сверху вниз:

1. **«Запущено»** — `KeyValue`:
   - «Версия» — номер и значок совместимости запущенной версии;
   - «Запущено» — дата и время `startedAt` (`formatDateTime`) или «—»;
   - `running.state === "missing"` — вместо номера «Ядро не сообщило
     версию», под ним мелко: «Контейнер Xray не запущен или собран до версии
     со статусом ядра. В dev контейнера нет»;
   - `running.state === "unreadable"` — «Версия не распознана — проверьте
     контейнер Xray»;
   - `runningNote`: запущенная `older` — `Notice` warning «Запущенное ядро
     старше проверенных версий — выкатите выпуск»; `untested` — info
     «Запущенное ядро новее проверенных версий».
2. **«Свежий выпуск XTLS»** — `KeyValue`:
   - «Версия» — номер ссылкой на страницу выпуска (`latest.url`, новая
     вкладка, `rel="noreferrer"`);
   - «Вышел» — `publishedAt` или «—»;
   - «Проверено» — `checkedAt`;
   - `latest === null` и `latestError` — `Notice` warning с текстом ошибки
     сервера; оба `null` — «Выпуск ещё не проверялся».
3. **«Совместимость»** — значок и строка `compatibilityText(latest.compatibility)`:
   - `tested` — success «Проверено», «Наш конфиг принят этой версией»;
   - `untested` — warning «Не проверено», «Проверит CI в PR обновления»;
   - `blocked` — danger «Перейти нельзя, нужно обновить код», под ним
     причина из ответа;
   - `older` — neutral «Старше проверенных», «Обновляться на неё незачем»;
   - `unknown` — neutral «Версия не распознана».
   Ниже мелко `testedRangeText`: «Проверена версия 26.10.31» (min = max) или
   «Проверены версии 26.9.1–26.10.31».
4. **«Обновление»** (только `proxies.edit`):
   - нет ключа — строка из решения со ссылкой;
   - иначе кнопка «Обновить до <latest.version>» (`tone="primary"`), без
     выпуска — «Обновить»; `disabled`, когда `blockedBy !== null`; причина
     справа — `blockedReason(true, blockedText(...))`:
     - `no_release` — «Свежий выпуск не получен»;
     - `blocked` — «Перейти нельзя, нужно обновить код»;
     - `older` — «Выпуск старше проверенных версий»;
     - `up_to_date` — «Ядро уже этой версии»;
     - `in_code` — «Версия уже в коде — уедет с ближайшим выпуском»;
     - `running` — «Обновление уже идёт»;
     - `locked` — «Запускали недавно — снова можно в <ЧЧ:ММ>» (время
       `lockedUntil` в часовом поясе браузера);
     - `no_token` — «Нет ключа github.xray-update»;
   - окно подтверждения: заголовок «Обновить ядро Xray», `subject`
     «<running.version или «?»> → <latest.version>», `changes`:
     «Что будет» — «PR в dev от workflow xray-bump.yml»; текст под ним:
     «Workflow проверит наш конфиг на новом ядре и откроет PR. На прод ядро
     уедет после вливания — с выпуском»; кнопка «Запустить обновление».
     Успех — `toast.success("Обновление запущено", { description: "PR появится через пару минут — ссылка в строке последнего запуска" })`
     и новое состояние из ответа; отказ — текст ошибки сервера в окне.
5. **«Последний запуск»** (у всех, если `lastRun !== null`): «<title> —
   <runText>, <createdAt>» и ссылка «Открыть в GitHub» (`lastRun.url`):
   - `active` — warning «идёт»;
   - `completed` + `success` — success «PR открыт»;
   - `completed` + `failure` — danger «упал — проверка конфига не прошла
     или ошибка запуска, смотрите в GitHub»;
   - `completed` + `cancelled` — neutral «отменён»;
   - другое — neutral, `conclusion` как есть.
   `lastRunError` — мелко, приглушённо, под строкой.

Состояния вкладки:
- **загрузка** — `Loading`;
- **ошибка** — `ErrorNotice` с «Повторить»;
- **нет сети** — то же `ErrorNotice` (клиент панели отдаёт сетевую ошибку);
- **без права `proxies.edit`** — пункты 1–3 и 5, без кнопок и пункта 4;
- **«Проверить сейчас» чаще раза в минуту** — `toast.error` с текстом
  сервера («Проверять выпуск можно раз в минуту»).

Ширины: 320, 390, 768, 1440 px, ландшафт 667×375 и 640×360 — `KeyValue`
переносится в столбик, кнопка и причина не вылезают за край. Снимки на 390
и 1440 px (обычное состояние, `blocked`, `missing`) — в PR, если у потока
есть браузер; нет — так и написать в PR.

## Тесты

Первым коммитом:

- `apps/admin/test/xray-core.test.ts`:
  - схема `XrayCoreView` разбирает пример ответа сервера целиком (взять поля
    из `XrayCoreView` T-0416) и ответ с незнакомыми `blockedBy: "new_code"`
    и `kind: "future"` — без исключения;
  - `compatibilityText` — по одному случаю на каждый `kind`, `blocked` несёт
    причину в `detail`, незнакомый `kind` — neutral с самим кодом;
  - `blockedText` — каждый код из списка даёт текст из раздела «Сценарий»
    дословно; `locked` с `lockedUntil` даёт «Запускали недавно — снова можно
    в ЧЧ:ММ»; незнакомый код — сам код;
  - `runText` — `active`, `success`, `failure`, `cancelled`, `skipped`;
  - `testedRangeText("26.10.31", "26.10.31")` → «Проверена версия 26.10.31»;
    `("26.9.1", "26.10.31")` → «Проверены версии 26.9.1–26.10.31»;
  - `runningNote` — `older` → warning, `untested` → info, `tested` и `null` → `null`.
- `apps/admin/test/proxies-tabs.test.ts` — ожидание
  `["xray", "traffic", "core", "manual", "modes"]`; `proxyTabOf("core")` → `"core"`.

## Аналитика

Нет: экран команды. Запуск обновления пишет в журнал действий сервер
(`proxies.xray_core.update`, T-0416).

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md`, строка «Прокси» в таблице модулей (§2): после
  описания вкладок (Р201) — «Вкладка «Ядро Xray» (Р202, T-0415–T-0418):
  запущенная версия из статуса контейнера, свежий выпуск XTLS (кэш 6 ч,
  «Проверить сейчас» — раз в минуту), совместимость с нашим конфигом по
  диапазону проверенных версий; «Обновить до …» (владелец, нужен ключ
  `github.xray-update`) запускает workflow, который открывает PR в `dev`; не
  чаще раза в 10 минут и не при идущем запуске; на прод — выпуском».

## Критерии приёмки

- [ ] Вкладка «Ядро Xray» после «Трафика», адрес `#/proxies/core`.
- [ ] Видны запущенная версия и время запуска, свежий выпуск со ссылкой,
      совместимость словами и диапазон проверенных версий; все состояния из
      «Сценария» — с текстами дословно.
- [ ] «Обновить» — только у `proxies.edit`, через подтверждение, выключена с
      причиной при любом `blockedBy`; нет ключа — строка со ссылкой на
      «Ключи интеграций».
- [ ] Пока запуск идёт — опрос раз в 15 с, на других вкладках его нет.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Вкладка «Ядро Xray» с обновлением через PR`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВКЛАДКА «ЯДРО XRAY» С ОБНОВЛЕНИЕМ ЧЕРЕЗ PR**

  В «Прокси» появилась вкладка «Ядро Xray»: какая версия запущена, что вышло у XTLS и подойдёт ли нашему конфигу. Владелец одной кнопкой запускает PR с новой версией, на прод она уезжает выпуском (Р202).

  🛠 **Панель**

  • «Перейти нельзя, нужно обновить код» — когда версия в списке несовместимых
  • кнопка закрыта, пока идёт запуск и 10 минут после него

  ❓ **Нужно от команды**

  • @владелец — для кнопки нужен ключ github.xray-update в «Ключах интеграций» (fine-grained токен, право Actions: Read and write)
  ```
