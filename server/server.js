/* =========================================================
   小妈飞行棋 · WebSocket 实时中继（mjq-relay-v1）
   —— 只做"同房间转发"，不解析、不存储玩家内容。
   部署：Railway / Fly.io 等平台自动注入 PORT；本地默认 8787。
   可选环境变量：
     ALLOWED_ORIGINS  逗号分隔的来源白名单（如 https://xxx.github.io），
                      留空 = 不限制来源。
   协议：
     客户端 → 中继  {"p":"join","room":R,"name":N,"proto":"mjq-relay-v1"}
                    {"p":"pub","room":R,"to":null|"id","kind":"...","body":"<串>"}
                    {"p":"req","room":R,"to":null|"id","what":"room|state"}
                    {"p":"ping"}
     中继 → 客户端  {"p":"joined","id":ID,"peers":N,"host":id|null}
                    {"p":"peer","id":ID,"ev":"join|leave","name":N}
                    {"p":"msg","from":ID,"kind":"...","body":"..."}
                    {"p":"req","from":ID,"what":"room|state"}
                    {"p":"pong"}
   ========================================================= */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8787;
const MAX_PAYLOAD = 1024 * 1024;          // 单条消息上限 1MB（房间整包远小于此）

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

/* room（大写房号）-> Set<ws> */
const rooms = new Map();
let uid = 0;

function rawSend(ws, str){
  if(ws.readyState === 1){ try{ ws.send(str); }catch(e){} }
}
function send(ws, obj){ rawSend(ws, JSON.stringify(obj)); }

function leaveRoom(ws){
  if(!ws.room) return;
  const set = rooms.get(ws.room);
  if(set){
    set.delete(ws);
    if(set.size === 0) rooms.delete(ws.room);            // 空房即回收
    else for(const c of set) send(c, { p:'peer', id:ws.id, ev:'leave' });
  }
  ws.room = null;
}

/* 同房间转发：to 为空广播（不含发送者），否则定向 */
function fanout(room, from, to, str){
  const set = rooms.get(room);
  if(!set) return;
  for(const c of set){
    if(c === from) continue;
    if(to && c.id !== to) continue;
    rawSend(c, str);
  }
}

/* 静态托管游戏页：同域名 = 页面 + 中继一体化（Railway 一个服务全搞定） */
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.svg':  'image/svg+xml'
};

/* 仅提供探活端点与游戏页静态文件 */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  /* 探活：浏览器访问 /health 确认服务活着 */
  if (url === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      ok: true,
      service: 'mjq-relay-v1',
      rooms: rooms.size,
      connections: wss.clients.size,
      uptime_s: Math.floor(process.uptime())
    }));
    return;
  }

  /* 游戏页：/ 与 /index.html（其余路径做路径穿越防护后按文件找） */
  let rel = '/';
  try { rel = decodeURIComponent(url); } catch(e) {}
  const file = path.join(PUBLIC_DIR, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
  if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

server.on('upgrade', (req, socket, head) => {
  if(ALLOWED_ORIGINS.length){
    const origin = req.headers.origin || '';
    if(!ALLOWED_ORIGINS.includes(origin)){
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.id = 'u' + (++uid);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m; try{ m = JSON.parse(raw); }catch(e){ return; }
    if(!m || typeof m !== 'object') return;

    /* 加入房间：同一连接重复 join 幂等（不重复广播 peer-join） */
    if(m.p === 'join'){
      const room = String(m.room || '').trim().toUpperCase().slice(0, 32);
      if(!room) return;
      const isNew = ws.room !== room;
      if(isNew){
        leaveRoom(ws);                                   // 换房先退旧房
        ws.room = room;
        if(!rooms.has(room)) rooms.set(room, new Set());
        rooms.get(room).add(ws);
      }
      const set = rooms.get(room);
      send(ws, { p:'joined', id:ws.id, peers:set.size, host: set.size === 1 ? ws.id : null });
      if(isNew){
        const name = String(m.name || '玩家').slice(0, 32);
        for(const c of set) if(c !== ws)
          send(c, { p:'peer', id:ws.id, ev:'join', name });
      }
      return;
    }

    if(m.p === 'pub' || m.p === 'req'){
      if(!ws.room) return;
      if(m.p === 'pub'){
        fanout(ws.room, ws, m.to || null,
          JSON.stringify({ p:'msg', from:ws.id, kind:String(m.kind || ''), body:m.body }));
      }else{
        fanout(ws.room, ws, m.to || null,
          JSON.stringify({ p:'req', from:ws.id, what: m.what === 'room' ? 'room' : 'state' }));
      }
      return;
    }

    if(m.p === 'ping'){ send(ws, { p:'pong' }); return; }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => { /* close 会随后触发 */ });
});

/* 死链清扫：两次探测（约 60s）无 pong 即断开 */
const heartbeat = setInterval(() => {
  for(const ws of wss.clients){
    if(ws.isAlive === false){ try{ ws.terminate(); }catch(e){} continue; }
    ws.isAlive = false;
    try{ ws.ping(); }catch(e){}
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`[mjq-relay] listening on :${PORT}`);
  if(ALLOWED_ORIGINS.length) console.log(`[mjq-relay] origin allowlist: ${ALLOWED_ORIGINS.join(', ')}`);
});
