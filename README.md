# Bullet-heaven / dungeon-runner мини-игра

Кроссплатформенная HTML5-игра для MAX, Telegram, VK и браузера.
Полная проектная документация — в [`docs/`](./docs/00-README.md), начать
оттуда. Этот файл — только техническая шпаргалка "как поднять и запустить".

**Лицензия**: [PolyForm Noncommercial 1.0.0](./LICENSE) — репозиторий
публичный, но коммерческое использование посторонними запрещено.
Подробности и внутреннее соглашение для команды — `docs/12-ip-and-licensing.md`.

## Требования

- Node.js 22 LTS (см. `.nvmrc` — `nvm use`)
- Docker + Docker Compose (для Postgres/Redis локально)
- npm 10+ (идёт вместе с Node)

## Установка

```bash
git clone <URL этого репозитория>
cd bullet-heaven-monorepo
cp .env.example .env        # заполнить реальными ключами по мере подключения провайдеров
npm install                 # ставит зависимости во все workspace-пакеты разом
docker compose up -d        # поднимает Postgres + Redis для локальной разработки
```

## Запуск в разработке

Каждая платформенная сборка — отдельный dev-сервер (Vite `--mode`, см.
`docs/01-tech-stack.md` §1 и `docs/09-ci-cd.md`):

```bash
npm run dev:telegram   # apps/web-telegram, http://localhost:5173
npm run dev:max        # apps/web-max
npm run dev:vk         # apps/web-vk
npm run dev:backend    # backend/api (NestJS), http://localhost:3000
```

## Полезные команды

```bash
npm run typecheck   # tsc -b по всем пакетам разом
npm run lint         # eslint по всему репозиторию
npm run build        # сборка всех пакетов/приложений
```

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
