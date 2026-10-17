#!/usr/bin/env python3
import getpass,json,os,pathlib,re
print('DIS-Manager 初回設定（秘密情報は非表示で入力します）')
front=input('GitHub Pages URL [https://rut1run.github.io/DIS-Manager/]: ').strip() or 'https://rut1run.github.io/DIS-Manager/'
if not front.startswith('https://') or not front.endswith('/') or '?' in front or '#' in front: raise SystemExit('末尾が / の HTTPS URL を指定してください。')
base=input('API URL [https://entry-systems.duckdns.org/dis-manager]: ').strip() or 'https://entry-systems.duckdns.org/dis-manager'
if not re.fullmatch(r'https://[a-zA-Z0-9.-]+/dis-manager',base):raise SystemExit('API URL は https://ホスト名/dis-manager にしてください。')
admin=input('管理者のDiscordユーザーID（複数はカンマ区切り）: ').strip()
if not admin or any(not re.fullmatch(r'\d{17,22}',x.strip()) for x in admin.split(',')):raise SystemExit('DiscordユーザーIDを入力してください。')
client=input('Application ID [1561058516310040596]: ').strip() or '1561058516310040596'
secret=getpass.getpass('Discord Client Secret: ').strip()
token=getpass.getpass('Discord Bot Token: ').strip()
if not secret or not token:raise SystemExit('秘密情報が未入力です。設定は保存していません。')
values={'FRONTEND_URL':front,'API_BASE_URL':base.rstrip('/'),'ADMIN_DISCORD_IDS':admin,'DISCORD_CLIENT_ID':client,'DISCORD_CLIENT_SECRET':secret,'DISCORD_BOT_TOKEN':token,'DIS_MANAGER_URL':'http://127.0.0.1:8793','PORT':'8793','DB_PATH':'/var/lib/dis-manager/dis-manager.sqlite'}
def quote(v):return '"'+v.replace('\\','\\\\').replace('"','\\"').replace('\n','')+'"'
p=pathlib.Path('/etc/dis-manager.env')
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:f.write(''.join(k+'='+quote(v)+'\n' for k,v in values.items()))
os.chmod(p,0o600)
print('設定を保存しました。Developer Portal の OAuth2 Redirects に追加：')
print(base+'/api/discord/callback')
print('docs/config.js の apiBase も次の値に合わせてください：'+base)
