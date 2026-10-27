---
id: T-0086
title: Два теста охраны проверяют то, что обещают: публичность готовности и тревогу 5xx в полной сборке
epic: E3
priority: P3
status: done
owner: claude-1 / haiku-5.5 / medium
author: claude-lead2-8
size: S
depends_on: []
zones:
  - backend/api/test/readiness.test.ts
  - backend/api/test/app-boot.integration.test.ts
shared: []
runner: local
executor: haiku-5.5
effort: medium
release: none
design: null
batch: 1
---

# T-0086. Два теста охраны проверяют то, что обещают

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0086.json)](../README.md#значки-статуса)

## Зачем

Два теста сервера зелёные всегда, что бы ни случилось с кодом:

- «не требует токена доступа» у проверки готовности поднимает контроллер без
  гварда, поэтому никакой токен не мог быть потребован (находка приёмки #238);
- тревога на всплеск 5xx включается в `http-app.ts` только если провайдер
  найден, и молча; уйди `AdminNotifyModule` из приложения, тревога пропала бы без
  строки в логе (находка приёмки #260).

После задачи первый тест падает, если с готовности снять `@Public()`, а второй —
если в полной сборке приложения нет тревоги. Кода сервера задача не меняет.

## Решения

- Публичность готовности проверяем **метаданными маршрута**, а не запросом: в
  тесте контроллера нет глобального гварда, а собирать его с зависимостями
  ради одной проверки не нужно. Что публичность вообще объявлена у каждого
  маршрута и не маскируется правом, держит `route-permissions.test.ts`, и он
  уже сканирует `ReadinessController` (в `AppModule.controllers`). Здесь — быстрая
  проверка рядом с остальными кейсами готовности.
- Проверка тревоги — в уже существующий тест полной сборки, без второго
  запуска приложения: запуск всех модулей дорог.
- Код `readiness.controller.ts`, `http-app.ts`, модулей не меняется. Как должно
  вести себя приложение без провайдера в тестах HTTP-слоя, решено раньше
  (`tasks/T-0035-server-error-alarm.md`).

## Как сейчас

- `backend/api/test/readiness.test.ts:76-80`:

  ```ts
  it("не требует токена доступа", async () => {
    const app = await appWith(ok, async () => "PONG");
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).not.toBe(401);
  });
  ```

  Модуль теста (строки 29-38) содержит только `ReadinessController`, пробы и
  лимитер, глобального гварда нет, 401 появиться не может.
- `backend/api/src/health/readiness.controller.ts:39-40` — `@Public()` стоит над
  `@Get("ready")`. Ключ метаданных — `PUBLIC_METADATA` из
  `backend/api/src/common/access.ts:21` (так же его читает
  `route-permissions.test.ts:76`).
- `backend/api/src/http-app.ts:77-83` — `app.get(ServerErrorAlarm, { strict: false })`
  в `try`, при исключении хук не ставится.
- `backend/api/src/modules/admin-notify/admin-notify.module.ts:32,40` —
  `ServerErrorAlarm` в `providers` и `exports`; `AdminNotifyModule` стоит в
  `APP_MODULES` (`app.module.ts:116`).
- `backend/api/test/app-boot.integration.test.ts` — один кейс «собирается из
  всех модулей и отвечает на /health» (`describe.skipIf` без
  `TEST_DATABASE_URL` и `PLAYTEST_TEST_REDIS_URL`): собирает `BootModule` из
  `APP_MODULES`, `app.init()`, запрос `/health`, `app.close()` в `finally`.

## Шаги по порядку

1. **Тесты первым коммитом.** Здесь сами правки и есть тесты, поэтому первый
   коммит — шаг 2, второй — шаг 3, каждый со своей проверкой «краснеет, если
   сломать» (раздел «Тесты»).
2. **`backend/api/test/readiness.test.ts`:**
   - добавить импорт
     `import { PUBLIC_METADATA } from "../src/common/access.js";` рядом с
     остальными импортами из `../src/`;
   - заменить кейс «не требует токена доступа» (строки 76-80) на

     ```ts
     it("помечен публичным: охрану токеном для всех маршрутов держит route-permissions.test.ts", () => {
       expect(Reflect.getMetadata(PUBLIC_METADATA, ReadinessController.prototype.ready)).toBe(true);
     });
     ```

     `reflect-metadata` в файле уже подключён первой строкой.
   - Остальные кейсы файла не трогать.
3. **`backend/api/test/app-boot.integration.test.ts`:**
   - добавить импорт
     `import { ServerErrorAlarm } from "../src/modules/admin-notify/server-error-alarm.js";`
     (в алфавитном порядке путей, после `http-app.js`);
   - в единственном кейсе переименовать заголовок в
     «собирается из всех модулей, отвечает на /health и держит тревогу 5xx»;
   - после `expect(response.statusCode).toBe(200);` (перед `finally`) добавить:

     ```ts
     // Хук 5xx в http-app.ts ставится, только если провайдер найден, и молча:
     // без этой проверки тревога пропала бы из приложения без единой строки в логе.
     expect(app.get(ServerErrorAlarm, { strict: false })).toBeInstanceOf(ServerErrorAlarm);
     ```

## Чего не трогаем

- `readiness.controller.ts`, `http-app.ts`, `admin-notify.module.ts`: код
  сервера не меняется; правки в них нужны только для проверки «краснеет», и в
  коммит они не попадают.
- Остальные кейсы `readiness.test.ts` (200, 503, таймаут Redis, корень без
  префикса, лимит 60 в минуту) и `route-permissions.test.ts`.
- Не поднимать второй экземпляр приложения в `app-boot.integration.test.ts` и не
  выносить сборку в `beforeAll`: структура файла остаётся.
- Проверка, что хук реально считает 5xx, — другой тест
  (`tasks/T-0035-server-error-alarm.md`), здесь только наличие провайдера.

## Сценарий и интерфейс

Нет — тесты сервера, игрок и панель не затронуты.

## Тесты

Задача и есть тесты. Для каждого кейса обязательна проверка «краснеет, если
сломать», результат — строкой в описании PR:

- `backend/api/test/readiness.test.ts`, «помечен публичным…» → зелёный сейчас.
  Временно убрать `@Public()` с метода `ready` в `readiness.controller.ts` →
  `pnpm exec vitest run backend/api/test/readiness.test.ts` из корня красный
  (метаданных нет, `undefined` вместо `true`). Вернуть.
- `backend/api/test/app-boot.integration.test.ts`, расширенный кейс → зелёный
  сейчас, при заданных `TEST_DATABASE_URL` и `PLAYTEST_TEST_REDIS_URL`
  (`docs/17-testing-strategy.md` §4.2: адреса тестовых Postgres и Redis,
  локально — контейнеры из `docker-compose.yml`; Redis — не та база, которую
  занимает запущенный dev-API).
  Без переменных кейс пропускается и ничего не доказывает: проверка без них не
  засчитывается. Временно убрать `ServerErrorAlarm` из `providers` в
  `admin-notify.module.ts` (строка 32) → кейс красный (или падает `app.get`, или
  сборка не связывается — любой из двух исходов подходит). Вернуть.
- Проверить `git diff`: правок в `admin-notify.module.ts` и
  `readiness.controller.ts` в коммите нет.

## Аналитика

Нет — меняются только тесты.

## Настройки и окружение

Нет.

## Документы

Нет: поведение сервера не менялось. `docs/17-testing-strategy.md` не трогаем.

## Критерии приёмки

- [ ] Кейс готовности проверяет метаданные `PUBLIC_METADATA` и краснеет, когда
  `@Public()` снят (результат проверки — в описании PR).
- [ ] Кейс полной сборки проверяет `ServerErrorAlarm` и краснеет, когда
  провайдер убран (результат — в описании PR); запускался с живыми Postgres и
  Redis, не пропущен.
- [ ] В коммите нет следов временных правок кода сервера.
- [ ] Дифф только в двух тестовых файлах.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `test(api): Проверки публичности и тревоги 5xx`
- **Метка:** `release: none`
- **Для игроков:** нет
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ТЕСТЫ ОХРАНЫ ГОТОВНОСТИ И ТРЕВОГИ 5XX**

  Два теста сервера, которые были зелёными при любом коде, теперь падают, когда с проверки готовности снят @Public() или в полной сборке пропала тревога на всплеск 5xx.

  🛠 **Тесты сервера**

  • готовность: проверяются метаданные публичного маршрута вместо запроса без гварда
  • полная сборка: провайдер тревоги должен находиться, иначе хук 5xx молча не ставится
  ```
