---
id: T-0034
title: Внешняя проверка прода раз в 5 минут и тревога в чат команды
epic: E3
priority: P1
status: ready
owner:
size: S
depends_on: [T-0033]
zones:
  - .github/workflows/uptime.yml
  - scripts/ops/uptime-check.mjs
  - scripts/release/team-summary.mjs
  - scripts/test/uptime-check.test.ts
shared:
  - docs/09-ci-cd.md
  - docs/20-env-and-ports.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
---

# T-0034. Внешняя проверка прода раз в 5 минут и тревога в чат команды

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0034.json)](README.md#значки-статуса) [![T-0033](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0033.json&label=T-0033)](T-0033-health-ready.md)

## Зачем

Сейчас о падении прода команда узнает от игроков: внешней проверки нет. Пункт
К10 аудита.

## Решения

Решение пользователя от 06.10.2026: **лёгкий мониторинг без новых сервисов
на сервере.** Внешняя проверка — workflow GitHub Actions по расписанию,
тревога — в чат команды тем же ботом, что присылает сводки.

Решения тимлидов:

- **Что проверяем** — список адресов в переменной репозитория `UPTIME_URLS`,
  через пробел. Её задаёт человек в настройках репозитория, например:
  `https://tg.gonet.fun/ https://api.gonet.fun/health/ready`. Домен в код не
  зашивается: перед лончем он сменится.
- **Адрес считается рабочим, если ответил 200 за 10 секунд.** Иначе —
  повтор через 5 секунд, и только вторая неудача считается падением. Так одна
  потерянная попытка не будит команду.
- **Тревога — только при смене состояния:**
  - было хорошо, стало плохо — «🔴 Прод недоступен…»;
  - было плохо, стало хорошо — «🟢 Прод снова доступен…»;
  - плохо и дальше — молчание.

  Прежнее состояние — итог прошлого завершённого прогона этого же workflow:
  прогон, где прод упал, завершается с ошибкой. Хранить своё состояние негде
  и не нужно.
- **Ограничение GitHub:** расписание (`schedule`) работает только из ветки по
  умолчанию — `main`. Проверка начнётся после ближайшего релиза в `main`.
  GitHub может задерживать запуски по расписанию на минуты.

## Как сейчас

- `.github/workflows/team-summary.yml`:
  - окружение `telegram`;
  - секрет `TEAM_TELEGRAM_BOT_TOKEN`, переменная `TEAM_TELEGRAM_CHAT`;
  - `actions/checkout` и `actions/setup-node` закреплены по SHA с версией в
    комментарии. Это обязательно, и это проверяет
    `scripts/test/action-pins.test.ts`.
- `scripts/release/team-summary.mjs`:
  - `parseChatTarget(value)` (строка 246) — разбор `id` или `id:тема`;
  - приватный `send(token, message)` (строки 300–322) — POST в Bot API с
    таймаутом 10 с, токен в текст ошибки не попадает.
- Проверка готовности API `/health/ready` — T-0033: 200 или 503.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **Рефакторинг отдельным коммитом**, поведение не меняется:
   `scripts/release/team-summary.mjs` экспортирует отправку:

   ```js
   /** Сообщение в чат через Bot API: `target` — из `parseChatTarget`, `parseMode` — "HTML" или нет. */
   export async function sendTelegramMessage(token, target, text, { parseMode = "HTML" } = {})
   ```

   Прежний `send(token, message)` зовёт её.
3. **Новый `scripts/ops/uptime-check.mjs`:**
   - чистые функции, их покрывают тесты:

     ```js
     /** Один адрес: 200 за `timeoutMs` — `{ url, ok: true }`, иначе `{ url, ok: false, reason }`; две попытки с паузой. */
     export async function checkUrl(url, { fetchImpl = fetch, timeoutMs = 10_000, retryDelayMs = 5_000, wait } = {})

     /** Что сказать: `previous` — "up" | "down" | null (прогонов ещё не было), `results` — проверки адресов. */
     export function decide(previous, results)
     ```

     `decide` возвращает `{ state: "up" | "down", message: string | null }`:
     - все `ok` → `up`; `previous === "down"` → сообщение
       `🟢 Прод снова доступен: <адреса через «, »>`, иначе `null`;
     - хоть один не `ok` → `down`; `previous !== "down"` → сообщение

       ```
       🔴 Прод недоступен
       <адрес> — <reason>
       <…по строке на упавший адрес>
       Проверка из GitHub Actions; следующая — через 5 минут.
       ```

       иначе `null`.

     `reason`:
     - `HTTP <код>`;
     - `нет ответа за 10 с`;
     - `ошибка сети: <code ошибки или «неизвестно»>`.

     Без текста тела и заголовков.
   - `main()`:
     1. `UPTIME_URLS` пуста → `console.log` «UPTIME_URLS не задана — проверять
        нечего», выход 0;
     2. прежнее состояние — `gh run list --workflow uptime.yml --status completed --limit 1 --json conclusion`:
        - `success` → `up`, `failure` → `down`, иначе или ничего → `null`;
        - текущий прогон ещё не завершён и в список не попадает;
     3. проверки всех адресов параллельно, `decide`;
     4. есть сообщение и заданы `TELEGRAM_BOT_TOKEN` и `TEAM_TELEGRAM_CHAT` →
        `sendTelegramMessage(token, parseChatTarget(chat), message, { parseMode: null })`
        — простой текст, без HTML;
     5. итог печатается в лог прогона;
     6. `state === "down"` → `process.exit(1)`: по этому итогу следующий прогон
        узнает прежнее состояние. Ошибка отправки в Telegram — в лог, на код
        выхода не влияет.
4. **Новый `.github/workflows/uptime.yml`:**

   ```yaml
   name: Uptime
   on:
     schedule:
       - cron: "*/5 * * * *"
     workflow_dispatch:
   permissions:
     contents: read
     actions: read
   concurrency:
     group: uptime
     cancel-in-progress: false
   jobs:
     check:
       runs-on: ubuntu-latest
       environment: telegram
       timeout-minutes: 3
       steps:
         - uses: actions/checkout@<тот же SHA, что в team-summary.yml> # <та же версия>
           with:
             persist-credentials: false
         - uses: actions/setup-node@<тот же SHA> # <та же версия>
           with:
             node-version-file: .nvmrc
         - name: Проверить прод
           env:
             GH_TOKEN: ${{ github.token }}
             UPTIME_URLS: ${{ vars.UPTIME_URLS }}
             TELEGRAM_BOT_TOKEN: ${{ secrets.TEAM_TELEGRAM_BOT_TOKEN }}
             TEAM_TELEGRAM_CHAT: ${{ vars.TEAM_TELEGRAM_CHAT }}
           run: node scripts/ops/uptime-check.mjs
   ```

   Над `on:` — комментарий: расписание работает только из `main`, ручной
   запуск — для проверки после настройки `UPTIME_URLS`.
5. **Документы** — раздел «Документы».

## Чего не трогаем

- Сервер и `infra/prod/*`: на сервере ничего не появляется.
- Остальное в `team-summary.mjs`, кроме вынесенной отправки.
- Тревогу о всплеске ошибок 5xx внутри API — это T-0035.

## Тесты

Первым коммитом, новый `scripts/test/uptime-check.test.ts` — функции
`checkUrl` и `decide` с подменой `fetch` и `wait`:

- `checkUrl`:
  - 200 с первого раза → `ok`, одна попытка;
  - 503, затем 200 → `ok`, две попытки;
  - 503 дважды → `{ ok: false, reason: "HTTP 503" }`;
  - зависший запрос → `reason: "нет ответа за 10 с"`;
  - ошибка сети `ECONNREFUSED` → `reason: "ошибка сети: ECONNREFUSED"`.
- `decide`:
  - `null` + всё ок → `up`, без сообщения;
  - `up` + упал один → `down`, сообщение «🔴…» с этим адресом и причиной;
  - `down` + упал → `down`, без сообщения;
  - `down` + всё ок → `up`, «🟢…»;
  - `null` + упал → `down`, сообщение «🔴…».
- Существующие тесты `team-summary` — зелёные после выноса отправки.
- `scripts/test/action-pins.test.ts` — зелёный: actions в `uptime.yml`
  закреплены по SHA.

## Аналитика

Нет.

## Настройки и окружение

- Новая **переменная репозитория** `UPTIME_URLS` — адреса через пробел.
  Не секрет: адреса прода и так публичны. Задаёт человек в «Settings →
  Secrets and variables → Actions → Variables». Секреты и прочие переменные —
  уже существующие (`TEAM_TELEGRAM_BOT_TOKEN`, `TEAM_TELEGRAM_CHAT`).

## Документы

- `docs/09-ci-cd.md`, таблица workflow — строка `uptime.yml`: «раз в 5 минут
  из `main`, вручную; проверяет адреса из `UPTIME_URLS`, при смене состояния
  пишет в чат команды «🔴 Прод недоступен» или «🟢 снова доступен»».
- `docs/20-env-and-ports.md`, раздел о прод-стеке — строка: «Внешняя проверка —
  `uptime.yml` в GitHub Actions по адресам из переменной `UPTIME_URLS`».

## Критерии приёмки

- [ ] Ручной запуск `uptime.yml` при живом проде — зелёный, сообщений нет.
  Проверяют тимлиды после мерджа и настройки `UPTIME_URLS`.
- [ ] Падение адреса даёт одно сообщение «🔴…», восстановление — одно «🟢…»,
  в промежутке — тишина.
- [ ] Домена прода в коде нет: только в переменной `UPTIME_URLS`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(ci): Внешняя проверка прода раз в 5 минут`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВНЕШНЯЯ ПРОВЕРКА ПРОДА**

  О падении прода команда теперь узнает сама, а не от игроков: GitHub Actions раз в 5 минут проверяет сайт и API и пишет в чат команды, когда прод упал и когда поднялся.

  🩺 **Как устроено**

  • адреса — в переменной репозитория UPTIME_URLS; ответ 200 за 10 секунд, со второй попытки
  • сообщение — только при смене состояния: «🔴 Прод недоступен» и «🟢 снова доступен»
  • заработает после ближайшего релиза в main: расписание GitHub запускает только оттуда

  ❓ **Нужно от команды**

  • @участник1 — задать переменную репозитория UPTIME_URLS: адрес клиента и адрес /health/ready API
  ```
