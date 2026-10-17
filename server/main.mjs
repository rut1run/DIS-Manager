import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { handle, tokenRequest, discord, seal } from './discord-api.mts';

export const hash=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('hex');
const now=()=>Math.floor(Date.now()/1000);
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});

export function createApp(settings=process.env){
 const publicBase=(settings.API_BASE_URL||'http://127.0.0.1:8793').replace(/\/$/,'');
 const frontend=new URL(settings.FRONTEND_URL||'http://127.0.0.1:8080/');
 if(frontend.search||frontend.hash)throw Error('FRONTEND_URLにはクエリやフラグメントを含めないでください。');
 if(!frontend.pathname.endsWith('/'))throw Error('FRONTEND_URLの末尾に / が必要です。');
 // Callback URI is also used by the shared Discord handler.
 process.env.API_BASE_URL=publicBase;
 const allowed=new Set((settings.ADMIN_DISCORD_IDS||'').split(',').map(x=>x.trim()).filter(Boolean));
 const dbPath=settings.DB_PATH||'data/dis-manager.sqlite';
 if(dbPath!==':memory:')mkdirSync(path.dirname(dbPath),{recursive:true,mode:0o700});
 const db=new DatabaseSync(dbPath);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
 db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8').replaceAll('CREATE TABLE `','CREATE TABLE IF NOT EXISTS `'));
 db.exec(`CREATE TABLE IF NOT EXISTS web_sessions (token TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS login_tickets (ticket TEXT PRIMARY KEY,owner TEXT NOT NULL,challenge TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
 const DB={
  prepare(sql){
   const stmt=db.prepare(sql);
   const bind=(...values)=>({
    async first(){return stmt.get(...values)||null},
    async all(){return {results:stmt.all(...values)}},
    async run(){const result=stmt.run(...values);return {meta:{changes:Number(result.changes)}}}
   });
   return {...bind(),bind};
  }
 };
 const env={DB,DISCORD_CLIENT_ID:settings.DISCORD_CLIENT_ID,DISCORD_CLIENT_SECRET:settings.DISCORD_CLIENT_SECRET,DISCORD_BOT_TOKEN:settings.DISCORD_BOT_TOKEN};
 const cookiePath=new URL(publicBase).pathname.replace(/\/$/,'')||'/';
 const cookie=(value,age)=>`dis_manager_oauth=${value}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${age}${publicBase.startsWith('https:')?'; Secure':''}`;
 const redirect=(url,headers={})=>new Response(null,{status:302,headers:{Location:url,'Cache-Control':'no-store',...headers}});
 const sessions=db.prepare('SELECT owner FROM web_sessions WHERE token=? AND expires_at>?');
 async function route(req){
  const url=new URL(req.url),p=url.pathname,origin=req.headers.get('Origin');
  if(p==='/health'&&req.method==='GET')return reply({ok:true});
  if(origin&&origin!==frontend.origin)return reply({error:'許可されていないアクセスです。'},403);
  if(req.method==='OPTIONS')return new Response(null,{status:204});
  if(!['GET','HEAD'].includes(req.method)&&!p.startsWith('/api/bot/')&&origin!==frontend.origin)return reply({error:'管理画面から操作してください。'},403);
  const auth=req.headers.get('Authorization')||'';
  const owner=auth.startsWith('Bearer ')?sessions.get(hash(auth.slice(7)),now())?.owner:null;
  const validOwner=owner&&allowed.has(owner)?owner:null;
  if(p==='/api/discord/start'&&req.method==='GET'){
   if(!env.DISCORD_CLIENT_SECRET||!env.DISCORD_CLIENT_ID||!env.DISCORD_BOT_TOKEN||!allowed.size)return reply({error:'EC2の初回設定を完了してください。'},503);
   const challenge=url.searchParams.get('challenge')||'';
   if(!/^[a-f0-9]{64}$/.test(challenge))return reply({error:'管理画面の接続ボタンから開始してください。'},400);
   db.prepare('DELETE FROM oauth_states WHERE expires_at<?').run(now());
   const state=random();
   db.prepare('INSERT INTO oauth_states(state,owner,expires_at) VALUES(?,?,?)').run(hash(state),challenge,now()+600);
   const target=new URL('https://discord.com/oauth2/authorize');
   target.search=new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,response_type:'code',scope:'identify guilds',redirect_uri:publicBase+'/api/discord/callback',state}).toString();
   return redirect(target.href,{'Set-Cookie':cookie(state,600)});
  }
  if(p==='/api/discord/callback'&&req.method==='GET'){
   const state=url.searchParams.get('state')||'';
   const browserState=(req.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('dis_manager_oauth='))?.split('=')[1];
   if(!state||state!==browserState)return redirect(frontend.href+'?connection=failed');
   const pending=db.prepare('DELETE FROM oauth_states WHERE state=? AND expires_at>? RETURNING owner').get(hash(state),now());
   if(!pending||url.searchParams.has('error')||!url.searchParams.get('code')||(url.searchParams.has('iss')&&url.searchParams.get('iss')!=='https://discord.com'))return redirect(frontend.href+'?connection=failed',{'Set-Cookie':cookie('',0)});
   try{
    const tokens=await tokenRequest(env,{grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:publicBase+'/api/discord/callback'});
    const user=await discord('/users/@me','Bearer '+tokens.access_token);
    if(!allowed.has(user.id))return reply({error:'このDiscordアカウントには管理者の許可がありません。'},403);
    db.prepare('INSERT INTO discord_connections(owner,discord_id,username,tokens,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET username=excluded.username,tokens=excluded.tokens,expires_at=excluded.expires_at').run(user.id,user.id,user.global_name||user.username,await seal(tokens,env),now()+tokens.expires_in);
    db.prepare('DELETE FROM login_tickets WHERE expires_at<?').run(now());
    const ticket=random();db.prepare('INSERT INTO login_tickets VALUES(?,?,?,?)').run(hash(ticket),user.id,pending.owner,now()+60);
    return redirect(frontend.href+'?connection=success#ticket='+ticket,{'Set-Cookie':cookie('',0)});
   }catch{return redirect(frontend.href+'?connection=failed',{'Set-Cookie':cookie('',0)})}
  }
  if(p==='/api/session/exchange'&&req.method==='POST'){
   const {ticket,verifier}=await req.json();
   if(typeof ticket!=='string'||typeof verifier!=='string'||verifier.length>128)return reply({error:'認証情報が不正です。'},400);
   const row=db.prepare('DELETE FROM login_tickets WHERE ticket=? AND challenge=? AND expires_at>? RETURNING owner').get(hash(ticket),hash(verifier),now());
   if(!row||!allowed.has(row.owner))return reply({error:'ログインをやり直してください。'},401);
   const token=random();db.prepare('DELETE FROM web_sessions WHERE expires_at<?').run(now());
   db.prepare('INSERT INTO web_sessions VALUES(?,?,?)').run(hash(token),row.owner,now()+86400);
   return reply({token});
  }
  if(p==='/api/status'&&req.method==='GET'){
   const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id',validOwner||'anonymous');
   const result=await handle(new Request(req,{headers}),env);const status=await result.json();
   if(!allowed.size){status.configured=false;status.missing.push('ADMIN_DISCORD_IDS')}
   return reply(status,result.status);
  }
  if(p==='/api/bot/configs')return handle(req,env);
  if(!validOwner)return reply({error:'Discordに接続してください。'},401);
  if(!p.startsWith('/api/'))return reply({error:'ページが見つかりません。'},404);
  const headers=new Headers(req.headers);
  // Never accept identity headers supplied by a visitor.
  headers.set('oai-authenticated-user-id',validOwner);
  // The shared handler expects a same-origin request; the outer layer checked Pages origin.
  if(req.method!=='GET')headers.set('Origin',url.origin);
  const result=await handle(new Request(req,{headers}),env);
  if(p==='/api/discord/disconnect'&&result.ok)db.prepare('DELETE FROM web_sessions WHERE owner=?').run(validOwner);
  return result;
 }
 async function dispatch(req){
  let result;try{result=await route(req)}catch{result=reply({error:'処理に失敗しました。再度お試しください。'},500)}
  const headers=new Headers(result.headers);
  headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
  if(req.headers.get('Origin')===frontend.origin){headers.set('Access-Control-Allow-Origin',frontend.origin);headers.set('Vary','Origin');headers.set('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');headers.set('Access-Control-Allow-Headers','Authorization,Content-Type')}
  return new Response(result.body,{status:result.status,headers});
 }
 return {dispatch,db,close:()=>db.close()};
}
export function listen(app,port=8793){
 return http.createServer(async(req,res)=>{
  try{
   const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>32768){res.writeHead(413);res.end();return}chunks.push(chunk)}
   const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
   const result=await app.dispatch(request);
   res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
  }catch{res.writeHead(500);res.end('{"error":"サーバーエラー"}')}
 }).listen(port,'127.0.0.1');
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 process.umask(0o077);
 const app=createApp();const server=listen(app,Number(process.env.PORT||8793));
 server.on('listening',()=>console.log('DIS-Manager API ready'));
 process.on('SIGTERM',()=>server.close(()=>{app.close();process.exit(0)}));
}
