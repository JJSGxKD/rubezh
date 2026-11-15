#!/usr/bin/env bash
# Окружение интеграционных тестов для потока на этой машине.
# Использование: source scripts/lead/test-env.sh t0210   (схема = t<номер задачи>)
# База — rubezh_test, схема t<номер>, Redis 13: dev-базу и Redis 14 это окружение
# не трогает. Адреса собираются из DATABASE_URL основного .env и не печатаются.
_lead_env_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=paths.sh
source "$_lead_env_here/paths.sh" || return 1
unset _lead_env_here
slot="${1:?нужна схема, например t0210}"
case "$slot" in t[0-9][0-9][0-9][0-9]) ;; *) echo "схема должна быть вида t0210" >&2; return 1 ;; esac
dev_url="$(sed -nE 's/^DATABASE_URL="?([^"]*)"?[[:space:]]*$/\1/p' "$LEAD_ROOT/.env" | head -1)"
base="${dev_url%%\?*}"
base="${base%/*}"
export TEST_DATABASE_URL="${base}/rubezh_test?schema=${slot}"
export SCRATCH_DATABASE_URL="${base}/rubezh_migrate_scratch?schema=${slot}"
export PLAYTEST_TEST_REDIS_URL="redis://localhost:6379/13"
case "$TEST_DATABASE_URL" in postgres*://*/rubezh_test\?schema=t*) echo "тестовое окружение: rubezh_test, схема ${slot}, Redis 13" ;; *) echo "не удалось собрать адрес тестовой базы" >&2; unset TEST_DATABASE_URL SCRATCH_DATABASE_URL; return 1 ;; esac
unset dev_url base
