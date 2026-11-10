---
id: T-0415
title: Ядро Xray сообщает свою версию, диапазон совместимости — в proxy-kit
epic: E13
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0387]
zones:
  - infra/prod/xray/run.sh
  - infra/prod/xray/Dockerfile
  - infra/prod/compose.yml
  - packages/proxy-kit/src/xray-core.ts
  - packages/proxy-kit/test/xray-core.test.ts
  - scripts/test/xray-core-pin.test.ts
shared:
  - packages/proxy-kit/src/index.ts
  - packages/proxy-kit/README.md
  - docs/20-env-and-ports.md
runner: local
executor: sonnet-5.5
effort: medium
release: patch
merge: lead
design: null
batch: 5
---

# T-0415. Ядро Xray сообщает свою версию, диапазон совместимости — в proxy-kit

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0415.json)](README.md#значки-статуса) [![T-0387](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0387.json&label=T-0387)](T-0387-xray-core-fresh-and-transports.md)

## Зачем

Панель должна показывать, какая версия Xray **запущена** на сервере, и
говорить, совместим ли свежий выпуск с нашим конфигом (Р202). Сейчас версию
знает только `Dockerfile` в репозитории: что реально крутится в контейнере
после выката, не видно никому, а доступа к Docker у сервера нет и не будет.
После задачи контейнер Xray сам пишет свою версию в общий том, а `proxy-kit`
умеет сказать про любую версию: «проверено», «не проверено», «старше
проверенных» или «перейти нельзя, нужно обновить код».

## Решения

- **Р202** (`docs/35-stage4-plan.md`), пункты 1 и 3. Исполнитель их не
  пересматривает.
- **Версию сообщает само ядро** через файл в отдельном томе `xray-status`.
  Почему не иначе: exec в чужой контейнер и сокет Docker — это права root на
  хосте; у API Xray (`StatsService`, T-0386) версии нет; версия из
  `Dockerfile` в репозитории — не то, что запущено (выкат мог не
  пересобрать образ).
- **Формат файла** — две строки `ключ=значение`, LF, без кавычек:

  ```
  version=26.10.31
  started=2026-11-10T09:15:02Z
  ```

  `version` — номер из первой строки `xray version` (`Xray 26.10.31 (Xray,
  Penetrates Everything.) …`), `started` — UTC-время запуска процесса Xray
  в ISO 8601 до секунд с `Z`. Файл переписывается **при каждом запуске**
  процесса Xray, включая перезапуск после смены конфига. Номер не
  разобрался — `version=` пустое значение (сервер покажет «версия не
  распознана»), а Xray запускается как обычно: из-за файла статуса ядро не
  падает.
- **Запись атомарна**: временный файл в том же каталоге и `mv` — сервер
  никогда не читает половину файла.
- **Права тома.** У Xray — запись (`/xray-status`), у API — только чтение
  (`/xray-status:ro`). Корневая ФС Xray остаётся `read_only: true`: том
  пишется и так. Каталог `/xray-status` создаётся в образе с владельцем
  `65532:65532` до строки `USER`: Docker копирует владельца каталога образа
  в пустой именованный том при первом подключении, иначе пользователь Xray не
  сможет писать.
- **Диапазон совместимости** — в `proxy-kit`, без монорепо (граница слоёв
  `CLAUDE.md`):
  - `XRAY_CORE_MIN` — самая старая версия, на которой золотые конфиги
    прошли `check-config.sh`. **Сейчас мы проверяли только одну версию —
    ту, что в `Dockerfile`, поэтому MIN = MAX.** Опускать MIN без прогона
    `check-config.sh` на той версии нельзя;
  - `XRAY_CORE_MAX` — версия в `infra/prod/xray/Dockerfile`. Строка
    объявления — **одной строкой ровно такого вида**:
    `export const XRAY_CORE_MAX = "26.10.31";` — её правит скрипт workflow
    обновления (T-0417). Совпадение с `Dockerfile` сверяет тест;
  - `XRAY_CORE_BLOCKS` — версии, на которых наш конфиг не принят: от `from`
    включительно до `until` не включая (`null` — и все новее), с причиной
    словами. Сейчас список пуст. Пополняется, когда CI обновления упал, а код
    ещё не поправлен.
- **Как читается версия** (`xrayCompatibility`), по порядку:
  1. не разобралась — `unknown`;
  2. попала в блок — `blocked` с причиной блока;
  3. `MIN ≤ версия ≤ MAX` — `tested`;
  4. новее MAX — `untested` (проверит CI в PR обновления);
  5. старше MIN — `older`.
- **Номер версии** — три целых без знака через точку, каждое от 0 до 9999,
  без ведущих нулей кроме самого `0`; ведущая `v` допустима (метка выпуска
  GitHub — `v26.10.31`). Сравнение — по числам слева направо: `26.9.1 <
  26.10.0`.

## Как сейчас

- `infra/prod/xray/run.sh` — ждёт конфиг, запускает `xray run -c "$CONFIG" &`,
  раз в 5 секунд сверяет хеш и после `xray run -test` перезапускает Xray
  (строки 8–28). Запуск процесса встречается дважды: строка 10 и строка 22.
- `infra/prod/xray/Dockerfile` — `FROM ghcr.io/xtls/xray-core:<версия>@sha256:…
  AS xray` (строка 7; после T-0387 версия может быть новее), основа Alpine,
  `USER 65532:65532`, `ENTRYPOINT ["/bin/sh", "/xray-run.sh"]`.
- `infra/prod/compose.yml`:
  - сервис `api` (строки ~57–60) — том `xray-config:/xray-config`;
  - сервис `xray` (строки 194–213) — `xray-config:/etc/xray:ro`,
    `read_only: true`, `cap_drop: [ALL]`;
  - `volumes:` в конце файла — `xray-config: {}` (строка ~247).
- `packages/proxy-kit/src/index.ts` — публичные экспорты пакета.
- `scripts/test/` — тесты сопровождения на vitest; YAML и Dockerfile
  читаются текстом (образец — `scripts/test/uptime-workflow.test.ts`).
- Выкат: `deploy.yml` копирует `compose.yml`, `xray/Dockerfile` и
  `xray/run.sh` на сервер, `deploy.sh` делает `docker compose up -d --build`
  — образ Xray пересобирается сам, новый том создаётся сам.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`packages/proxy-kit/src/xray-core.ts`** (новый):

   ```ts
   /** Версия ядра Xray: три числа, как в метке выпуска без «v». */
   export type XrayVersion = readonly [number, number, number];

   /** Самая старая версия, на которой золотые конфиги прошли check-config.sh. Опускать — только после прогона на ней. */
   export const XRAY_CORE_MIN = "<версия из Dockerfile>";
   /** Версия образа в infra/prod/xray/Dockerfile. Строку правит workflow обновления ядра (xray-bump.yml): одна строка, этот вид. */
   export const XRAY_CORE_MAX = "<версия из Dockerfile>";

   export interface XrayCoreBlock {
     /** с этой версии включительно */
     readonly from: string;
     /** до этой версии, не включая; `null` — и все новее */
     readonly until: string | null;
     /** почему наш конфиг не принят — словами для панели */
     readonly reason: string;
   }
   export const XRAY_CORE_BLOCKS: readonly XrayCoreBlock[] = [];

   export type XrayCompatibility =
     | { readonly kind: "tested" }
     | { readonly kind: "untested" }
     | { readonly kind: "older" }
     | { readonly kind: "blocked"; readonly reason: string }
     | { readonly kind: "unknown" };

   export function parseXrayVersion(text: string): XrayVersion | null;
   export function formatXrayVersion(version: XrayVersion): string;
   export function compareXrayVersions(a: XrayVersion, b: XrayVersion): -1 | 0 | 1;
   export function xrayCompatibility(
     version: string,
     range?: { min: string; max: string },   // умолчание — XRAY_CORE_MIN, XRAY_CORE_MAX
     blocks?: readonly XrayCoreBlock[],      // умолчание — XRAY_CORE_BLOCKS
   ): XrayCompatibility;
   /** Ошибки данных: каждая строка называет поле. Пусто — всё верно. */
   export function findXrayCoreProblems(range: { min: string; max: string }, blocks: readonly XrayCoreBlock[]): string[];
   ```

   `findXrayCoreProblems` проверяет: MIN и MAX разбираются и `MIN ≤ MAX`;
   у блока `from` разбирается, `until` разбирается и больше `from` (или
   `null`), `reason` не пустая и не длиннее 200 знаков; ни один блок не
   задевает отрезок `[MIN, MAX]` (проверенная версия не может быть
   заблокированной). Сообщения — по-русски, вида «блок 2: until не новее
   from».
3. **`packages/proxy-kit/src/index.ts`** — экспорт всего перечисленного
   одной строкой `export { … } from "./xray-core.js";`.
4. **`infra/prod/xray/Dockerfile`** — перед `USER 65532:65532`:

   ```dockerfile
   # Каталог статуса ядра (Р202): run.sh пишет сюда версию, API читает её через общий том.
   # Владелец — пользователь Xray: Docker переносит его в пустой том при первом подключении.
   RUN mkdir -p /xray-status && chown 65532:65532 /xray-status
   ```

   Строку `FROM … AS xray` не трогать.
5. **`infra/prod/xray/run.sh`**:
   - переменная `STATUS="${XRAY_STATUS:-/xray-status/core}"`;
   - функция `write_status`: номер — `xray version 2>/dev/null | head -n 1 |
     sed -n 's/^Xray \([0-9][0-9.]*\).*/\1/p'`, время —
     `date -u +%Y-%m-%dT%H:%M:%SZ`; пишет две строки в
     `"$STATUS.$$.tmp"` и `mv -f` в `"$STATUS"`. Каталога нет или запись
     не удалась — одна строка в лог `xray: статус ядра не записан`, и
     дальше как обычно (`|| true`, без `set -e`);
   - `write_status` — перед **каждым** `xray run -c "$CONFIG" &` (оба места);
   - комментарий в шапке — одна строка о файле статуса со ссылкой на Р202.
6. **`infra/prod/compose.yml`**:
   - сервис `xray`, `volumes:` — `- xray-status:/xray-status`;
   - сервис `api`, `volumes:` — `- xray-status:/xray-status:ro`;
   - `volumes:` в конце файла — `xray-status: {}` с комментарием: «Статус
     ядра Xray (Р202): пишет контейнер Xray, API только читает».
7. **`packages/proxy-kit/README.md`** — в «Что умеет» строка: «версия ядра
   Xray: разбор, сравнение, диапазон проверенных версий и блоки
   (`xray-core.ts`, Р202)».
8. **`docs/20-env-and-ports.md`**, раздел о спутнике Xray (около строки
   685): абзац «**Версия ядра.** При каждом запуске Xray `run.sh` пишет
   `version=` и `started=` в `/xray-status/core` — том `xray-status`, у API
   он только для чтения; по нему панель показывает запущенную версию (Р202).
   Смена версии: тег и digest в `Dockerfile` и `XRAY_CORE_MAX` в
   `packages/proxy-kit/src/xray-core.ts` — вместе, их совпадение проверяет
   `scripts/test/xray-core-pin.test.ts`». Фразу «Смена версии Xray: поправить
   тег и digest…» (строка ~696) дополнить этим же.
9. **Проверка руками** (поэтому `runner: local`), результат — в описание PR:
   - `docker build -t rubezh-xray-local infra/prod/xray`;
   - пустой том и запуск с готовым конфигом: `docker volume create
     xray-status-check`, затем `docker run --rm -d --name xray-status-check
     --read-only -v xray-status-check:/xray-status -v
     "<каталог с empty.json>:/etc/xray:ro" -v
     "$(pwd)/infra/prod/xray/run.sh:/xray-run.sh:ro" -e
     XRAY_CONFIG=/etc/xray/empty.json rubezh-xray-local` (пустой конфиг —
     тот же, что в конце `check-config.sh`);
   - через 3–5 секунд `docker run --rm -v xray-status-check:/s alpine:3.24
     cat /s/core` → две строки, `version=` совпадает с `Dockerfile`;
   - `docker stop xray-status-check; docker volume rm xray-status-check`;
   - `bash infra/prod/xray/check-config.sh` — зелёный, как до задачи.

## Чего не трогаем

- Версию и digest образа в `Dockerfile` — это T-0387 и дальше workflow T-0417.
- Чтение файла сервером, переменную `XRAY_STATUS_PATH`, вкладку панели —
  T-0416 и T-0418.
- `check-config.sh` — его зона у T-0387; здесь он только запускается.
- Логику перезапуска в `run.sh` (хеш, `rejected`, `trap`) — не меняется.
- Таблицу `F` и золотые конфиги `proxy-kit`.

## Тесты

Первым коммитом, до кода:

- `packages/proxy-kit/test/xray-core.test.ts`:
  - `parseXrayVersion("26.10.31")` → `[26, 10, 31]`; `"v26.10.31"` → то же;
  - `null` у `"26.10"`, `"26.10.31.1"`, `"26.010.1"`, `"-1.0.0"`, `"26.10.31-rc1"`,
    `"10000.0.0"`, `""`, `" 26.10.31"`;
  - `compareXrayVersions`: `26.9.1 < 26.10.0`, `26.10.31 = v26.10.31`, `27.0.0 > 26.12.31`;
  - `formatXrayVersion([26, 10, 31])` → `"26.10.31"`;
  - `xrayCompatibility` с диапазоном `{ min: "26.9.1", max: "26.10.31" }` и
    блоками `[{ from: "27.1.0", until: "27.2.0", reason: "поле x" }]`:
    `"26.10.31"` → `tested`; `"26.9.1"` → `tested`; `"26.12.1"` → `untested`;
    `"27.1.5"` → `{ kind: "blocked", reason: "поле x" }`; `"27.2.0"` →
    `untested` (граница `until` не включена); `"26.1.1"` → `older`;
    `"мусор"` → `unknown`;
  - блок с `until: null` закрывает и все новее: `"30.0.0"` → `blocked`;
  - без аргументов функция берёт `XRAY_CORE_MIN`, `XRAY_CORE_MAX`, `XRAY_CORE_BLOCKS`:
    `xrayCompatibility(XRAY_CORE_MAX)` → `tested`;
  - `findXrayCoreProblems({ min: XRAY_CORE_MIN, max: XRAY_CORE_MAX }, XRAY_CORE_BLOCKS)` → `[]`;
  - `findXrayCoreProblems` с `min > max`, с блоком без причины, с `until ≤ from`,
    с блоком, задевающим `[min, max]`, — по одной строке на ошибку, строка
    называет поле.
- `scripts/test/xray-core-pin.test.ts` (Dockerfile и `xray-core.ts` читаются
  текстом, LF/CRLF нормализуются, как в `uptime-workflow.test.ts`):
  - в `infra/prod/xray/Dockerfile` ровно одна строка
    `FROM ghcr.io/xtls/xray-core:<версия>@sha256:<64 hex> AS xray`;
  - в `packages/proxy-kit/src/xray-core.ts` ровно одна строка
    `export const XRAY_CORE_MAX = "<версия>";` — именно в этом виде, одной
    строкой (на неё опирается скрипт T-0417);
  - версии совпадают; сообщение при расхождении называет обе;
  - в `Dockerfile` есть `mkdir -p /xray-status` и `chown 65532:65532 /xray-status`
    раньше строки `USER 65532:65532`;
  - в `infra/prod/compose.yml`: у сервиса `xray` — `- xray-status:/xray-status`
    (без `:ro`), у сервиса `api` — `- xray-status:/xray-status:ro`, в
    `volumes:` — `xray-status: {}`;
  - в `infra/prod/xray/run.sh` перед каждым `xray run -c` в файле стоит вызов
    `write_status` (число вызовов `write_status` перед запуском равно числу
    строк `xray run -c "$CONFIG" &`), и в `run.sh` нет `set -e`.

## Аналитика

Нет: это эксплуатация, игрока не касается, событий и метрик не порождает.

## Настройки и окружение

- Новый том `xray-status` в `infra/prod/compose.yml` (шаг 6).
- Переменная контейнера Xray `XRAY_STATUS` — необязательная, умолчание
  `/xray-status/core`; в `compose.yml` её не задаём. Это переменная
  скрипта контейнера, а не бэкенда: в `.env.example` и схему конфигурации
  она не идёт.
- Переменную бэкенда `XRAY_STATUS_PATH` заводит T-0416.

## Документы

- `docs/20-env-and-ports.md` — шаг 8.
- `packages/proxy-kit/README.md` — шаг 7.

## Критерии приёмки

- [ ] Контейнер Xray при каждом запуске процесса пишет `/xray-status/core`
      атомарно, две строки `version=` и `started=`; сбой записи не роняет Xray.
- [ ] Том `xray-status`: у Xray запись, у API только чтение; `read_only: true`
      у Xray сохранён.
- [ ] `xrayCompatibility` и `findXrayCoreProblems` в `proxy-kit`, экспортированы
      из `index.ts`, пакет по-прежнему ничего не импортирует из монорепо.
- [ ] `XRAY_CORE_MAX` совпадает с версией в `Dockerfile`, MIN = MAX; тест
      `xray-core-pin.test.ts` это держит.
- [ ] В описании PR — вывод ручной проверки шага 9 и `check-config.sh`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(infra): Ядро Xray сообщает версию в общий том`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЯДРО XRAY СООБЩАЕТ ВЕРСИЮ В ОБЩИЙ ТОМ**

  Контейнер Xray при каждом запуске пишет свою версию в том xray-status, а proxy-kit знает, какие версии ядра мы проверили. Это основа вкладки «Ядро Xray» в панели (Р202).

  🛠 **Сервер**

  • новый том xray-status: Xray пишет, API только читает
  • версия в Dockerfile и XRAY_CORE_MAX в proxy-kit меняются вместе — их сверяет тест
  ```
