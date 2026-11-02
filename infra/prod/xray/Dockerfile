# Спутник Xray для подписок прокси (docs/35-stage4-plan.md, Р101; tasks/T-0093).
#
# Официальный образ Xray без оболочки (ни /bin/sh, ни sha256sum), а скрипту
# run.sh нужны именно они: он следит за хешем конфига и перезапускает Xray.
# Поэтому из официального образа берём только бинарник и данные, а основой
# служит Alpine с busybox — та же ветка и digest, что у образа бэкапов.
FROM ghcr.io/xtls/xray-core:26.10.31@sha256:ceabeac03a89d991d2a247361825c1d1d2e9c91cd5dc010f298c7dc0c2f325c9 AS xray

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

COPY --from=xray /usr/local/bin/xray /usr/local/bin/xray
COPY --from=xray /usr/local/share/xray /usr/local/share/xray
# Корневые сертификаты нужны узлам с TLS; в Alpine их нет без отдельного пакета.
COPY --from=xray /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    XRAY_LOCATION_ASSET=/usr/local/share/xray
# Тот же пользователь, что в официальном образе: без прав на запись.
USER 65532:65532
# Скрипт монтируется томом (бит исполняемости из Windows не выставить).
ENTRYPOINT ["/bin/sh", "/xray-run.sh"]
