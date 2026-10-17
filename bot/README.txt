DIS-Manager EC2版 Bot

EC2では deploy/install.sh が専用venvとsystemdを設定します。
手動実行の場合は Python 3.11以上で pip install -r requirements.txt を実行し、
DISCORD_BOT_TOKEN と DIS_MANAGER_URL を設定して python bot.py で起動します。

DIS_MANAGER_URL は EC2内では http://127.0.0.1:8793、
別のPCでは https://entry-systems.duckdns.org/dis-manager です。
Sites専用のサービスアクセストークンは不要です。
Bot Tokenはファイル公開やGitHubに含めないでください。

Botのロールを付与対象のロールより上へ移動してください。
このBotは特権Intentを使いません。
設定を15秒ごとに同期し、60秒以上同期できない場合は付与操作を停止します。
投稿や設定の停止で、すでに付与したロールは削除されません。
