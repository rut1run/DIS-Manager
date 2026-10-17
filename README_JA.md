# DIS-Manager — GitHub Pages + EC2 移行版

白黒の管理画面・複数のリアクションロール設定・標準/サーバー絵文字・投稿/更新/停止・単一選択を維持しています。

- 管理画面：GitHub Pages の `main` ブランチ `/docs`
- API・SQLite・Discord Bot：既存のEC2
- APIの標準URL：`https://entry-systems.duckdns.org/dis-manager`
- Nodeは専用の24系ランタイムを使用。既存のNodeやEntry・Guardのサービス設定は変更しません。
- 管理画面のファイルだけでは保存やロール付与は動きません。EC2の設置も必要です。

## 1. GitHubへ配置

1. GitHubで `DIS-Manager` などの新しいリポジトリを作成。
2. このフォルダの中身をアップロード。`docs`・`server`・`bot`・`deploy` がリポジトリ直下に並ぶ状態にします。
3. Settings → Pages → Build and deployment → Deploy from a branch。
4. Branchを `main`、フォルダを `/docs` にしてSave。
5. リポジトリ名が `DIS-Manager` なら予定URLは `https://rut1run.github.io/DIS-Manager/`。実際の公開URLを次の初回設定で入力します。

`docs/config.js` の `apiBase` は既存EC2のURLを設定済みです。ホスト名を変える場合だけ修正してください。

## 2. EC2に設置

今まで使っているEC2へSSH接続し、以下を実行します。リポジトリ名を変更した場合はURLも変更してください。

```bash
cd ~
git clone https://github.com/rut1run/DIS-Manager.git dis-manager
cd ~/dis-manager
sudo bash deploy/install.sh
```

初回に次を入力します。

- GitHub Pagesの公開URL（末尾に `/`）
- API URL（通常はそのままEnter）
- 管理者のDiscordユーザーID
- Discord Application ID（既存の `1561058516310040596` を初期値にしています）
- Discord Client Secret
- Discord Bot Token

Client SecretとBot Tokenは画面に表示せず `/etc/dis-manager.env` へ保存します。GitHubやチャットに貼り付けないでください。管理者IDに指定されたDiscordアカウントだけがログインできます。

EC2にはapt・Node配布サイト・PyPIへの通信が必要です。Bot Tokenに対応する別のBotプロセスが動いている場合は、旧プロセスを止めてから本版を起動してください。

既存の `/etc/nginx/sites-available/entry-systems` にあるHTTPS設定へ `/dis-manager/` の経路を追加します。変更前のバックアップを自動作成し、`nginx -t` 失敗時は元に戻します。

設定ファイルやホスト名が異なる場合、`deploy/nginx-location.conf` の内容を対象HTTPSの `server { ... }` 内に追加してください。APIは `127.0.0.1:8793` のみで待ち受けるため、EC2の新しい公開ポートの開放は不要です。

## 3. Discordの設定

Developer Portal → 対象Application → OAuth2 → Redirects に次を追加して保存。

```text
https://entry-systems.duckdns.org/dis-manager/api/discord/callback
```

Botを対象サーバーに追加し、Botのロールを付与対象のロールより上へ移動します。必要権限はチャンネルを見る・メッセージ送信・埋め込みリンク・履歴を読む・リアクション追加・メッセージ管理・ロール管理。特権Intentは不要です。

GitHub Pagesを開き、「Discord接続」→「Discordで接続」。サーバーとチャンネルを選び、設定保存→Discordに投稿で使用できます。Botの同期は15秒ごとです。

ログインはタブを閉じるか24時間で失効します。接続ボタンで再ログインできます。ブラウザの追跡防止設定で第三者Cookieを許可する必要はありません。

## データについて

このパッケージには元サイトの本番DB・接続トークンを含めていません。元サイトで保存していた設定や投稿との紐付けは自動移行されません。移行後の画面で設定を作り直してください。元サイトのBotも稼働している場合は二重処理を避けるため切り替え時に停止してください。

JSON書き出しは維持していますが、現行画面にはJSON読み込み機能がないため、書き出しファイルは設定を作り直す際の控えとして利用します。

## 稼働確認・更新

```bash
sudo systemctl status dis-manager-api dis-manager-bot --no-pager
curl -fsS https://entry-systems.duckdns.org/dis-manager/health
sudo journalctl -u dis-manager-api -u dis-manager-bot -n 50 --no-pager
```

更新：

```bash
cd ~/dis-manager
git pull
sudo bash deploy/install.sh
```

設定変更：`sudo python3 /opt/dis-manager/deploy/configure.py` の後に `sudo systemctl restart dis-manager-api dis-manager-bot`。

データは `/var/lib/dis-manager/dis-manager.sqlite`。バックアップはサービスを停止してSQLiteファイルと `-wal`・`-shm` があればまとめて保管するか、SQLiteのbackup機能を使用してください。復元時はClient Secretも同じものが必要です。

## 検証済み範囲

認証境界・OAuth状態とブラウザの対応・ワンタイム認証コードと照合キー・許可Origin・Bot認証の自動テストを実施済み。Discordの実アカウントでの接続・ロール付与と、EC2上の設置は本パッケージ作成時には未実施です。
