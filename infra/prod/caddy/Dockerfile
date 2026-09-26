# Caddy с плагином DNS Bunny: сертификаты выпускаются DNS-записью, а не
# HTTP-проверкой (подход из vpnsibcom_api/docker/caddy). Так сертификат
# получается и за CDN Bunny, где HTTP-проверка до сервера не доходит.
#
# Отличия от источника: версии и digest закреплены — `caddy:latest` однажды
# собрал бы другой Caddy; проверка контрольных сумм Go-модулей не
# отключается (`GONOSUMDB=*` в источнике) — иначе подменённый модуль
# плагина попал бы в сборку молча.
# Официальный образ Caddy для Linux и так на Alpine: тегов с версией Alpine
# у него нет, закрепляет digest.
FROM caddy:2.11.4-builder@sha256:369218c81ca6d6af249981221b3a5c764d886dd5b058f51d144066de13f2418d AS builder
RUN xcaddy build --with github.com/caddy-dns/bunny@v1.2.0

FROM caddy:2.11.4@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
