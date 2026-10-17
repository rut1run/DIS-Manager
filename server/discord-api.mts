type Env={DB:D1Database;DISCORD_CLIENT_ID?:string;DISCORD_CLIENT_SECRET?:string;DISCORD_BOT_TOKEN?:string};
type Row=Record<string,any>;
const API='https://discord.com/api/v10';
const now=()=>Math.floor(Date.now()/1000);
export class ApiError extends Error {status:number;constructor(status:number,message:string){super(message);this.status=status}}
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const id=(s:string)=>/^\d{17,22}$/.test(s);
const manage=(g:any)=>g.owner||(BigInt(g.permissions||'0')&40n)!==0n;
const ready=(env:Env)=>!!(env.DISCORD_CLIENT_ID&&env.DISCORD_CLIENT_SECRET&&env.DISCORD_BOT_TOKEN);
const callback=(req:Request)=>process.env.API_BASE_URL+'/api/discord/callback';
const hex=(bytes:Uint8Array)=>Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
const unhex=(s:string)=>Uint8Array.from(s.match(/.{2}/g)||[],x=>parseInt(x,16));
async function encryptionKey(env:Env){return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.DISCORD_CLIENT_SECRET!)),'AES-GCM',false,['encrypt','decrypt'])}
export async function seal(data:unknown,env:Env){const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},await encryptionKey(env),new TextEncoder().encode(JSON.stringify(data)));return hex(iv)+'.'+hex(new Uint8Array(encrypted))}
async function unseal(data:string,env:Env){const [iv,body]=data.split('.');return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unhex(iv)},await encryptionKey(env),unhex(body))))}
async function sameSecret(a:string,b:string){const [x,y]=await Promise.all([a,b].map(s=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));return hex(new Uint8Array(x))===hex(new Uint8Array(y))}
export async function discord(path:string,token:string,method='GET',body?:unknown,retry=0):Promise<any>{
 const response=await fetch(API+path,{method,headers:{Authorization:token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 if(response.status===429){const limited=await response.json() as any;const wait=Number(limited.retry_after);if(retry<3&&wait>0&&wait<=10){await new Promise(resolve=>setTimeout(resolve,Math.ceil(wait*1000)+100));return discord(path,token,method,body,retry+1)}throw new ApiError(429,'Discordへの操作が多くなっています。少し待って再度お試しください。');}
 if(!response.ok){const messages:Record<number,string>={401:'Discordの認証情報を確認してください。',403:'Botの権限またはロールの順序を確認してください。',404:'対象が見つかりません。Botがサーバーに参加しているか確認してください。'};throw new ApiError(response.status,messages[response.status]||'Discordへの操作に失敗しました。設定や絵文字を確認してください。')}
 return response.status===204?null:response.json();
}
export async function tokenRequest(env:Env,params:Record<string,string>){
 const response=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,client_id:env.DISCORD_CLIENT_ID!,client_secret:env.DISCORD_CLIENT_SECRET!})});
 if(!response.ok)throw new ApiError(401,'Discord接続の有効期限が切れたか、認証に失敗しました。再接続してください。');return response.json() as Promise<any>;
}
async function connection(owner:string,env:Env){
 const row=await env.DB.prepare('SELECT * FROM discord_connections WHERE owner=?').bind(owner).first<Row>();
 if(!row)throw new ApiError(401,'Discordに接続してください。');
 let tokens;try{tokens=await unseal(row.tokens,env)}catch{throw new ApiError(401,'Discordに再接続してください。')}
 if(row.expires_at<now()+60){tokens=await tokenRequest(env,{grant_type:'refresh_token',refresh_token:tokens.refresh_token});await env.DB.prepare('UPDATE discord_connections SET tokens=?,expires_at=? WHERE owner=?').bind(await seal(tokens,env),now()+tokens.expires_in,owner).run()}
 return tokens.access_token as string;
}
async function guildAccess(owner:string,guild:string,env:Env){
 if(!id(guild))throw new ApiError(400,'サーバーIDが不正です。');
 const token=await connection(owner,env);const guilds=await discord('/users/@me/guilds?limit=200','Bearer '+token);
 if(!guilds.some((g:any)=>g.id===guild&&manage(g)))throw new ApiError(403,'このサーバーの管理権限がありません。');
}
async function guildResources(guild:string,env:Env){
 const auth='Bot '+env.DISCORD_BOT_TOKEN;
 const [channels,roles,me,emojis]=await Promise.all([discord('/guilds/'+guild+'/channels',auth),discord('/guilds/'+guild+'/roles',auth),discord('/guilds/'+guild+'/members/'+env.DISCORD_CLIENT_ID,auth),discord('/guilds/'+guild+'/emojis',auth)]);
 const top=Math.max(0,...roles.filter((r:any)=>me.roles.includes(r.id)).map((r:any)=>r.position));
 const selectableEmojis=emojis.filter((e:any)=>e.available!==false&&e.id&&e.name&&(!e.roles?.length||e.roles.some((roleId:string)=>me.roles.includes(roleId)||roleId===guild))).map((e:any)=>({id:e.id,name:e.name,animated:!!e.animated,value:'<'+(e.animated?'a':'')+':'+e.name+':'+e.id+'>'}));
 return {emojis:selectableEmojis,channels:channels.filter((c:any)=>[0,5].includes(c.type)).sort((a:any,b:any)=>a.position-b.position).map((c:any)=>({id:c.id,name:c.name})),roles:roles.filter((r:any)=>r.id!==guild&&!r.managed&&r.position<top).map((r:any)=>({id:r.id,name:r.name}))};
}
export function validatePanel(input:any,live=false){
 if(!input||typeof input!=='object')throw new ApiError(400,'設定が不正です。');
 const {name,title,message,roles,remove,single}=input;
 if(typeof name!=='string'||!name.trim()||name.length>80)throw new ApiError(400,'設定名は1〜80文字で入力してください。');
 if(typeof title!=='string'||!title.trim()||title.length>100||typeof message!=='string'||message.length>2000)throw new ApiError(400,'タイトルまたは本文を確認してください。');
 if(!Array.isArray(roles)||roles.length<1||roles.length>20)throw new ApiError(400,'対応は1〜20件にしてください。');
 const keys=new Set();const roleIds=new Set();
 for(const r of roles){
  if(typeof r.emoji!=='string'||typeof r.name!=='string'||!r.name.trim()||r.name.length>100||typeof r.roleId!=='string')throw new ApiError(400,'リアクションとロールを指定してください。');
  const custom=r.emoji.match(/^<(a?):(\w{2,32}):(\d{17,22})>$/);
  if(!custom&&Array.from(new Intl.Segmenter('ja',{granularity:'grapheme'}).segment(r.emoji)).length!==1)throw new ApiError(400,'リアクションは1つの絵文字にしてください。');
  if(!custom&&!/^[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0f\u20e3#*0-9]+$/u.test(r.emoji))throw new ApiError(400,'リアクションには絵文字を入力してください。');
  if(!custom&&!/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(r.emoji))throw new ApiError(400,'リアクションには絵文字を入力してください。');
  const key=custom?custom[3]:r.emoji.replace(/\ufe0f/g,'');
  if(keys.has(key))throw new ApiError(400,'同じリアクションが重複しています。');keys.add(key);
  if(live&&!id(r.roleId))throw new ApiError(400,'実際のDiscordロールを選択してください。');
  if(live&&roleIds.has(r.roleId))throw new ApiError(400,'1つの設定内で同じロールを重複して指定できません。');roleIds.add(r.roleId);
 }
 return {name:name.trim(),title:title.trim(),message,roles:roles.map((r:any)=>({emoji:r.emoji,name:r.name,roleId:r.roleId})),remove:remove!==false,single:single===true};
}
export function validateServerEmojis(roles:any[],emojis:any[]){for(const r of roles){const m=r.emoji.match(/^<a?:\w+:(\d+)>$/);if(m&&!emojis.some(e=>e.id===m[1]))throw new ApiError(400,'選択したサーバー絵文字をBotが使用できません。別の絵文字を選択してください。')}}
export const emojiPath=(emoji:string)=>{const m=emoji.match(/^<a?:(\w+):(\d+)>$/);return encodeURIComponent(m?m[1]+':'+m[2]:emoji)};
function panelResponse(r:Row){return {id:r.id,guildId:r.guild_id,channelId:r.channel_id,...JSON.parse(r.data),messageId:r.message_id,updatedAt:r.updated_at,published:!!r.active,changed:!!r.active&&r.data!==r.active}}
async function readBody(req:Request){const raw=await req.text();if(raw.length>30000)throw new ApiError(413,'設定が大きすぎます。');try{return JSON.parse(raw)}catch{throw new ApiError(400,'設定を読み取れません。')}}
export async function handle(req:Request,env:Env):Promise<Response>{
 const url=new URL(req.url),path=url.pathname.replace(/^\/api/,'');
 try{
  // Bot service calls require the server-side Bot credential.
  if(path==='/bot/configs'){
   if(req.method!=='GET')throw new ApiError(405,'操作できません。');
   if(!env.DISCORD_BOT_TOKEN||!await sameSecret(req.headers.get('Authorization')||'','Bot '+env.DISCORD_BOT_TOKEN))throw new ApiError(401,'認証が必要です。');
   const rows=await env.DB.prepare('SELECT id,guild_id,channel_id,message_id,active FROM role_panels WHERE active IS NOT NULL AND message_id IS NOT NULL').all<Row>();
   await env.DB.prepare('INSERT INTO bot_state(id,last_seen) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen').bind('gateway',now()).run();
   return json({panels:rows.results.map(r=>({id:r.id,guildId:r.guild_id,channelId:r.channel_id,messageId:r.message_id,...JSON.parse(r.active)}))});
  }
  const owner=req.headers.get('oai-authenticated-user-id');if(!owner)throw new ApiError(401,'このサイトにログインしてください。');
  if(req.method!=='GET'&&req.headers.get('Origin')!==url.origin)throw new ApiError(403,'この操作は設定サイトから実行してください。');
  if(path==='/status'&&req.method==='GET'){
   const connected=await env.DB.prepare('SELECT discord_id,username FROM discord_connections WHERE owner=?').bind(owner).first<Row>();
   const beat=await env.DB.prepare('SELECT last_seen FROM bot_state WHERE id=?').bind('gateway').first<Row>();
   const permissions=String(268435456n+8192n+1024n+2048n+65536n+64n+16384n);
   return json({configured:ready(env),missing:['DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','DISCORD_BOT_TOKEN'].filter(k=>!env[k as keyof Env]),connected:!!connected,user:connected?{id:connected.discord_id,name:connected.username}:null,botOnline:!!beat&&beat.last_seen>now()-90,redirectUri:callback(req),inviteUrl:env.DISCORD_CLIENT_ID?'https://discord.com/oauth2/authorize?client_id='+env.DISCORD_CLIENT_ID+'&scope=bot&permissions='+permissions:null});
  }
  if(path==='/discord/start'&&req.method==='GET'){
   if(!ready(env))throw new ApiError(503,'Discord接続の準備が必要です。「接続設定」を確認してください。');
   await env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(now()).run();
   const state=hex(crypto.getRandomValues(new Uint8Array(32)));
   await env.DB.prepare('INSERT INTO oauth_states(state,owner,expires_at) VALUES(?,?,?)').bind(state,owner,now()+600).run();
   const authorize=new URL('https://discord.com/oauth2/authorize');authorize.search=new URLSearchParams({client_id:env.DISCORD_CLIENT_ID!,response_type:'code',scope:'identify guilds',redirect_uri:callback(req),state}).toString();return Response.redirect(authorize.href,302);
  }
  if(path==='/discord/callback'&&req.method==='GET'){
   const state=url.searchParams.get('state')||'';
   const row=await env.DB.prepare('DELETE FROM oauth_states WHERE state=? AND owner=? AND expires_at>? RETURNING state').bind(state,owner,now()).first();
   if(!row||url.searchParams.get('error')||!url.searchParams.get('code')||(url.searchParams.has('iss')&&url.searchParams.get('iss')!=='https://discord.com'))return Response.redirect(url.origin+'/?connection=failed',302);
   const tokens=await tokenRequest(env,{grant_type:'authorization_code',code:url.searchParams.get('code')!,redirect_uri:callback(req)});
   const user=await discord('/users/@me','Bearer '+tokens.access_token);
   const previous=await env.DB.prepare('SELECT discord_id FROM discord_connections WHERE owner=?').bind(owner).first<Row>();
   if(previous&&previous.discord_id!==user.id)throw new ApiError(409,'別のDiscordアカウントに切り替える前に接続を解除してください。');
   await env.DB.prepare('INSERT INTO discord_connections(owner,discord_id,username,tokens,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET discord_id=excluded.discord_id,username=excluded.username,tokens=excluded.tokens,expires_at=excluded.expires_at').bind(owner,user.id,user.global_name||user.username,await seal(tokens,env),now()+tokens.expires_in).run();
   return Response.redirect(url.origin+'/?connection=success',302);
  }
  if(path==='/discord/disconnect'&&req.method==='POST'){
   const active=await env.DB.prepare('SELECT count(*) as total FROM role_panels WHERE owner=? AND active IS NOT NULL').bind(owner).first<Row>();
   if(active?.total)throw new ApiError(409,'投稿済みの設定を停止してから接続を解除してください。');
   const row=await env.DB.prepare('SELECT tokens FROM discord_connections WHERE owner=?').bind(owner).first<Row>();
   if(row){try{const t=await unseal(row.tokens,env);await fetch('https://discord.com/api/oauth2/token/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DISCORD_CLIENT_ID!,client_secret:env.DISCORD_CLIENT_SECRET!,token:t.access_token})})}catch{}}
   await env.DB.prepare('DELETE FROM discord_connections WHERE owner=?').bind(owner).run();return json({ok:true});
  }
  if(!ready(env))throw new ApiError(503,'Discord接続の準備が必要です。「接続設定」を確認してください。');
  if(path==='/guilds'&&req.method==='GET'){
   const token=await connection(owner,env),guilds=await discord('/users/@me/guilds?limit=200','Bearer '+token);return json({guilds:guilds.filter(manage).map((g:any)=>({id:g.id,name:g.name}))});
  }
  const resource=path.match(/^\/guilds\/(\d{17,22})\/resources$/);
  if(resource&&req.method==='GET'){await guildAccess(owner,resource[1],env);return json(await guildResources(resource[1],env))}
  if(path==='/panels'&&req.method==='GET'){
   const guild=url.searchParams.get('guildId')||'',channel=url.searchParams.get('channelId')||'';await guildAccess(owner,guild,env);
   const rows=await env.DB.prepare('SELECT * FROM role_panels WHERE owner=? AND guild_id=? AND channel_id=? ORDER BY updated_at,id').bind(owner,guild,channel).all<Row>();return json({panels:rows.results.map(panelResponse)});
  }
  if(path==='/panels'&&req.method==='POST'){
   const data=await readBody(req),guild=data.guildId,channel=data.channelId;await guildAccess(owner,guild,env);
   const resources=await guildResources(guild,env);if(!resources.channels.some((c:any)=>c.id===channel))throw new ApiError(400,'投稿先チャンネルを確認してください。');
   const panel=validatePanel(data,true);validateServerEmojis(panel.roles,resources.emojis);if(panel.roles.some((r:any)=>!resources.roles.some((x:any)=>x.id===r.roleId)))throw new ApiError(400,'Botが付与できるロールを選択してください。');
   // Use Discord's role names rather than client-supplied display names.
   panel.roles.forEach((r:any)=>r.name=resources.roles.find((x:any)=>x.id===r.roleId).name);
   if(data.id){
    const row=await env.DB.prepare('SELECT * FROM role_panels WHERE id=? AND owner=? AND guild_id=? AND channel_id=?').bind(data.id,owner,guild,channel).first<Row>();if(!row)throw new ApiError(404,'設定が見つかりません。');
    await env.DB.prepare('UPDATE role_panels SET name=?,data=?,updated_at=? WHERE id=? AND owner=?').bind(panel.name,JSON.stringify(panel),now(),data.id,owner).run();return json({panel:panelResponse({...row,name:panel.name,data:JSON.stringify(panel),updated_at:now()})});
   }
   const count=await env.DB.prepare('SELECT count(*) as total FROM role_panels WHERE owner=? AND guild_id=? AND channel_id=?').bind(owner,guild,channel).first<Row>();if(count!.total>=50)throw new ApiError(400,'1チャンネルに作成できる設定は50件までです。');
   const panelId=crypto.randomUUID();await env.DB.prepare('INSERT INTO role_panels(id,owner,guild_id,channel_id,name,data,updated_at) VALUES(?,?,?,?,?,?,?)').bind(panelId,owner,guild,channel,panel.name,JSON.stringify(panel),now()).run();return json({panel:{id:panelId,guildId:guild,channelId:channel,...panel,messageId:null,published:false,changed:false,updatedAt:now()}},201);
  }
  const panelRoute=path.match(/^\/panels\/([a-f0-9-]{36})(?:\/(publish|stop))?$/);
  if(panelRoute){
   const row=await env.DB.prepare('SELECT * FROM role_panels WHERE id=? AND owner=?').bind(panelRoute[1],owner).first<Row>();if(!row)throw new ApiError(404,'設定が見つかりません。');await guildAccess(owner,row.guild_id,env);
   if(req.method==='DELETE'&&!panelRoute[2]){
    if(row.active)throw new ApiError(409,'投稿済みの設定は先に停止してください。');
    await env.DB.prepare('DELETE FROM role_panels WHERE id=? AND owner=?').bind(row.id,owner).run();return json({ok:true});
   }
   if(req.method==='POST'&&panelRoute[2]==='stop'){await env.DB.prepare('UPDATE role_panels SET active=NULL,updated_at=? WHERE id=? AND owner=?').bind(now(),row.id,owner).run();return json({ok:true})}
   if(req.method==='POST'&&panelRoute[2]==='publish'){
    const lock=await env.DB.prepare('UPDATE role_panels SET publish_lock=? WHERE id=? AND owner=? AND publish_lock<?').bind(now()+180,row.id,owner,now()).run();if(!lock.meta.changes)throw new ApiError(409,'この設定の投稿処理は実行中です。少し待ってください。');
    try {
    const p=validatePanel(JSON.parse(row.data),true),resources=await guildResources(row.guild_id,env);
    validateServerEmojis(p.roles,resources.emojis);
    if(!resources.channels.some((c:any)=>c.id===row.channel_id)||p.roles.some((r:any)=>!resources.roles.some((x:any)=>x.id===r.roleId)))throw new ApiError(400,'チャンネルまたはロールの権限が変わりました。設定を確認してください。');
    const body={embeds:[{title:p.title,description:[p.message,...p.roles.map((r:any)=>r.emoji+' → <@&'+r.roleId+'>')].filter(Boolean).join('\n\n'),color:3355443}],allowed_mentions:{parse:[]}};
    if(body.embeds[0].description.length>4096)throw new ApiError(400,'本文とロールの合計が長すぎます。本文を短くしてください。');
    const auth='Bot '+env.DISCORD_BOT_TOKEN,base='/channels/'+row.channel_id+'/messages';
    let messageId=row.message_id;
    // Persist a newly created message id immediately so retries update the same post.
    if(!messageId){const sent=await discord(base,auth,'POST',body);messageId=sent.id;await env.DB.prepare('UPDATE role_panels SET message_id=? WHERE id=? AND owner=?').bind(messageId,row.id,owner).run()}
    else {await discord(base+'/'+messageId,auth,'PATCH',body);await discord(base+'/'+messageId+'/reactions',auth,'DELETE')}
    for(const r of p.roles)await discord(base+'/'+messageId+'/reactions/'+emojiPath(r.emoji)+'/@me',auth,'PUT');
    await env.DB.prepare('UPDATE role_panels SET active=?,updated_at=? WHERE id=? AND owner=?').bind(row.data,now(),row.id,owner).run();
    return json({panel:panelResponse({...row,message_id:messageId,active:row.data,updated_at:now()}),messageUrl:'https://discord.com/channels/'+row.guild_id+'/'+row.channel_id+'/'+messageId});
    } finally {await env.DB.prepare('UPDATE role_panels SET publish_lock=0 WHERE id=? AND owner=?').bind(row.id,owner).run()}
   }
  }
  throw new ApiError(404,'ページが見つかりません。');
 }catch(error){if(error instanceof ApiError)return json({error:error.message},error.status);return json({error:'処理に失敗しました。時間をおいて再度お試しください。'},500)}
}

