#!/bin/sh
# Точка входа контейнера бэкенда (docs/20-env-and-ports.md §5.3).
#
# Миграции применяются ДО старта приложения: иначе приложение поднимется на
# старой схеме и начнёт отвечать 500 там, где ждали новую колонку.
set -eu

echo "entrypoint: применяю миграции"
prisma migrate deploy --schema prisma/schema.prisma

echo "entrypoint: запускаю приложение"
exec "$@"
