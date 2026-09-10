# Bullet-heaven / dungeon-runner мини-игра

Кроссплатформенная HTML5-игра для Telegram, MAX, VK и браузера.
Приоритет разработки — **Telegram первым**, MAX и VK портируются после
(обоснование — `docs/02-roadmap.md` §«Приоритет платформ»).
Полная проектная документация — в [`docs/`](./docs/00-README.md), начать
оттуда. Этот файл — только техническая шпаргалка "как поднять и запустить".

**Лицензия**: [PolyForm Noncommercial 1.0.0](./LICENSE) — репозиторий
публичный, но коммерческое использование посторонними запрещено.
Подробности и внутреннее соглашение для команды — `docs/12-ip-and-licensing.md`.

## Требования

- Node.js 22 LTS. **Внимание, Windows**: `nvm-windows` **не читает `.nvmrc`** —
  версию нужно назвать явно: `nvm install 22.22.3` и `nvm use 22.22.3`.
  Файл `.nvmrc` в репозитории остаётся источником истины о том, какая версия
  нужна, и используется в CI
- Docker + Docker Compose (для Postgres/Redis локально)
- **pnpm** — ставится одной командой через Corepack, входящий в Node:
  `corepack enable pnpm`. Версия берётся из поля `packageManager` в корневом
  `package.json`, поэтому у всех и в CI она одинаковая. Почему pnpm, а не npm
  или bun — `docs/16-tech-stack-decisions.md` §2

## Установка

Команда работает на Windows в PowerShell — команды ниже даны под него.
В PowerShell 5.1 нет оператора `&&`, поэтому команды разделены `;` и
выполняются по одной.

```powershell
git clone https://github.com/JJSGxKD/rubezh.git
cd rubezh
corepack enable pnpm            # один раз на машину
Copy-Item .env.example .env     # заполнить ключами по мере подключения провайдеров
pnpm install                    # ставит зависимости во все workspace-пакеты разом
docker compose up -d            # поднимает Postgres + Redis для локальной разработки
```

Секреты (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` и остальные) генерируются
так — `openssl` идёт в комплекте с Git for Windows:

```powershell
openssl rand -hex 32
```

Для access и refresh значения должны быть **разными**.

## Запуск в разработке

Каждая платформенная сборка — отдельный dev-сервер (Vite `--mode`, см.
`docs/01-tech-stack.md` §1 и `docs/09-ci-cd.md`):

```powershell
pnpm dev:telegram   # apps/web-telegram, http://localhost:5173
pnpm dev:max        # apps/web-max,      http://localhost:5174
pnpm dev:vk         # apps/web-vk,       http://localhost:5175
pnpm dev:backend    # backend/api,       http://localhost:4000
```

Каждая команда — в своём окне терминала. Порты закреплены и не конфликтуют,
карта портов — `docs/20-env-and-ports.md` §2.

## Полезные команды

```powershell
pnpm typecheck   # tsc -b по всем пакетам разом
pnpm lint        # eslint по всему репозиторию
pnpm build       # сборка всех пакетов/приложений
```

Если после `git pull` что-то ведёт себя странно — переустановить зависимости:

```powershell
Remove-Item -Recurse -Force node_modules; pnpm install
```

Пакеты ссылаются друг на друга через протокол `workspace:*`. Раскладка
`node_modules` строгая: пакет видит только то, что объявил в своём
`package.json` — это то, чем защищены границы слоёв из
`docs/15-engineering-standards.md` §2.2.

## Структура репозитория

```
/packages
  /shared-types      <- общие TS-интерфейсы (PlatformAdapter, EnemyDef и т.д.)
  /core-game         <- игровой движок (Phaser), контент как данные в src/content/*
  /adapter-telegram  <- реализация PlatformAdapter под Telegram WebApp SDK
  /adapter-max       <- реализация PlatformAdapter под MAX Bridge
  /adapter-vk        <- реализация PlatformAdapter под VK Bridge
/apps
  /web-telegram      <- Vite-сборка под Telegram (env=telegram)
  /web-max           <- Vite-сборка под MAX (env=max)
  /web-vk            <- Vite-сборка под VK (env=vk)
/backend
  /api               <- NestJS + Prisma + Redis, единая точка входа для всех платформ
/docs                <- вся проектная документация, читать с docs/00-README.md
```

Зоны ответственности по этим папкам между участниками команды — в
`docs/06-team-and-workflow.md` §2.

**Важно**: `backend/api` в текущем виде — открытый учебный скелет, без
реальной антифрод-логики и без секретов. Перед тем как класть туда боевую
логику `runs`/антифрода (`docs/01-tech-stack.md` §3), см. рекомендацию в
`docs/12-ip-and-licensing.md` §4 — этот пакет стоит вынести из публичного
репозитория в приватный до того, как в нём появится что-то, что не должно
быть видно игрокам.
