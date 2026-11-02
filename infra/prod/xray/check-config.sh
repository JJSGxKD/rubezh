#!/usr/bin/env bash
# Прогоняет золотые конфиги @bh/proxy-kit через `xray run -test` в образе спутника
# (docs/35-stage4-plan.md, Р101; tasks/T-0093). Нужен при смене версии образа
# Xray в infra/prod/xray/Dockerfile: что новый Xray не принял, правится в таблице
# имён полей packages/proxy-kit/src/xray-config.ts и в золотых файлах.
#
# В золотых файлах стоят выдуманные значения: `{{KEY}}` — ключ узла, PUBLICKEYn —
# не настоящий ключ REALITY. Xray проверяет форму ключа (32 байта в base64url),
# поэтому перед прогоном файлы копируются во временный каталог с подстановкой.
#
#   bash infra/prod/xray/check-config.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fixtures="$root/packages/proxy-kit/test/fixtures/xray"
image="rubezh-xray-check"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Windows (bash из комплекта Git): путь тома docker нужен в виде C:/…, а /c/… внутри команды не переписывать.
export MSYS_NO_PATHCONV=1
host_path() { if command -v cygpath > /dev/null 2>&1; then cygpath -m "$1"; else printf "%s" "$1"; fi; }
mount="$(host_path "$work")"

docker build --quiet --tag "$image" "$(host_path "$root/infra/prod/xray")" > /dev/null

failed=0
for file in "$fixtures"/*.json; do
  name="$(basename "$file")"
  sed -e 's/{{KEY}}/0123456789abcdef/g' -e 's/PUBLICKEY[0-9]*/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/g' "$file" > "$work/$name"
  if docker run --rm --entrypoint xray --volume "$mount:/c:ro" "$image" run -test -c "/c/$name" > "$work/$name.log" 2>&1; then
    echo "ok     $name"
  else
    echo "ОШИБКА $name"
    tail -n 3 "$work/$name.log"
    failed=1
  fi
done

# Пустой конфиг (подписка удалена) тоже должен приниматься: он убирает входы Xray.
cat > "$work/empty.json" << 'EOF'
{"log":{"loglevel":"warning","access":"none"},"inbounds":[],"outbounds":[{"tag":"block","protocol":"blackhole"}],"routing":{"domainStrategy":"AsIs","rules":[]}}
EOF
if docker run --rm --entrypoint xray --volume "$mount:/c:ro" "$image" run -test -c /c/empty.json > /dev/null 2>&1; then
  echo "ok     empty.json (подписка удалена)"
else
  echo "ОШИБКА empty.json"
  failed=1
fi

exit "$failed"
