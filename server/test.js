/* =========================================================
   中继协议自测：node test.js（需先 npm install）
   起一个本地服务器，用 ws 客户端模拟 3 名玩家，
   完整走一遍 mjq-relay-v1 的加入/广播/定向/req/心跳/离房流程。
   ========================================================= */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.TEST_PORT) || 18787;
const URL = `ws://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, extra){
  if(cond){ passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`); }
}

/* 模拟客户端：收件箱 + 按条件等待下一条消息 */
function connect(){
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = [];
    ws.on('message', raw => {
      let m; try{ m = JSON.parse(raw); }catch(e){ return; }
      const i = waiters.findIndex(w => w.pred(m));
      if(i >= 0){ waiters.splice(i, 1)[0].resolve(m); }
      else inbox.push(m);
    });
    ws.on('open', () => res({
      ws,
      inbox,
      send: o => ws.send(JSON.stringify(o)),
      next: (pred, { timeout = 3000, label = 'message' } = {}) => new Promise((resolve, reject) => {
        const idx = inbox.findIndex(pred);
        if(idx >= 0){ resolve(inbox.splice(idx, 1)[0]); return; }
        const t = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), timeout);
        waiters.push({ pred, resolve: m => { clearTimeout(t); resolve(m); } });
      }),
      close: () => new Promise(r => { ws.on('close', r); try{ ws.close(); }catch(e){ r(); } })
    }));
    ws.on('error', rej);
  });
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit'
  });
  srv.on('error', e => { console.error('服务器启动失败:', e); process.exit(1); });

  /* 等端口就绪 */
  let up = false;
  for(let i = 0; i < 50 && !up; i++){
    try{ await fetch(`http://127.0.0.1:${PORT}/health`); up = true; }catch(e){ await sleep(100); }
  }
  if(!up){ console.error('服务器未在 5s 内就绪'); srv.kill(); process.exit(1); }
  console.log('服务器已就绪，开始协议测试\n');

  try {
    /* HTTP 探活端点 */
    const st = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    check('/health 返回 ok:true / mjq-relay-v1', st.ok === true && st.service === 'mjq-relay-v1', JSON.stringify(st));

    /* 静态托管游戏页 */
    const page = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    check('/ 托管游戏页(含标题与中继默认值)', page.includes('小妈飞行棋') && page.includes('RELAY_DEFAULT'), `len=${page.length}`);

    /* 加入房间（含房号大小写归一） */
    const a = await connect();
    a.send({ p:'join', room:'test', name:'Alice', proto:'mjq-relay-v1' });
    const ja = await a.next(m => m.p === 'joined', { label:'joined(A)' });
    check('A 加入房间：peers=1 且 host=A', ja.peers === 1 && ja.host === ja.id, JSON.stringify(ja));

    const b = await connect();
    b.send({ p:'join', room:'test', name:'Bob' });   /* 故意小写 */
    const jb = await b.next(m => m.p === 'joined');
    check('B 加入同房（小写房号归一）：peers=2 且 host=null', jb.peers === 2 && jb.host === null, JSON.stringify(jb));
    const pj = await a.next(m => m.p === 'peer' && m.ev === 'join', { label:'A 收到 B 进房' });
    check('A 收到 B 的进房通知（名字/ID 正确）', pj.name === 'Bob' && pj.id === jb.id, JSON.stringify(pj));

    /* 广播 pub */
    a.send({ p:'pub', room:'TEST', kind:'room', body:'ROOM-PACK-1' });
    const msgB = await b.next(m => m.p === 'msg', { label:'B 收到广播' });
    check('广播：B 收到 A 的 room 消息', msgB.from === ja.id && msgB.kind === 'room' && msgB.body === 'ROOM-PACK-1', JSON.stringify(msgB));

    /* 第三人进房 + 定向 pub */
    const c = await connect();
    c.send({ p:'join', room:'TEST', name:'Carol' });
    const jc = (await c.next(m => m.p === 'joined')).id;
    await a.next(m => m.p === 'peer' && m.ev === 'join', { label:'A 收到 Carol 进房' });
    await b.next(m => m.p === 'peer' && m.ev === 'join', { label:'B 收到 Carol 进房' });

    a.send({ p:'pub', to: jb.id, kind:'state', body:'ONLY-B' });
    const dm = await b.next(m => m.p === 'msg' && m.body === 'ONLY-B', { label:'B 收到定向消息' });
    check('定向：B 收到点名消息', dm.from === ja.id);
    await sleep(400);
    check('定向：Carol 未收到别人的点名消息', !c.inbox.some(m => m.body === 'ONLY-B'));

    /* req 转发（定向 + 广播） */
    b.send({ p:'req', room:'TEST', to: ja.id, what:'room' });
    const rq = await a.next(m => m.p === 'req', { label:'A 收到定向 req' });
    check('req 定向转发：A 收到 B 的索要（what=room）', rq.from === jb.id && rq.what === 'room', JSON.stringify(rq));
    c.send({ p:'req', room:'TEST', what:'state' });
    const rq2 = await a.next(m => m.p === 'req' && m.from === jc, { label:'A 收到广播 req' });
    check('req 广播转发：A 收到 Carol 的索要（what=state）', rq2.what === 'state');

    /* 心跳 */
    a.send({ p:'ping' });
    await a.next(m => m.p === 'pong', { label:'pong' });
    check('心跳：ping → pong', true);

    /* 重复 join 幂等 */
    a.send({ p:'join', room:'TEST', name:'Alice' });
    const ja2 = await a.next(m => m.p === 'joined', { label:'joined 重复' });
    check('重复 join 幂等：A 再次收到 joined（peers=3）', ja2.peers === 3, JSON.stringify(ja2));
    await sleep(400);
    check('重复 join 不重复广播 peer-join', !b.inbox.some(m => m.p === 'peer' && m.ev === 'join'));

    /* 离房通知 */
    await c.close();
    const lv = await a.next(m => m.p === 'peer' && m.ev === 'leave', { label:'A 收到离开' });
    check('离房通知：A 收到 Carol 离开', lv.id === jc);
    await b.next(m => m.p === 'peer' && m.ev === 'leave', { label:'B 收到离开' });

    /* 空房回收 */
    await a.close(); await b.close();
    await sleep(400);
    const st2 = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    check('空房回收：全员离开后 rooms=0', st2.rooms === 0, JSON.stringify(st2));

    /* 超长消息防护（>1MB 应被服务端断开） */
    const big = await connect();
    const closed = new Promise(r => big.ws.on('close', () => r(true)));
    big.send({ p:'join', room:'BIG', name:'X' });
    big.send({ p:'pub', room:'BIG', kind:'state', body: 'A'.repeat(1536 * 1024) });
    const gotClosed = await Promise.race([closed, sleep(3000).then(() => false)]);
    check('超长消息防护：>1MB 消息触发服务端断开', gotClosed === true);

  } catch(e) {
    failed++;
    console.error(`  \u2717 测试中断：${e.message}`);
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  srv.kill();
  process.exit(failed ? 1 : 0);
})();
