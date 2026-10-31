# Образ воркера симуляции (docs/20-env-and-ports.md §5.3, tasks/T-0302).
#
# Контекст сборки — корень монорепо: pnpm-workspace ставит зависимости по
# общему lock-файлу, и без манифестов остальных пакетов --frozen-lockfile не
# сойдётся.
#
#   docker build -f apps/sim-worker/Dockerfile -t rubezh-sim-worker .
#
# Образ Node — тот же, что у API (`backend/api/Dockerfile`): версия и digest,
# совпадающие с .nvmrc, чтобы воркер и сервер не расходились.
#
# В рантайм уезжает один файл. Движок, BullMQ, ioredis и Zod собраны внутрь
# (esbuild, `apps/sim-worker/build.mjs`), поэтому ни node_modules, ни исходников
# монорепо, ни Phaser в образе нет.
FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI="true"
RUN corepack enable
WORKDIR /app

# --- Зависимости -------------------------------------------------------------
# Манифесты — отдельно от исходников: слой с зависимостями переживает правку
# кода. Ставится только воркер и то, от чего он зависит (`sim-worker...`).
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/sim-worker/package.json apps/sim-worker/
COPY packages/core-game/package.json packages/core-game/
COPY packages/shared-types/package.json packages/shared-types/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter sim-worker...

# --- Сборка ------------------------------------------------------------------
# Движок берётся исходниками, как в тестах и в `pnpm balance:sim`: esbuild
# собирает их вместе с воркером в один файл.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared-types/tsconfig.json packages/shared-types/
COPY packages/shared-types/src packages/shared-types/src
COPY packages/core-game/tsconfig.json packages/core-game/
COPY packages/core-game/src packages/core-game/src
COPY apps/sim-worker/tsconfig.json apps/sim-worker/build.mjs apps/sim-worker/
COPY apps/sim-worker/src apps/sim-worker/src
RUN pnpm --filter sim-worker build

# --- Рантайм -----------------------------------------------------------------
FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS runtime
ENV NODE_ENV="production"
WORKDIR /app
COPY --from=build /app/apps/sim-worker/dist/main.js ./main.js
USER node

# Проба живости своими силами: curl в slim-образе нет, а fetch в Node 22 есть.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.SIM_WORKER_METRICS_PORT||4010)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "main.js"]
