# Контейнер бэкапов прода (docs/35-stage4-plan.md, Р54; docs/20-env-and-ports.md §5.4):
# отправка журнала Postgres (WAL) в хранилище, ночная базовая копия, чистка
# старого и зеркало репозитория. Ветка Alpine та же, что у образа Postgres,
# — клиент 17.11 совпадает с сервером, и pg_basebackup не спорит о версии.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

RUN apk add --no-cache \
      age=1.3.1-r6 \
      bash=5.3.9-r1 \
      coreutils=9.11-r0 \
      curl=8.22.0-r0 \
      git=2.54.0-r0 \
      postgresql17-client=17.11-r0 \
      rclone=1.74.1-r2 \
      zstd=1.5.7-r2

COPY backupctl.sh /usr/local/bin/backupctl
# Бит исполняемости из Windows не приходит (CLAUDE.md, «Окружение команды»).
RUN chmod +x /usr/local/bin/backupctl

HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["backupctl", "health"]
ENTRYPOINT ["backupctl"]
CMD ["loop"]
