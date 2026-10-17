const $=id=>document.getElementById(id);
const API_BASE=window.DIS_MANAGER_CONFIG.apiBase.replace(/\/$/,'');
let sessionToken=sessionStorage.getItem('dis-manager-session')||'';
$('connect').href=API_BASE+'/api/discord/start';
$('connect').onclick=async event=>{
 event.preventDefault();
 const verifier=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
 sessionStorage.setItem('dis-manager-verifier',verifier);
 const challenge=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))),x=>x.toString(16).padStart(2,'0')).join('');
 location.assign(API_BASE+'/api/discord/start?challenge='+challenge);
};
const demoChannels=[{id:'demo-roles',name:'ロール選択'},{id:'demo-welcome',name:'はじめに'},{id:'demo-notice',name:'お知らせ'}];
const demoRoles=[{id:'demo-game',name:'ゲーム'},{id:'demo-music',name:'音楽'},{id:'demo-chat',name:'雑談'}];
let status={configured:false,connected:false,missing:[],botOnline:false},live=false,busy=false,dirty=false,panels=[],resources={channels:[],roles:[]},draft=null,chosen=new Set(),toastTimer,localPanels={};
try{localPanels=JSON.parse(localStorage.getItem('dis-manager-panels')||'{}');if(!localPanels||Array.isArray(localPanels)||typeof localPanels!=='object')localPanels={}}catch{localPanels={}}
const uuid=()=>crypto.randomUUID();
const blank=(name='新しい設定')=>({id:null,name,title:'ロールを選んでください',message:'リアクションを押すと、対応するロールが付与されます。',roles:[{emoji:'🎮',name:resources.roles[0]?.name||'ゲーム',roleId:resources.roles[0]?.id||''}],remove:true,single:false,published:false,messageId:null,changed:false});
function toast(text){$('toast').textContent=text;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3500)}
function unsaved(){return !dirty||confirm('未保存の変更があります。変更を破棄して切り替えますか？')}
function markDirty(){dirty=true;updateActions()}
async function api(path,options={}){const response=await fetch(API_BASE+'/api'+path,{credentials:'omit',cache:'no-store',...options,headers:{...(sessionToken?{Authorization:'Bearer '+sessionToken}:{}),...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});let data;try{data=await response.json()}catch{throw Error('サーバーからの応答を読み取れません。再読み込みしてください。')}if(response.status===401){sessionToken='';sessionStorage.removeItem('dis-manager-session');}if(!response.ok)throw Error(data.error||'処理に失敗しました。');return data}
async function run(action){if(busy)return;busy=true;updateActions();try{await action()}catch(e){toast(e.message)}finally{busy=false;updateActions()}}
function options(el,items,value,label){el.replaceChildren();for(const item of items){const op=document.createElement('option');op.value=item.id;op.textContent=label(item);el.append(op)}if(value&&items.some(x=>x.id===value))el.value=value}
function updateActions(){
 const validChannel=!!$('channel').value,hasDraft=!!draft,canEdit=validChannel&&hasDraft;
 for(const el of $('editor').querySelectorAll('input,textarea,select,button'))el.disabled=busy||!canEdit;
 $('guild').disabled=busy||!$('guild').options.length;$('channel').disabled=busy||!resources.channels.length;
 $('panel-select').disabled=busy||!panels.length;$('new-panel').disabled=busy||!validChannel;$('duplicate-panel').disabled=busy||!canEdit;
 $('add').disabled=busy||!canEdit||(draft?.roles.length>=20);$('export').disabled=busy||!canEdit;
 $('save').textContent=busy?'処理中…':'設定を保存';
 $('publish').disabled=busy||!live||!draft?.id||dirty;
 $('publish').textContent=draft?.messageId?'Discordの投稿を更新':'Discordに投稿';
 $('stop').hidden=!draft?.published;$('stop').disabled=busy;
 $('delete-panel').disabled=busy||!draft?.id||draft?.published;
 $('saved').textContent=dirty?'未保存の変更があります':draft?.id?(live?'サイトに保存済み':'このブラウザに保存済み'):'新規・未保存';
 $('publish-help').textContent=!live?'Discordに接続すると投稿できます。':dirty||!draft?.id?'先に設定を保存してください。':!status.botOnline?'Bot本体は未接続です。投稿後の自動ロール付与にはBotの起動が必要です。':draft?.changed?'保存した変更は「Discordの投稿を更新」で反映されます。':draft?.published?'この設定はDiscordに投稿済みです。':'保存した内容をDiscordに投稿します。';
 for(const el of $('admins-page').querySelectorAll('input,button'))el.disabled=busy||!status.canManageAdmins;
 $('message-link').hidden=!live||!draft?.messageId;
 if(draft?.messageId)$('message-link').href='https://discord.com/channels/'+$('guild').value+'/'+$('channel').value+'/'+draft.messageId;
}
let currentPage='roles';
function showPage(page){
 if(page==='admins'&&!status.canManageAdmins)return;
 currentPage=page;
 for(const name of ['roles','connection','admins']){
  const pageId=name==='roles'?'role-page':name+'-page';$(pageId).hidden=name!==page;
  const nav=$('nav-'+name);nav.classList.toggle('active',name===page);if(name===page)nav.setAttribute('aria-current','page');else nav.removeAttribute('aria-current');
 }
 $('breadcrumb').textContent={roles:'リアクションロール',connection:'Discord接続',admins:'管理者'}[page];closeMenu();
}
async function loadAdmins(){
 const {admins}=await api('/admins');$('admin-list').replaceChildren();
 for(const entry of admins){
  const row=document.createElement('tr'),person=document.createElement('td'),name=document.createElement('strong'),id=document.createElement('small');
  name.textContent=entry.label||'名前未設定';id.textContent=entry.discordId;person.append(name,id);
  const role=document.createElement('td');role.textContent=entry.role==='owner'?'オーナー':'管理者';
  const action=document.createElement('td');
  if(entry.role!=='owner'){
   const button=document.createElement('button');button.type='button';button.textContent='削除';button.setAttribute('aria-label',(entry.label||entry.discordId)+'の管理者権限を削除');
   button.onclick=()=>{if(!confirm((entry.label||entry.discordId)+' の管理者権限を削除しますか？'))return;run(async()=>{await api('/admins/'+entry.discordId,{method:'DELETE'});await loadAdmins();toast('管理者権限を削除しました。')})};
   action.append(button);
  }else action.textContent='—';
  row.append(person,role,action);$('admin-list').append(row);
 }
 $('admin-list-status').textContent=admins.length+'人が登録されています。';
}
$('nav-admins').onclick=()=>{showPage('admins');run(loadAdmins)};
$('admin-refresh').onclick=()=>run(loadAdmins);
$('admin-form').onsubmit=event=>{event.preventDefault();run(async()=>{
 await api('/admins',{method:'POST',body:JSON.stringify({discordId:$('admin-id').value.trim(),label:$('admin-label').value.trim()})});
 $('admin-form').reset();await loadAdmins();toast('管理者を登録しました。');
})};
function renderPanels(){const list=[...panels];if(draft&&!draft.id)list.push({id:'new',name:draft.name+'（未保存）'});options($('panel-select'),list,draft?.id||'new',p=>p.name+(p.published?'（投稿済み）':''))}
function setDraft(panel){draft=structuredClone(panel);chosen.clear();dirty=false;$('panel-name').value=draft.name;$('title').value=draft.title;$('message').value=draft.message;$('remove').checked=draft.remove;$('single').checked=draft.single;renderPanels();renderRows();preview();updateActions()}
function renderRows(){$('rows').replaceChildren();if(!draft)return;draft.roles.forEach((r,i)=>{
 const row=document.createElement('div');row.className='row';const emoji=document.createElement('button');emoji.type='button';emoji.className='emoji-trigger';emoji.setAttribute('aria-label',(i+1)+'行目のリアクションを選択');emoji.setAttribute('aria-haspopup','dialog');emoji.title=emojiName(r.emoji)+' を変更';appendEmoji(emoji,r.emoji);const chevron=document.createElement('span');chevron.textContent='⌄';chevron.className='emoji-chevron';chevron.setAttribute('aria-hidden','true');emoji.append(chevron);emoji.onclick=()=>openEmojiPicker(i);row.append(emoji);
 const role=document.createElement('select');role.required=true;role.setAttribute('aria-label',(i+1)+'行目のロール');const empty=document.createElement('option');empty.value='';empty.textContent='ロールを選択';role.append(empty);for(const x of resources.roles){const op=document.createElement('option');op.value=x.id;op.textContent=x.name;role.append(op)}role.value=r.roleId||'';role.onchange=()=>{r.roleId=role.value;r.name=resources.roles.find(x=>x.id===role.value)?.name||'';markDirty();preview()};row.append(role);
 const del=document.createElement('button');del.type='button';del.textContent='×';del.setAttribute('aria-label',(i+1)+'行目を削除');del.onclick=()=>{draft.roles.splice(i,1);chosen.clear();markDirty();renderRows();preview();updateActions()};row.append(del);$('rows').append(row)
});updateActions()}
function preview(){
 $('pt').textContent=draft?.title||'メッセージのタイトル';$('pm').textContent=draft?.message||'';$('pc').textContent=resources.channels.find(c=>c.id===$('channel').value)?.name||'チャンネル未選択';$('count').textContent=String(draft?.roles.length||0);
 $('pr').replaceChildren();$('reactions').replaceChildren();draft?.roles.forEach((r,i)=>{const line=document.createElement('div');line.className='role';appendEmoji(line,r.emoji);line.append(document.createTextNode(' → '));const tag=document.createElement('span');tag.textContent='@'+(r.name||'ロール未選択');line.append(tag);$('pr').append(line);const b=document.createElement('button');b.type='button';appendEmoji(b,r.emoji);b.append(document.createTextNode(' '+(chosen.has(i)?'1':'0')));b.setAttribute('aria-label',(r.name||'未選択')+'のロールを試す');b.setAttribute('aria-pressed',String(chosen.has(i)));b.classList.toggle('active',chosen.has(i));b.onclick=()=>{if(chosen.has(i)){if(!draft.remove)return toast('この設定ではリアクションを外してもロールは残ります。');chosen.delete(i)}else{if(draft.single)chosen.clear();chosen.add(i)}preview()};$('reactions').append(b)})
}
async function loadChannel(wanted){if(live){const result=await api('/panels?guildId='+$('guild').value+'&channelId='+$('channel').value);panels=result.panels}else{const items=localPanels[$('channel').value];panels=Array.isArray(items)?items.filter(p=>p&&Array.isArray(p.roles)&&typeof p.name==='string'):[]}
 const p=panels.find(p=>p.id===wanted)||panels[0];setDraft(p||blank());$('notice').textContent=live?'設定はチャンネルごとにサイトへ保存されます。Discordへの反映は投稿ボタンから行えます。':'プレビューモードです。サンプルのチャンネルで複数の設定を試せます。実際のサーバーを使うには「Discord接続」を開いてください。'}
async function loadGuild(){if(!live){resources={channels:demoChannels,roles:demoRoles,emojis:[]}}else{resources=await api('/guilds/'+$('guild').value+'/resources')}options($('channel'),resources.channels,null,c=>'# '+c.name);$('role-hint').textContent=live?'Botのロールより下にある、付与可能なロールが表示されます。':'サンプルのロールです。接続後に実際のロールを取得します。';if(resources.channels.length)await loadChannel();else{panels=[];setDraft(blank());$('notice').textContent='投稿できるテキストチャンネルがありません。サーバーの設定を確認してください。'}}
function demoImport(){if(Object.keys(localPanels).length)return;try{const old=JSON.parse(localStorage.getItem('sumi-roles'));if(old&&Array.isArray(old.roles)){localPanels['demo-roles']=[{...blank('以前の設定'),...old,id:uuid(),roles:old.roles.map(r=>({...r,roleId:demoRoles.find(x=>x.name===r.name)?.id||''}))}]}}catch{}}
async function refresh(){
 status=await api('/status');live=status.configured&&status.connected;
 $('nav-admins').hidden=!status.canManageAdmins;
 if(currentPage==='admins'){if(status.canManageAdmins)await loadAdmins();else showPage('roles')}
 $('account-name').textContent=status.user?.name||'Discord未接続';$('account-status').textContent=live?'接続済み':'プレビューモード';$('mode-badge').textContent=live?'Discord接続済み':'プレビュー';
 $('bot-state').textContent='Bot：'+(status.botOnline?'稼働中':'未接続');$('gateway-status').textContent=status.botOnline?'Bot本体は稼働中です。':'Bot本体はまだ接続されていません。';
 $('connection-detail').textContent=status.connected?status.user.name+' と接続済みです。':status.configured?'Discordアカウントを接続してください。':'Application IDは設定済みです。初回設定の残りを完了すると接続できます。';
 $('connect').hidden=!status.configured||status.connected;$('disconnect').hidden=!status.connected;
 $('redirect-uri').textContent=status.redirectUri;$('invite').hidden=!status.inviteUrl;if(status.inviteUrl)$('invite').href=status.inviteUrl;
 $('secret-status').replaceChildren();for(const [key,label] of [['DISCORD_CLIENT_ID','Application ID'],['DISCORD_CLIENT_SECRET','Client Secret'],['DISCORD_BOT_TOKEN','Bot Token'],['ADMIN_DISCORD_IDS','管理者Discord ID']]){const tr=document.createElement('tr');for(const value of [label,status.missing.includes(key)?'未設定':'設定済み']){const td=document.createElement('td');td.textContent=value;tr.append(td)}$('secret-status').append(tr)}
 if(live){const result=await api('/guilds');options($('guild'),result.guilds,null,g=>g.name);if(!result.guilds.length){resources={channels:[],roles:[]};options($('channel'),[],null,c=>c.name);panels=[];setDraft(blank());$('notice').textContent='管理できるサーバーがありません。Discordの「サーバー管理」権限を確認してください。';return}}
 else{demoImport();options($('guild'),[{id:'demo',name:'サンプルサーバー'}],null,g=>g.name)}
 try{await loadGuild()}catch(e){resources={channels:[],roles:[]};options($('channel'),[],null,c=>c.name);panels=[];setDraft(blank());$('notice').textContent=e.message+' 「Discord接続」からBotをサーバーに追加してください。';throw e}
}
for(const [element,key] of [['panel-name','name'],['title','title'],['message','message'],['remove','remove'],['single','single']]){$(element).addEventListener('input',()=>{if(!draft)return;draft[key]=$(element).type==='checkbox'?$(element).checked:$(element).value;if(key==='single')chosen.clear();markDirty();preview()})}
let previousGuild='',previousChannel='';
$('guild').onfocus=()=>previousGuild=$('guild').value;$('guild').onchange=()=>{if(!unsaved()){$('guild').value=previousGuild;return}run(loadGuild)};
$('channel').onfocus=()=>previousChannel=$('channel').value;$('channel').onchange=()=>{if(!unsaved()){$('channel').value=previousChannel;return}run(()=>loadChannel())};
$('panel-select').onchange=()=>{const id=$('panel-select').value;if(!unsaved()){$('panel-select').value=draft?.id||'new';return}const p=panels.find(p=>p.id===id);if(p)setDraft(p)};
$('new-panel').onclick=()=>{if(unsaved())setDraft(blank('設定 '+(panels.length+1)))};$('duplicate-panel').onclick=()=>{if(!draft||!unsaved())return;setDraft({...structuredClone(draft),id:null,name:(draft.name+' のコピー').slice(0,80),messageId:null,published:false,changed:false});dirty=true;updateActions()};
$('add').onclick=()=>{if(!draft||draft.roles.length>=20)return;const next=standardEmojis.find(e=>!draft.roles.some(r=>emojiKey(r.emoji)===emojiKey(e.value)));draft.roles.push({emoji:next?.value||'✨',name:'',roleId:''});markDirty();renderRows();preview();$('rows').lastElementChild.querySelector('select').focus()};
$('editor').onsubmit=e=>{e.preventDefault();run(async()=>{if(!draft.roles.length)throw Error('対応を1件以上追加してください。');if(draft.roles.some(r=>!r.emoji.trim()||!r.roleId))throw Error('リアクションとロールを指定してください。');const emojis=draft.roles.map(r=>r.emoji.replace(/\ufe0f/g,''));if(new Set(emojis).size!==emojis.length)throw Error('同じリアクションを重複して指定できません。');
 const payload={...draft,guildId:$('guild').value,channelId:$('channel').value};let saved;
 if(live){const result=await api('/panels',{method:'POST',body:JSON.stringify(payload)});saved=result.panel}
 else{saved={...payload,id:draft.id||uuid()};const list=panels.filter(p=>p.id!==saved.id);list.push(saved);localPanels[$('channel').value]=list;try{localStorage.setItem('dis-manager-panels',JSON.stringify(localPanels))}catch{throw Error('ブラウザに保存できません。JSONで書き出してください。')}}
 await loadChannel(saved.id);toast(live?'設定をサイトに保存しました。':'このブラウザに保存しました。')})};
$('delete-panel').onclick=()=>{if(!draft?.id||!confirm('「'+draft.name+'」を削除しますか？'))return;run(async()=>{if(live)await api('/panels/'+draft.id,{method:'DELETE'});else{localPanels[$('channel').value]=panels.filter(p=>p.id!==draft.id);localStorage.setItem('dis-manager-panels',JSON.stringify(localPanels))}await loadChannel();toast('設定を削除しました。')})};
$('publish').onclick=()=>{if(!draft?.id||dirty||!live)return;run(async()=>{const result=await api('/panels/'+draft.id+'/publish',{method:'POST'});await loadChannel(result.panel.id);toast('Discordの投稿に反映しました。')})};
$('stop').onclick=()=>{if(!draft?.id||!confirm('ロール付与を停止しますか？ Discordの投稿と付与済みのロールは残ります。'))return;run(async()=>{await api('/panels/'+draft.id+'/stop',{method:'POST'});await loadChannel(draft.id);toast('停止しました。Botへの反映には最大15秒かかります。')})};
$('export').onclick=()=>{if(!draft)return;const content={version:2,guildId:$('guild').value,channelId:$('channel').value,...draft};const url=URL.createObjectURL(new Blob([JSON.stringify(content,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='dis-manager-'+(draft.id||'draft')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
$('nav-roles').onclick=()=>showPage('roles');$('nav-connection').onclick=()=>showPage('connection');$('refresh').onclick=()=>{if(unsaved())run(refresh)};$('disconnect').onclick=()=>run(async()=>{await api('/discord/disconnect',{method:'POST'});sessionToken='';sessionStorage.removeItem('dis-manager-session');await refresh();toast('Discordとの接続を解除しました。')});$('copy-redirect').onclick=async()=>{try{await navigator.clipboard.writeText($('redirect-uri').textContent);toast('コピーしました。')}catch{toast('URLを選択してコピーしてください。')}};
const sidebar=document.querySelector('.sidebar'),menu=$('menu-toggle');function closeMenu(){sidebar.classList.remove('open');menu.setAttribute('aria-expanded','false')}menu.onclick=()=>{const open=sidebar.classList.toggle('open');menu.setAttribute('aria-expanded',String(open))};document.addEventListener('keydown',e=>{if(e.key==='Escape'&&sidebar.classList.contains('open')){closeMenu();menu.focus()}});
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue=''}});

const standardEmojis=window.DIS_MANAGER_EMOJIS||[];
let pickerRow=-1,pickerGroup='standard';
const emojiKey=value=>value.match(/^<a?:\w+:(\d+)>$/)?.[1]||value.replace(/\ufe0f/g,'');
function emojiName(value){const m=value.match(/^<a?:(\w+):\d+>$/);return m?':'+m[1]+':':standardEmojis.find(e=>emojiKey(e.value)===emojiKey(value))?.name||value}
function appendEmoji(target,value){const match=value.match(/^<(a?):(\w+):(\d{17,22})>$/);if(match){const img=document.createElement('img');img.className='custom-emoji';img.alt=':'+match[2]+':';img.src='https://cdn.discordapp.com/emojis/'+match[3]+'.webp'+(match[1]?'?animated=true':'');img.loading='lazy';img.referrerPolicy='no-referrer';target.append(img)}else{const span=document.createElement('span');span.className='unicode-emoji';span.textContent=value||'＋';target.append(span)}}
function openEmojiPicker(index){if(busy||!draft?.roles[index])return;pickerRow=index;pickerGroup=draft.roles[index].emoji.startsWith('<')?'server':'standard';$('emoji-search').value='';renderEmojiPicker();$('emoji-picker').showModal();$('emoji-search').focus()}
function renderEmojiPicker(){
 $('emoji-standard').setAttribute('aria-pressed',String(pickerGroup==='standard'));$('emoji-server').setAttribute('aria-pressed',String(pickerGroup==='server'));
 const list=pickerGroup==='server'?(resources.emojis||[]).map(e=>({value:e.value,name:e.name})):standardEmojis;
 const search=$('emoji-search').value.trim().toLocaleLowerCase('ja'),filtered=list.filter(e=>(e.name+' '+e.value).toLocaleLowerCase('ja').includes(search));
 const current=draft?.roles[pickerRow]?.emoji||'',used=new Set(draft?.roles.filter((_,i)=>i!==pickerRow).map(r=>emojiKey(r.emoji))||[]);
 $('emoji-grid').replaceChildren();for(const entry of filtered){const b=document.createElement('button');b.type='button';b.className='emoji-option';b.disabled=used.has(emojiKey(entry.value));b.title=entry.name+(b.disabled?'（使用中）':'');b.setAttribute('aria-label',entry.name+(b.disabled?' 使用中':''));b.setAttribute('aria-pressed',String(emojiKey(entry.value)===emojiKey(current)));appendEmoji(b,entry.value);b.onclick=()=>{if(!draft?.roles[pickerRow]||busy)return;const index=pickerRow;draft.roles[index].emoji=entry.value;chosen.clear();markDirty();$('emoji-picker').close();renderRows();preview();$('rows').children[index]?.querySelector('.emoji-trigger')?.focus()};$('emoji-grid').append(b)}
 $('emoji-picker-info').textContent=pickerGroup==='server'&&!live?'Discord接続後に、このサーバーで使える絵文字を表示します。':!list.length?'使用できるサーバー絵文字がありません。':!filtered.length?'一致する絵文字がありません。':filtered.length+'件の絵文字';
}
$('emoji-search').oninput=renderEmojiPicker;$('emoji-standard').onclick=()=>{pickerGroup='standard';renderEmojiPicker()};$('emoji-server').onclick=()=>{pickerGroup='server';renderEmojiPicker()};$('emoji-picker-close').onclick=()=>$('emoji-picker').close();


run(async()=>{
 const fragment=new URLSearchParams(location.hash.slice(1));
 if(fragment.has('ticket')){
  const ticket=fragment.get('ticket');history.replaceState({},'',location.pathname+location.search);
  const verifier=sessionStorage.getItem('dis-manager-verifier')||'';sessionStorage.removeItem('dis-manager-verifier');
  const result=await api('/session/exchange',{method:'POST',body:JSON.stringify({ticket,verifier})});
  sessionToken=result.token;sessionStorage.setItem('dis-manager-session',sessionToken);
 }
 await refresh();const result=new URLSearchParams(location.search).get('connection');if(result){history.replaceState({},'',location.pathname);if(result==='failed'){showPage('connection');toast('Discordの接続を完了できませんでした。再度お試しください。')}else toast('Discordと接続しました。')}});

