import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { syncRichMenus, MENU, MENU_TW, menuAreas, MENU_W, MENU_H } from '../supabase/functions/line-webhook/richmenu.ts';
import { parseCommand, run } from '../supabase/functions/line-webhook/index.ts';
import { resolveInput } from '../supabase/functions/line-webhook/assistant.ts';

function fakeLine(initial = true) {
  const aliases = initial ? {'trend-us':'old-us','trend-tw':'old-tw'} : {};
  const menus = [], contents = new Map(), calls = [];
  let personal = initial ? 'old-tw' : null, defaultId = 'old-us';
  const ok = (x) => new Response(JSON.stringify(x));
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname.slice('/v2/bot/'.length), method = options.method || 'GET';
    calls.push([method,path]);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    if (path === 'richmenu/list') return ok({richmenus:menus});
    if (path === 'richmenu/alias/list') return ok({aliases:Object.entries(aliases).map(([richMenuAliasId,richMenuId])=>({richMenuAliasId,richMenuId}))});
    if (path === 'richmenu' && method === 'POST') {
      assert.ok(body.areas.every(a=>a.action.type !== 'richmenuswitch' || aliases[a.action.richMenuAliasId]));
      const id='menu-'+(menus.length+1); menus.push({...body,richMenuId:id}); return ok({richMenuId:id});
    }
    const image = /^richmenu\/(menu-\d+)\/content$/.exec(path);
    if (image) {
      if (method === 'POST') { contents.set(image[1],body); return ok({}); }
      return contents.has(image[1]) ? new Response(contents.get(image[1])) : new Response('',{status:404});
    }
    if (path === 'richmenu/alias') {aliases[body.richMenuAliasId]=body.richMenuId;return ok({});}
    if (path.startsWith('richmenu/alias/')) {aliases[path.split('/').at(-1)]=body.richMenuId;return ok({});}
    if (path === 'user/all/richmenu') return ok({richMenuId:defaultId});
    if (path.startsWith('user/all/richmenu/')) {defaultId=path.split('/').at(-1);return ok({});}
    if (path === 'user/U1/richmenu') return personal ? ok({richMenuId:personal}) : new Response('',{status:404});
    if (path.startsWith('user/U1/richmenu/')) {personal=path.split('/').at(-1);return ok({});}
    throw new Error('Unexpected LINE call '+method+' '+path);
  };
  return {fetcher, aliases, menus, calls, contents};
}
const options = {token:'test-token',owner:'U1',images:{us:new Uint8Array([1,2,3]),tw:new Uint8Array([4,5,6])}};

test('deployment updates the higher-priority personal menu and preserves Taiwan selection',async()=>{
  const f=fakeLine();
  const result=await syncRichMenus(f.fetcher,options);
  assert.equal(result.ownerMarket,'tw'); assert.equal(result.verified,true);
  assert.ok(f.calls.some(([m,p])=>m==='POST' && p==='user/U1/richmenu/'+result.menus.tw));
  assert.equal(f.aliases['trend-tw'],result.menus.tw);
  await syncRichMenus(f.fetcher,options);
  assert.equal(f.menus.length,2,'same images and actions must not create duplicate menus');
  assert.ok(!f.calls.some(([m])=>m==='DELETE'),'retain prior menus for rollback');
});

test('first install bootstraps aliases; failed uploads do not switch the current menu',async()=>{
  const first=fakeLine(false);
  await syncRichMenus(first.fetcher,options);
  assert.equal(first.menus.length,4);
  const f=fakeLine();
  const broken=async(url,opt)=>opt.method==='POST' && url.includes('api-data') ? new Response('',{status:500}) : f.fetcher(url,opt);
  await assert.rejects(syncRichMenus(broken,options),/HTTP 500/);
  assert.equal(f.aliases['trend-us'],'old-us'); assert.equal(f.aliases['trend-tw'],'old-tw');
  assert.ok(!f.calls.some(([m,p])=>m==='POST' && p.startsWith('user/')));
  await syncRichMenus(f.fetcher,options); // recover from an incomplete image upload
});

test('all visible menu entries resolve, including no-current-stock guidance',async()=>{
  const db={ownerId:async()=>'owner',get:async()=>[]};
  for(const text of [...MENU,...MENU_TW]) assert.notEqual((await resolveInput(text,parseCommand,db,{market:'tw'})).cmd,'unknown',text);
  assert.equal((await resolveInput(MENU[0],parseCommand,db,{market:'tw'})).tw,false);
  assert.deepEqual(await resolveInput('個股解讀',parseCommand,db,{ticker:'2330'}),{cmd:'explain',ticker:'2330'});
  const out=await run(await resolveInput('個股解讀',parseCommand,db),db,{});
  assert.match(out[0].text,/解讀 2330/);
  const more=await resolveInput('更多功能',parseCommand,db,{market:'tw'});
  assert.equal(more.tw,true);
});

test('checked-in PNG dimensions and complete hit regions match the menu manifest',async()=>{
  for(const file of ['richmenu.png','richmenu_tw.png']) {
    const bytes=await readFile(new URL('../docs/'+file,import.meta.url));
    assert.equal(bytes.readUInt32BE(16),MENU_W); assert.equal(bytes.readUInt32BE(20),MENU_H);
    assert.ok(bytes.length < 1024*1024);
  }
  assert.equal(menuAreas(MENU).reduce((n,a)=>n+a.bounds.width*a.bounds.height,0),MENU_W*MENU_H);
});
