import pathlib,re,subprocess,datetime
config=pathlib.Path('/etc/nginx/sites-available/entry-systems')
if not config.exists():raise SystemExit('既存のNginx設定が見つかりません。deploy/nginx-location.confをHTTPSのserver内にincludeしてください。')
s=config.read_text()
if 'include /etc/nginx/snippets/dis-manager.conf;' in s:
 subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True);raise SystemExit(0)
found=[]
for start in re.finditer(r'\bserver\s*\{',s):
 depth=1;i=start.end()
 while i<len(s) and depth:
  if s[i]=='{':depth+=1
  elif s[i]=='}':depth-=1
  i+=1
 block=s[start.start():i]
 if re.search(r'listen\s+(?:\[::\]:)?443\b',block) and re.search(r'server_name\s+[^;]*\bentry-systems\.duckdns\.org\b',block):found.append(i-1)
if not found:raise SystemExit('entry-systems.duckdns.org のHTTPS設定が見つかりません。READMEのNginx手順を確認してください。')
backup=config.with_name(config.name+'.dis-manager-backup-'+datetime.datetime.now().strftime('%Y%m%d%H%M%S'))
backup.write_text(s)
updated=s
for i in reversed(found):updated=updated[:i]+'\n    include /etc/nginx/snippets/dis-manager.conf;\n'+updated[i:]
config.write_text(updated)
if subprocess.run(['nginx','-t']).returncode:
 config.write_text(s);raise SystemExit('Nginx検証でエラーになったため元の設定に戻しました。')
subprocess.run(['systemctl','reload','nginx'],check=True)
