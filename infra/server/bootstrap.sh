#!/usr/bin/env bash
# Подготовка чистого Ubuntu 24.04 LTS под прод «Рубежа»
# (docs/20-env-and-ports.md §5.2). Запускается под root, повторный запуск
# безопасен: каждый шаг проверяет, не сделан ли он уже.
#
#   ssh root@<адрес> "DEPLOY_KEYS='ssh-ed25519 … владелец' bash -s" < infra/server/bootstrap.sh
#
# DEPLOY_KEYS — публичные ключи пользователя деплоя, по строке на ключ:
# ключ владельца и ключ CI для выката. Закрытых ключей скрипт не видит.
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
: "${DEPLOY_KEYS:?нужны публичные ключи пользователя ${DEPLOY_USER}: DEPLOY_KEYS='ssh-ed25519 …'}"
# Свап на машине с 4 ГБ: сборка и Postgres под пиковой нагрузкой иначе
# упираются в память, и ядро начинает убивать процессы.
SWAP_SIZE="${SWAP_SIZE:-2G}"
APP_ROOT="/srv/rubezh"

export DEBIAN_FRONTEND=noninteractive

step() { printf '\n==> %s\n' "$1"; }

step "Обновления и пакеты"
apt-get update -q
apt-get -yq -o Dpkg::Options::=--force-confold upgrade
apt-get install -yq ca-certificates curl gnupg ufw fail2ban unattended-upgrades jq age

step "Часовой пояс UTC"
# Сервер в UTC: иначе поедут сутки в аналитике и hold-периоды выплат (CLAUDE.md).
timedatectl set-timezone UTC

step "Свап ${SWAP_SIZE}"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
# Свап — страховка от убийства процессов, а не продолжение памяти: ядро
# уходит в него только когда иначе нельзя.
cat > /etc/sysctl.d/99-rubezh.conf <<'SYSCTL'
vm.swappiness = 10
SYSCTL
sysctl --quiet --system

step "Docker Engine и Compose"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Ротация логов контейнеров: без неё логи съедают диск тихо и полностью.
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'DOCKER'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
DOCKER
systemctl restart docker

step "Пользователь деплоя ${DEPLOY_USER}"
id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
# Группа docker — это права на контейнеры, то есть почти root: выкату их
# хватает, а sudo пользователю деплоя не нужен вовсе.
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"
printf '%s\n' "$DEPLOY_KEYS" > "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"

step "Каталоги приложения"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_ROOT" "$APP_ROOT/web" "$APP_ROOT/backups"

step "SSH: только ключи"
cat > /etc/ssh/sshd_config.d/10-rubezh.conf <<'SSHD'
# Вход только по ключу: пароль на открытом 22-м порту перебирают круглосуточно.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSHD
sshd -t
systemctl reload ssh

step "Firewall: наружу только 22, 80, 443"
# Опубликованные порты Docker идут мимо ufw, поэтому в compose порт
# публикует только Caddy — остальные сервисы живут во внутренней сети.
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
# HTTP/3 у Caddy — по UDP.
ufw allow 443/udp
ufw --force enable

step "fail2ban для SSH"
cat > /etc/fail2ban/jail.d/sshd.local <<'JAIL'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
JAIL
systemctl enable --now fail2ban
systemctl restart fail2ban

step "Автообновления безопасности"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT
systemctl enable --now unattended-upgrades

step "Готово"
docker --version
docker compose version
ufw status | head -3
free -m | head -3
