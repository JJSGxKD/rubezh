# Образ бэкенда (docs/20-env-and-ports.md §5.3, docs/09-ci-cd.md §10).
#
# Контекст сборки — корень монорепо, а не backend/api: pnpm-workspace ставит
# зависимости по общему lock-файлу, и без манифестов остальных пакетов
# --frozen-lockfile не сойдётся.
#
#   docker build -f backend/api/Dockerfile -t rubezh-api .
#
# База пинится дайджестом, а не тегом: тег перемещаемый (docs/09-ci-cd.md §12).
# bookworm-slim, а не alpine, — в зависимостях нативный @resvg/resvg-js
# (рендер карточек отчётов) и Prisma; с glibc меньше сюрпризов, чем с musl.
# Версия Node совпадает с .nvmrc, чтобы прод и CI не расходились.
FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI="true"
# Движку миграций Prisma нужен libssl: без него он не определяет версию
# OpenSSL, откатывается на openssl-1.1.x и падает уже в рантайме, на
# `migrate deploy`. В slim-образе пакета нет — ставим явно.
RUN apt-get update \
 && apt-get install --no-install-recommends --yes openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# --- Зависимости -------------------------------------------------------------
# Манифесты копируются отдельно от исходников, чтобы слой с зависимостями
# переживал правку кода. Схема Prisma нужна уже здесь: postinstall бэкенда —
# это `prisma generate`.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/api/package.json backend/api/prisma.config.ts backend/api/
COPY backend/api/prisma backend/api/prisma
COPY apps/web-telegram/package.json apps/web-telegram/
COPY apps/web-max/package.json apps/web-max/
COPY apps/web-vk/package.json apps/web-vk/
COPY packages/adapter-max/package.json packages/adapter-max/
COPY packages/adapter-telegram/package.json packages/adapter-telegram/
COPY packages/adapter-vk/package.json packages/adapter-vk/
COPY packages/app-shell/package.json packages/app-shell/
COPY packages/core-game/package.json packages/core-game/
COPY packages/shared-types/package.json packages/shared-types/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter backend-api...

# --- Сборка ------------------------------------------------------------------
# Бэкенд не импортирует @bh/shared-types, поэтому остального монорепо здесь
# нет: собирается только backend/api.
FROM deps AS build
COPY tsconfig.base.json ./
COPY backend/api/tsconfig.json backend/api/
COPY backend/api/src backend/api/src
RUN pnpm --filter backend-api prisma:generate \
 && pnpm --filter backend-api build

# --- Рантайм -----------------------------------------------------------------
# Ставятся только прод-зависимости, без devDependencies. Prisma CLI среди них:
# миграции применяются при старте контейнера, значит для прода это рантайм, а
# не инструмент разработки — поэтому он и переехал в dependencies.
FROM base AS runtime
ENV NODE_ENV="production" \
    PATH="/app/backend/api/node_modules/.bin:$PATH"

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/api/package.json backend/api/prisma.config.ts backend/api/
COPY backend/api/prisma backend/api/prisma
# Скрипты установки здесь не отключаются намеренно: postinstall @prisma/engines
# кладёт движок миграций в образ. Без него Prisma полезет скачивать его при
# старте контейнера — в прод-сети это отказ деплоя, а не задержка.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter backend-api...

COPY --from=build /app/backend/api/dist backend/api/dist

# Бит исполняемости не приезжает из Windows (CLAUDE.md, «Окружение команды»),
# поэтому выставляется здесь, а не ожидается от git.
COPY infra/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /app/backend/api
USER node

# Проба живости своими силами: curl в slim-образе нет, а fetch в Node 22 есть.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/main.js"]
