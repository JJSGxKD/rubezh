---
id: T-0417
title: Workflow обновления ядра Xray — PR с версией и digest, проверка конфига в CI
epic: E13
priority: P2
status: in-progress
owner: claude-60 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0415, T-0416]
zones:
  - .github/workflows/xray-bump.yml
  - .github/workflows/ci.yml
  - scripts/ops/xray-bump.mjs
  - scripts/test/xray-bump.test.ts
  - scripts/test/xray-bump-workflow.test.ts
shared:
  - docs/09-ci-cd.md
  - docs/20-env-and-ports.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
merge: lead
design: null
batch: 5
---

# T-0417. Workflow обновления ядра Xray — PR с версией и digest, проверка конфига в CI

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0417.json)](README.md#значки-статуса) [![T-0415](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0415.json&label=T-0415)](T-0415-xray-core-version-file.md) [![T-0416](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0416.json&label=T-0416)](T-0416-xray-core-server.md)

## Зачем

Кнопка «Обновить» во вкладке «Ядро Xray» (Р202) запускает workflow GitHub.
Его ещё нет. После задачи `xray-bump.yml` по версии выпуска сам находит
digest образа, правит `Dockerfile` и `XRAY_CORE_MAX`, прогоняет наш конфиг
на новом ядре (`check-config.sh`) и открывает PR в `dev`. Владелец его
вливает, на прод ядро уезжает выпуском. Отдельный джоб `ci.yml` гоняет ту же
проверку на любом PR, который меняет образ Xray или `proxy-kit`.

## Решения

- **Р202** (`docs/35-stage4-plan.md`), пункты 4, 6 и 7. Исполнитель их не
  пересматривает.
- **Запуск** — только `workflow_dispatch` с входом `version` (строка, без
  `v`). Запускает сервер (T-0416) ключом `github.xray-update` на ветке `dev`;
  руками из вкладки Actions — тоже можно.
- **Права workflow** — `contents: write` и `pull-requests: write` (ветка и
  PR), больше ничего. Ветку и PR делает `GITHUB_TOKEN`, ключ сервера сюда не
  попадает.
- **Вход недоверенный.** `${{ inputs.version }}` встречается только в
  `run-name:` и в `env:` шагов; в тексте `run:` — только `"$VERSION"`. Первым
  шагом версия сверяется с `^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$`; не
  совпала — запуск падает до любых сетевых действий.
- **Выпуск** — `gh api repos/XTLS/Xray-core/releases/tags/v<версия>`: есть,
  `prerelease: false`, `draft: false`. Иначе — падение «Выпуск v<версия> не
  найден или помечен pre-release».
- **Повтор не плодит PR** (Р202, п. 6):
  - `concurrency: { group: xray-bump, cancel-in-progress: false }`;
  - версия в `Dockerfile` уже такая — `::notice::Ядро уже <версия>`, запуск
    зелёный, ничего не делает;
  - открытый PR из ветки `chore/xray-core-<версия>` уже есть —
    `::notice::PR уже открыт: <адрес>`, запуск зелёный;
  - ветка есть, а открытого PR нет (закрыли) — ветка пересоздаётся
    `git push --force`.
- **Digest** — индекса всех платформ (`docs/09-ci-cd.md` §12):
  `docker buildx imagetools inspect ghcr.io/xtls/xray-core:<версия> --format '{{json .Manifest}}' | jq -r .digest`,
  проверка `^sha256:[0-9a-f]{64}$`. Метки нет в реестре — падение «Образа
  ghcr.io/xtls/xray-core:<версия> нет».
- **Правка файлов — скриптом**, не `sed` в YAML: `scripts/ops/xray-bump.mjs`
  меняет **ровно одну** строку `FROM ghcr.io/xtls/xray-core:…@sha256:… AS xray`
  в `infra/prod/xray/Dockerfile` и **ровно одну** строку
  `export const XRAY_CORE_MAX = "…";` в `packages/proxy-kit/src/xray-core.ts`
  (вид строки закрепил T-0415). Нашлось не по одной — скрипт падает и ничего
  не пишет. `XRAY_CORE_MIN` и `XRAY_CORE_BLOCKS` не трогает.
- **Проверка конфига** — `bash infra/prod/xray/check-config.sh` после правки.
  Итог пишется в вывод шага (`ok=true|false`) без `continue-on-error`.
  Прошла — PR обычный. Не прошла — **PR черновиком** с хвостом лога, и
  последний шаг роняет запуск: панель покажет красный запуск, а в PR можно
  сразу править таблицу `F` и золотые файлы или завести блок в
  `XRAY_CORE_BLOCKS`.
- **PR**: ветка `chore/xray-core-<версия>` от `dev`, база `dev`, заголовок и
  коммит `chore(infra): Обнови ядро Xray до <версия>`, метка `release: patch`
  (образ на проде меняется — нужен выпуск), автор коммита
  `github-actions[bot] <41898283+github-actions[bot]@users.noreply.github.com>`.
- **CI на таком PR сам не стартует** — PR открыт токеном workflow, по
  правилам GitHub он не запускает другие workflow (как синк `main` → `dev`,
  `docs/09-ci-cd.md` §8.1). В описании PR — строка: гейт запускается
  закрытием и повторным открытием PR. Проверка конфига при этом уже сделана
  в самом `xray-bump.yml` и повторяется джобом `xray-config` после
  переоткрытия.
- **Джоб `xray-config` в `ci.yml`** — только на `pull_request`; если дифф
  против базы затрагивает `infra/prod/xray/` или `packages/proxy-kit/`, —
  `check-config.sh`, иначе джоб зелёный за секунды. Обязательной проверкой его
  не делаем (правила веток не трогаем).
- **Кнопка работает, когда `xray-bump.yml` уже в `main`**: GitHub запускает
  `workflow_dispatch` только по файлу из ветки по умолчанию. До выпуска
  сервер получает `404` и показывает это словами (T-0416).

## Как сейчас

- `.github/workflows/sync-dev.yml` — образец workflow, который открывает PR
  токеном workflow: `permissions`, `concurrency`, закреплённые actions
  (`actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`,
  `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0`),
  логика — в `scripts/release/sync-dev.mjs`.
- `.github/workflows/ci.yml` — джоб `gate` и другие; `permissions:
  contents: read` на весь файл.
- `scripts/action-pins.mjs` — тест в `pnpm test` роняет гейт на `uses:` не по
  SHA с версией комментарием; `pr-checks.yml` сверяет тег с SHA.
- `infra/prod/xray/check-config.sh` — собирает образ из
  `infra/prod/xray`, гоняет золотые конфиги `xray run -test`, код выхода 1 при
  ошибке. Докер на `ubuntu-latest` есть.
- `scripts/test/uptime-workflow.test.ts` — образец проверки workflow
  текстом (YAML-парсера в зависимостях нет); утилиты на `.mjs` импортируются
  в тест с `// @ts-expect-error` и причиной.
- После T-0415: строка `XRAY_CORE_MAX` и тест `scripts/test/xray-core-pin.test.ts`.
- После T-0416: `backend/api/src/modules/proxies/xray-core/xray-core-target.ts`
  с `workflow: "xray-bump.yml"` и `ref: "dev"`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`scripts/ops/xray-bump.mjs`** — ESM, без зависимостей, функции
   экспортируются для тестов, CLI — в конце файла под проверкой
   `import.meta.url`:

   ```js
   export const VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
   export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
   export const DOCKERFILE = "infra/prod/xray/Dockerfile";
   export const CORE_FILE = "packages/proxy-kit/src/xray-core.ts";
   export function branchOf(version) {}          // "chore/xray-core-26.11.5"
   export function titleOf(version) {}           // "chore(infra): Обнови ядро Xray до 26.11.5"
   export function currentVersion(dockerfile) {} // версия из строки FROM … AS xray; нет строки или их две — исключение
   export function bumpDockerfile(text, version, digest) {} // новая строка FROM, остальное как было
   export function bumpCoreMax(text, version) {}            // новая строка XRAY_CORE_MAX
   export function prBody({ version, previous, digest, releaseUrl, checkOk, checkLog, number }) {}
   ```

   - все функции проверяют `version` и `digest` по `VERSION_RE` и
     `DIGEST_RE` и бросают `Error` с русским текстом;
   - переводы строк файла сохраняются (CRLF остаётся CRLF);
   - `prBody` — описание PR по формату скилла `pre-pr`, без раздела «Для
     игроков» (игрок не видит), с хвостом лога не длиннее 60 строк в блоке
     кода и с `## Сводка для команды`; `number` — `null` до создания PR
     (тогда в заголовке сводки `#<номер>`) или число.

     Текст описания (подставить значения):

     ```markdown
     Обновление ядра Xray `<previous>` → `<version>`, запущено из панели («Прокси» → «Ядро Xray», Р202).

     - выпуск: <releaseUrl>
     - образ: `ghcr.io/xtls/xray-core:<version>@<digest>`
     - `XRAY_CORE_MAX` в `packages/proxy-kit/src/xray-core.ts` — `<version>`

     ## Проверка конфига

     <✅ `check-config.sh` прошёл на новом ядре. | ❌ `check-config.sh` не прошёл — PR черновиком. Поправьте таблицу `F` в `packages/proxy-kit/src/xray-config.ts` и золотые конфиги или заведите блок версии в `XRAY_CORE_BLOCKS`.>

     <лог в блоке кода>

     PR открыт токеном workflow — по правилам GitHub CI на нём не запускается сам. Гейт: закрыть и снова открыть PR.

     ## Сводка для команды

     📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБНОВИ ЯДРО XRAY ДО <VERSION>**

     Ядро Xray обновится с <previous> до <version> с ближайшим выпуском; наш конфиг на новом ядре проверен check-config.sh.
     ```

   - CLI:
     - `node scripts/ops/xray-bump.mjs check-version <версия>` — код 0 или 1
       с текстом;
     - `node scripts/ops/xray-bump.mjs current` — печатает версию из
       `Dockerfile`;
     - `node scripts/ops/xray-bump.mjs check-digest <digest>`;
     - `node scripts/ops/xray-bump.mjs apply <версия> <digest>` — правит оба
       файла; любая ошибка — ни один файл не записан (сначала оба текста в
       памяти, потом запись);
     - `node scripts/ops/xray-bump.mjs body <версия> <прежняя> <digest>
       <адрес выпуска> <ok:true|false> <файл лога> [номер]` — печатает
       описание.
3. **`.github/workflows/xray-bump.yml`** (новый) — по решениям:
   - шапка-комментарий: зачем, ссылки на Р202 и `docs/09-ci-cd.md`;
   - `name: Xray bump`, `run-name: Ядро Xray ${{ inputs.version }}`;
   - `on.workflow_dispatch.inputs.version`: `required: true`, `type:
     string`, описание «Версия выпуска XTLS/Xray-core без «v», например
     26.11.5»;
   - `permissions`, `concurrency` — по решениям; джоб `bump`, `runs-on:
     ubuntu-latest`, `timeout-minutes: 20`;
   - шаги:
     1. `actions/checkout` (тот же SHA, `ref: dev`, `fetch-depth: 0`);
     2. `actions/setup-node` (тот же SHA, `node-version-file: .nvmrc`);
     3. «Проверить версию» — `env: VERSION: ${{ inputs.version }}`,
        `node scripts/ops/xray-bump.mjs check-version "$VERSION"`;
     4. «Проверить выпуск» — `gh api` по решению «Выпуск»; `GH_TOKEN: ${{ github.token }}`;
        адрес выпуска (`html_url`) — в вывод шага;
     5. «Нужно ли обновление» (`id: need`) — текущая версия
        (`… current`), равна — notice и `run=false`; открытый PR
        (`gh pr list --head "$BRANCH" --state open --json url --jq '.[0].url // empty'`)
        — notice и `run=false`; иначе `run=true` и `previous=<текущая>`;
     6. все следующие шаги — `if: steps.need.outputs.run == 'true'`;
     7. «Digest образа» (`id: digest`) — по решению «Digest», проверка
        `… check-digest`;
     8. «Правка версии» — `… apply "$VERSION" "$DIGEST"`;
     9. «Проверка конфига» (`id: check`) — `if bash infra/prod/xray/check-config.sh > "$RUNNER_TEMP/check.log" 2>&1; then echo "ok=true"; else echo "ok=false"; fi >> "$GITHUB_OUTPUT"`,
        лог — ещё и в вывод шага (`cat`);
     10. «Коммит и ветка» — `git config user.name "github-actions[bot]"`,
         `user.email` по решению, `git switch -C "$BRANCH"`, `git commit -am "$TITLE"`,
         `git push --force origin "$BRANCH"`;
     11. «PR» — описание в `$RUNNER_TEMP/body.md` (`… body … ` без номера),
         `gh pr create --base dev --head "$BRANCH" --title "$TITLE" --body-file … --label "release: patch"`
         плюс `--draft`, если `ok != true`; затем номер из адреса PR,
         описание с номером и `gh pr edit <номер> --body-file …`;
     12. «Конфиг не принят» — `if: steps.need.outputs.run == 'true' && steps.check.outputs.ok != 'true'`,
         `echo "::error::check-config.sh не прошёл на ядре $VERSION — PR открыт черновиком"; exit 1`.
4. **`.github/workflows/ci.yml`** — джоб `xray-config` по решению: `if:
   github.event_name == 'pull_request'`, checkout с `fetch-depth: 0`, шаг
   `id: changed` (`BASE_REF: ${{ github.base_ref }}` через `env:`,
   `git diff --name-only "origin/$BASE_REF...HEAD" | grep -qE '^(infra/prod/xray/|packages/proxy-kit/)'`),
   шаг `bash infra/prod/xray/check-config.sh` под
   `if: steps.changed.outputs.xray == 'true'`. Права — те, что у файла
   (`contents: read`). Список «реализованы шаги…» в шапке `ci.yml` не трогать,
   над джобом — комментарий со ссылкой на Р202.
5. **Документы** — раздел «Документы».

## Чего не трогаем

- Сервер и кнопку — T-0416 и T-0418.
- `check-config.sh`, `Dockerfile` руками — правит их только скрипт в
  запуске; их зоны — у T-0387 и T-0415.
- Правила веток и список обязательных проверок — решения владельца.
- `sync-dev.yml`, `deploy.yml`, джоб `gate`.

## Тесты

Первым коммитом, до кода:

- `scripts/test/xray-bump.test.ts`:
  - `branchOf("26.11.5")` → `"chore/xray-core-26.11.5"`; `titleOf` → `"chore(infra): Обнови ядро Xray до 26.11.5"`;
  - `bumpDockerfile` на копии нынешнего `Dockerfile` (читается с диска) с
    `26.11.5` и `sha256:` + 64 `a` → меняется ровно строка `FROM … AS xray`,
    остальные строки байт в байт как были; CRLF-вариант текста остаётся CRLF;
  - `bumpDockerfile` на тексте с двумя строками `FROM ghcr.io/xtls/xray-core`
    или без неё → исключение;
  - `bumpCoreMax` на тексте `xray-core.ts` → меняется только строка
    `XRAY_CORE_MAX`, `XRAY_CORE_MIN` прежний; без строки или с двумя → исключение;
  - версия `"26.11"`, `"26.11.5; rm -rf /"`, `"v26.11.5"` и digest
    `"sha256:abc"` → исключения во всех функциях, которые их принимают;
  - `currentVersion` на нынешнем `Dockerfile` → совпадает с `XRAY_CORE_MAX`
    из `xray-core.ts` (читается текстом);
  - `prBody`: проверка прошла → нет слова «черновиком», есть «✅»; не прошла →
    есть «черновиком» и «xray-config.ts»; лог из 200 строк → в описании 60
    последних; `number: null` → `#<номер>`, `number: 812` → `#812`; есть
    `## Сводка для команды`, нет `## Для игроков`; есть строка про
    закрыть и снова открыть PR.
- `scripts/test/xray-bump-workflow.test.ts` (текстом, CRLF нормализуется):
  - есть `workflow_dispatch:` и вход `version` с `required: true`; других
    триггеров (`push`, `pull_request`, `schedule`) нет;
  - `permissions:` — ровно `contents: write` и `pull-requests: write`;
  - `concurrency:` с `group: xray-bump` и `cancel-in-progress: false`;
  - каждое вхождение `${{ inputs.` — в строке `run-name:` или в строке вида
    `<ИМЯ>: ${{ inputs.version }}` внутри `env:`; ни одного внутри `run:`;
  - шаг проверки версии идёт раньше любого `gh api`, `docker` и `git push`;
  - есть `bash infra/prod/xray/check-config.sh`, нет `continue-on-error`;
  - `gh pr create` с `--base dev` и `--label "release: patch"`;
  - имя файла совпадает с `workflow: "…"` и ветка с `ref: "…"` в
    `backend/api/src/modules/proxies/xray-core/xray-core-target.ts` (читается
    текстом) — сервер запускает именно этот файл;
  - `ci.yml`: джоб `xray-config` с `if: github.event_name == 'pull_request'`,
    путями `infra/prod/xray/` и `packages/proxy-kit/` и запуском
    `check-config.sh`; `${{ github.base_ref }}` — только в `env:`.
- `scripts/test/action-pins.test.ts` (уже есть) должен остаться зелёным на
  новых `uses:`.

## Аналитика

Нет: инструмент команды в CI, игрока не касается.

## Настройки и окружение

Нет новых секретов: workflow работает на `GITHUB_TOKEN`. Ключ сервера
`github.xray-update` заводит T-0416.

## Документы

- `docs/09-ci-cd.md` — в §8.1 «Ветка `dev`», после абзаца о синке `main` →
  `dev`: абзац «**Обновление ядра Xray** (`xray-bump.yml`, Р202): запуск — из
  панели или вкладки Actions с версией выпуска; workflow берёт digest образа,
  правит `Dockerfile` и `XRAY_CORE_MAX`, прогоняет `check-config.sh` и
  открывает PR `chore(infra): …` с меткой `release: patch` — черновиком, если
  проверка не прошла. PR открыт токеном workflow: гейт — закрыть и открыть.
  Работает, когда файл уже в `main`». В §2 (гейт) — строка про джоб
  `xray-config`.
- `docs/20-env-and-ports.md` — фразу «Смена версии Xray: поправить тег и
  digest…» дополнить: «обычно — кнопкой «Обновить» во вкладке «Ядро Xray»
  (Р202): PR откроет `xray-bump.yml`».

## Критерии приёмки

- [ ] `xray-bump.yml` запускается только `workflow_dispatch`, вход проверен
      до любых сетевых действий и в `run:` не подставляется.
- [ ] Повторный запуск той же версии не открывает второй PR; версия, уже
      стоящая в `Dockerfile`, — зелёный запуск без действий.
- [ ] PR в `dev` правит ровно строку `FROM` в `Dockerfile` и строку
      `XRAY_CORE_MAX`, несёт итог `check-config.sh`; проверка не прошла — PR
      черновиком и красный запуск.
- [ ] Джоб `xray-config` в `ci.yml` гоняет `check-config.sh` только на PR,
      меняющих `infra/prod/xray/` или `packages/proxy-kit/`.
- [ ] Все `uses:` закреплены SHA с версией комментарием.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.
- [ ] В описании PR задачи — строка: живой запуск возможен только после
      выпуска в `main`; тимлид проверяет его первым нажатием после выпуска.

## PR

- **Заголовок:** `feat(ci): Workflow обновления ядра Xray через PR`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — WORKFLOW ОБНОВЛЕНИЯ ЯДРА XRAY ЧЕРЕЗ PR**

  xray-bump.yml по версии выпуска открывает PR в dev с новым образом Xray и digest, предварительно проверив наш конфиг на новом ядре (Р202). Запускать его будет кнопка «Обновить» во вкладке «Ядро Xray».

  🛠 **CI**

  • PR открыт токеном workflow — гейт запускается закрытием и повторным открытием PR
  • новый джоб xray-config: check-config.sh на PR, которые меняют образ Xray или proxy-kit
  • запуск из панели заработает после того, как файл попадёт в main
  ```
