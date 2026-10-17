#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'sudo bash deploy/update-admins.sh で実行してください。'; exit 1; fi
task_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_node=/opt/dis-manager/runtime/bin/node
task_target=/opt/dis-manager/server/main.mjs
[[ -x "$task_node" && -f /etc/dis-manager.env && -f "$task_target" ]] || { echo '初回設置が必要です。sudo bash deploy/install.sh を実行してください。'; exit 1; }
"$task_node" --experimental-strip-types --test "$task_source/tests/server.test.mjs"
task_backup="${task_target}.backup-$(date +%Y%m%d%H%M%S)"
cp -p "$task_target" "$task_backup"
if [[ "$task_source/server/main.mjs" != "$task_target" ]]; then
 install -m 644 "$task_source/server/main.mjs" "$task_target"
fi
systemctl restart dis-manager-api
for task_attempt in 1 2 3 4 5; do
 if curl --fail --silent http://127.0.0.1:8793/health >/dev/null; then
  echo '管理者登録機能を反映しました。GitHub PagesをCtrl+F5で再読み込みしてください。'; exit 0
 fi
 sleep 1
done
cp -p "$task_backup" "$task_target"
systemctl restart dis-manager-api
echo '起動を確認できなかったため、サーバーの変更を元に戻しました。'
exit 1
