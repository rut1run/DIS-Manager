import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp,hash } from '../server/main.mjs';
const FRONT='https://rut1run.github.io';
const settings={DB_PATH:':memory:',FRONTEND_URL:FRONT+'/DIS-Manager/',API_BASE_URL:'https://entry-systems.duckdns.org/dis-manager',ADMIN_DISCORD_IDS:'1061938805571063819',DISCORD_CLIENT_ID:'1561058516310040596',DISCORD_CLIENT_SECRET:'test-secret',DISCORD_BOT_TOKEN:'test-bot'};
const request=(p,options={})=>new Request('https://api.example'+p,{...options});

test('public status, callback URI and authentication boundary',async()=>{
 const app=createApp(settings);
 try{
  const r=await app.dispatch(request('/api/status',{headers:{Origin:FRONT}}));
  const d=await r.json();assert.equal(d.connected,false);assert.equal(d.redirectUri,settings.API_BASE_URL+'/api/discord/callback');assert.equal(r.headers.get('Access-Control-Allow-Origin'),FRONT);
  const denied=await app.dispatch(request('/api/panels',{headers:{'oai-authenticated-user-id':'1061938805571063819'}}));assert.equal(denied.status,401);
  const evil=await app.dispatch(request('/api/status',{headers:{Origin:'https://evil.example'}}));assert.equal(evil.status,403);
  const options=await app.dispatch(request('/api/panels',{method:'OPTIONS',headers:{Origin:FRONT}}));assert.equal(options.status,204);
 }finally{app.close()}
});
test('OAuth state must be browser bound and ticket verifier is single use',async()=>{
 const app=createApp(settings);
 try{
  const start=await app.dispatch(request('/api/discord/start?challenge='+hash('verifier')));assert.equal(start.status,302);
  const location=new URL(start.headers.get('Location'));assert.equal(location.searchParams.get('redirect_uri'),settings.API_BASE_URL+'/api/discord/callback');assert.match(start.headers.get('Set-Cookie'),/HttpOnly/);
  const callback=await app.dispatch(request('/api/discord/callback?state='+location.searchParams.get('state')+'&code=fake'));
  assert.match(callback.headers.get('Location'),/connection=failed/);
  app.db.prepare('INSERT INTO login_tickets VALUES(?,?,?,?)').run(hash('ticket'),'1061938805571063819',hash('verifier'),Math.floor(Date.now()/1000)+60);
  const exchange=verifier=>app.dispatch(request('/api/session/exchange',{method:'POST',headers:{Origin:FRONT,'Content-Type':'application/json'},body:JSON.stringify({ticket:'ticket',verifier})}));
  assert.equal((await exchange('wrong')).status,401);
  const success=await exchange('verifier');assert.equal(success.status,200);assert.equal(typeof(await success.json()).token,'string');
  assert.equal((await exchange('verifier')).status,401);
 }finally{app.close()}
});
test('bot configuration requires Bot token; removed admins cannot reuse sessions',async()=>{
 const app=createApp(settings);
 try{
  assert.equal((await app.dispatch(request('/api/bot/configs'))).status,401);
  const r=await app.dispatch(request('/api/bot/configs',{headers:{Authorization:'Bot test-bot'}}));assert.equal(r.status,200);assert.deepEqual((await r.json()).panels,[]);
  app.db.prepare('INSERT INTO web_sessions VALUES(?,?,?)').run(hash('forged'),'222222222222222222',Math.floor(Date.now()/1000)+60);
  assert.equal((await app.dispatch(request('/api/panels',{headers:{Authorization:'Bearer forged'}}))).status,401);
 }finally{app.close()}
});
test('unconfigured administrator fails closed',async()=>{
 const app=createApp({...settings,ADMIN_DISCORD_IDS:''});
 try{assert.equal((await app.dispatch(request('/api/status'))).status,200);assert.equal((await(await app.dispatch(request('/api/status'))).json()).configured,false);assert.equal((await app.dispatch(request('/api/discord/start?challenge='+hash('verifier')))).status,503)}finally{app.close()}
});
test('Discord login, saved panels, published bot config and disconnect guard',async()=>{
 const app=createApp(settings), originalFetch=globalThis.fetch;
 const owner='1061938805571063819',guild='123456789012345678',channel='223456789012345678',role='323456789012345678',message='423456789012345678';
 globalThis.fetch=async(input,init={})=>{
  const u=new URL(input);let data;
  if(u.pathname==='/api/oauth2/token')data={access_token:'access',refresh_token:'refresh',expires_in:3600};
  else if(u.pathname==='/api/v10/users/@me')data={id:owner,username:'test'};
  else if(u.pathname==='/api/v10/users/@me/guilds')data=[{id:guild,name:'Guild',owner:true}];
  else if(u.pathname.endsWith('/channels')&&u.pathname.includes('/guilds/'))data=[{id:channel,name:'roles',type:0,position:0}];
  else if(u.pathname.endsWith('/roles'))data=[{id:role,name:'Member',position:1},{id:'523456789012345678',name:'Bot',position:2}];
  else if(u.pathname.includes('/members/'))data={roles:['523456789012345678']};
  else if(u.pathname.endsWith('/emojis'))data=[];
  else if(u.pathname.endsWith('/messages')&&init.method==='POST')data={id:message};
  else if(u.pathname.includes('/reactions/'))return new Response(null,{status:204});
  else throw Error('Unexpected Discord endpoint: '+u.pathname);
  return Response.json(data);
 };
 try{
  const start=await app.dispatch(request('/api/discord/start?challenge='+hash('full-verifier')));
  const state=new URL(start.headers.get('Location')).searchParams.get('state');
  const callback=await app.dispatch(request('/api/discord/callback?state='+state+'&code=test',{headers:{Cookie:'dis_manager_oauth='+state}}));
  const ticket=new URLSearchParams(new URL(callback.headers.get('Location')).hash.slice(1)).get('ticket');assert.ok(ticket);
  const exchange=await app.dispatch(request('/api/session/exchange',{method:'POST',headers:{Origin:FRONT},body:JSON.stringify({ticket,verifier:'full-verifier'})}));
  const {token}=await exchange.json();assert.ok(token);
  const headers={Origin:FRONT,Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const payload={guildId:guild,channelId:channel,name:'Panel',title:'Title',message:'Message',roles:[{emoji:'🎮',name:'untrusted name',roleId:role}],remove:true,single:true};
  const saved=await app.dispatch(request('/api/panels',{method:'POST',headers,body:JSON.stringify(payload)}));assert.equal(saved.status,201);
  const panel=(await saved.json()).panel;assert.equal(panel.roles[0].name,'Member');
  const published=await app.dispatch(request('/api/panels/'+panel.id+'/publish',{method:'POST',headers}));assert.equal(published.status,200);assert.equal((await published.json()).panel.messageId,message);
  const configs=await app.dispatch(request('/api/bot/configs',{headers:{Authorization:'Bot test-bot'}}));const entries=(await configs.json()).panels;assert.equal(entries.length,1);assert.equal(entries[0].single,true);
  const denied=await app.dispatch(request('/api/discord/disconnect',{method:'POST',headers}));assert.equal(denied.status,409);
  const stopped=await app.dispatch(request('/api/panels/'+panel.id+'/stop',{method:'POST',headers}));assert.equal(stopped.status,200);
  const configs2=await app.dispatch(request('/api/bot/configs',{headers:{Authorization:'Bot test-bot'}}));assert.deepEqual((await configs2.json()).panels,[]);
  const removed=await app.dispatch(request('/api/panels/'+panel.id,{method:'DELETE',headers}));assert.equal(removed.status,200);
  const disconnected=await app.dispatch(request('/api/discord/disconnect',{method:'POST',headers}));assert.equal(disconnected.status,200);
  assert.equal((await app.dispatch(request('/api/guilds',{headers}))).status,401);
 }finally{globalThis.fetch=originalFetch;app.close()}
});
test('only owners manage admins; removing an admin revokes sessions and login tickets',async()=>{
 const app=createApp(settings),root='1061938805571063819',other='623456789012345678';
 const until=Math.floor(Date.now()/1000)+3600;
 app.db.prepare('INSERT INTO web_sessions VALUES(?,?,?)').run(hash('root-session'),root,until);
 const headers={Origin:FRONT,Authorization:'Bearer root-session','Content-Type':'application/json'};
 const add=(discordId,label='Helper')=>app.dispatch(request('/api/admins',{method:'POST',headers,body:JSON.stringify({discordId,label})}));
 try{
  assert.equal((await app.dispatch(request('/api/admins'))).status,401);
  assert.equal((await add('123')) .status,400);
  assert.equal((await add(other,'<script>alert(1)</script>')) .status,201);
  assert.equal((await add(other)).status,409);
  app.db.prepare('INSERT INTO web_sessions VALUES(?,?,?)').run(hash('other-session'),other,until);
  app.db.prepare('INSERT INTO login_tickets VALUES(?,?,?,?)').run(hash('other-ticket'),other,hash('verifier'),until);
  const otherHeaders={Origin:FRONT,Authorization:'Bearer other-session'};
  const ownerStatus=await(await app.dispatch(request('/api/status',{headers}))).json();assert.equal(ownerStatus.canManageAdmins,true);
  const otherStatus=await(await app.dispatch(request('/api/status',{headers:otherHeaders}))).json();assert.equal(otherStatus.canManageAdmins,false);
  for(const method of ['GET','POST','DELETE']){
   const denied=await app.dispatch(request(method==='DELETE'?'/api/admins/'+root:'/api/admins',{method,headers:otherHeaders,...(method==='POST'?{body:JSON.stringify({discordId:'723456789012345678'})}:{})}));assert.equal(denied.status,403);
  }
  const list=await(await app.dispatch(request('/api/admins',{headers}))).json();assert.equal(list.admins.length,2);assert.equal(list.admins[0].role,'owner');
  assert.equal((await app.dispatch(request('/api/admins/'+root,{method:'DELETE',headers}))).status,409);
  assert.equal((await app.dispatch(request('/api/admins/'+other,{method:'DELETE',headers}))).status,200);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM web_sessions WHERE owner=?').get(other).n,0);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM login_tickets WHERE owner=?').get(other).n,0);
  assert.equal((await app.dispatch(request('/api/panels',{headers:otherHeaders}))).status,401);
 }finally{app.close()}
});
