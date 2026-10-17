#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'sudo bash deploy/install.sh で実行してください。'; exit 1; fi
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
apt-get update
apt-get install -y python3-venv curl xz-utils ca-certificates nginx
id dis-manager >/dev/null 2>&1 || useradd --system --home /var/lib/dis-manager --shell /usr/sbin/nologin dis-manager
install -d -m 755 /opt/dis-manager
install -d -m 700 -o dis-manager -g dis-manager /var/lib/dis-manager
if [[ "$source_dir" != /opt/dis-manager ]]; then
 tar -C "$source_dir" --exclude=.git --exclude=.venv --exclude=runtime --exclude=data --exclude=__pycache__ --exclude='*.env' -cf - . | tar -C /opt/dis-manager -xf -
fi
# Use a dedicated Node runtime; existing applications keep their current Node.
if [[ ! -x /opt/dis-manager/runtime/bin/node ]]; then
 task_tmp="$(mktemp -d)"
 trap 'rm -rf "$task_tmp"' EXIT
 case "$(uname -m)" in x86_64) task_arch=x64;; aarch64) task_arch=arm64;; *) echo '未対応CPU'; exit 1;; esac
 curl --fail --location --silent --show-error https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$task_tmp/SHASUMS256.txt"
 task_archive="$(awk -v arch="$task_arch" '$2 ~ ("^node-v24[.][0-9]+[.][0-9]+-linux-" arch "[.]tar[.]xz$") {print $2}' "$task_tmp/SHASUMS256.txt")"
 [[ "$task_archive" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]]
 curl --fail --location --silent --show-error "https://nodejs.org/dist/latest-v24.x/$task_archive" -o "$task_tmp/$task_archive"
 (cd "$task_tmp"; awk -v file="$task_archive" '$2==file' SHASUMS256.txt | sha256sum --check -)
 install -d -m 755 /opt/dis-manager/runtime
 tar -xJf "$task_tmp/$task_archive" -C /opt/dis-manager/runtime --strip-components=1
fi
python3 -m venv /opt/dis-manager/.venv
/opt/dis-manager/.venv/bin/pip install -r /opt/dis-manager/bot/requirements.txt
if [[ ! -f /etc/dis-manager.env ]]; then python3 /opt/dis-manager/deploy/configure.py; fi
/opt/dis-manager/runtime/bin/node --experimental-strip-types --test /opt/dis-manager/tests/server.test.mjs
cat > /etc/systemd/system/dis-manager-api.service <<'UNIT'
[Unit]
Description=DIS-Manager API
After=network-online.target
Wants=network-online.target
[Service]
User=dis-manager
Group=dis-manager
WorkingDirectory=/opt/dis-manager
EnvironmentFile=/etc/dis-manager.env
ExecStart=/opt/dis-manager/runtime/bin/node --experimental-strip-types /opt/dis-manager/server/main.mjs
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/dis-manager
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/dis-manager-bot.service <<'UNIT'
[Unit]
Description=DIS-Manager Reaction Role Bot
After=network-online.target dis-manager-api.service
Wants=network-online.target dis-manager-api.service
[Service]
User=dis-manager
Group=dis-manager
WorkingDirectory=/opt/dis-manager
EnvironmentFile=/etc/dis-manager.env
ExecStart=/opt/dis-manager/.venv/bin/python /opt/dis-manager/bot/bot.py
Restart=on-failure
RestartSec=10
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
[Install]
WantedBy=multi-user.target
UNIT
install -m 644 /opt/dis-manager/deploy/nginx-location.conf /etc/nginx/snippets/dis-manager.conf
# Append a route to the existing HTTPS vhost, preserving Entry and Guard routes.
python3 /opt/dis-manager/deploy/nginx_setup.py
systemctl daemon-reload
systemctl enable --now dis-manager-api dis-manager-bot
systemctl restart dis-manager-api dis-manager-bot
for task_attempt in 1 2 3 4 5; do
 if curl --fail --silent http://127.0.0.1:8793/health; then break; fi
 if [[ "$task_attempt" == 5 ]]; then echo 'APIの起動を確認できませんでした。journalctl -u dis-manager-api -n 30 を確認してください。'; exit 1; fi
 sleep 1
done
systemctl is-active dis-manager-api dis-manager-bot
printf '\nEC2の設置が完了しました。README_JA.md の GitHub Pages・Discord設定を完了してください。\n'
