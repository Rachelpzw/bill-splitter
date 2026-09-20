/* Render / 本地用的长驻服务：静态托管 index.html + 把 /api/ledger 转给 api/ledger.js
 *
 * 本地试跑：  node server.js          然后打开 http://localhost:3000
 * Render 上： startCommand 就是 node server.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/ledger.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function send(res, code, body, type) {
  res.statusCode = code;
  res.setHeader('Content-Type', type || 'text/plain; charset=utf-8');
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/ledger' || pathname === '/api/ledger/') {
    // 补上 Vercel 风格的 res.status / res.json
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => {
      const body = JSON.stringify(o);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(body);
      return res;
    };
    handler(req, res).catch((e) => {
      res.statusCode = 500;
      res.end('server error');
    });
    return;
  }

  // 静态文件：只允许 ROOT 内的文件，防目录穿越
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(ROOT)) { send(res, 403, 'forbidden'); return; }

  fs.readFile(full, (err, buf) => {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), (e2, buf2) => {
        if (e2) { send(res, 404, 'not found'); return; }
        send(res, 200, buf2, MIME['.html']);
      });
      return;
    }
    send(res, 200, buf, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  const db = (process.env.DATABASE_URL || '').trim();
  console.log('旅行记账本已启动: http://localhost:' + PORT);
  console.log('数据库: ' + (db ? 'Postgres（DATABASE_URL 已设置）' : '临时内存库 —— 重启会丢数据，仅供本地试玩'));
});
