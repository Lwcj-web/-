/**
 * 静态服务器 —— 只服务 finguard 目录，不暴露上一级路径
 * 供本地预览与录制器（recorder.js）回调客户端使用。
 *
 *   node tools/serve.js          默认 7788
 *   node tools/serve.js 8080
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 7788);
const SHOTS = path.join(ROOT, 'media', 'frames');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const readBody = req => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 20e6) reject(new Error('payload too large')); });
  req.on('end', () => resolve(b));
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);

  // ---- 录制器回调 ----
  if (req.method === 'POST' && p === '/api/shot') {
    try {
      const { label } = JSON.parse((await readBody(req)) || '{}');
      const safe = String(label || 'shot').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40);
      fs.mkdirSync(SHOTS, { recursive: true });
      const ts = Date.now();
      const file = path.join(SHOTS, `${safe}-${ts}.json`);
      fs.writeFileSync(file, JSON.stringify({ label, ts }));
      return json(res, 200, { file: path.basename(file) });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  if (req.method === 'POST' && p === '/api/script') {
    try {
      const { text } = JSON.parse((await readBody(req)) || '{}');
      fs.mkdirSync(path.join(ROOT, 'media'), { recursive: true });
      fs.appendFileSync(path.join(ROOT, 'media', 'narration.md'), `${new Date().toISOString()}  ${text}\n`);
      return json(res, 200, { at: Date.now(), text });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ---- 静态文件 ----
  const rel = p === '/' ? '/index.html' : p;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 ' + rel);
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FinGuard 预览: http://127.0.0.1:${PORT}/`);
  console.log(`录制模式:   http://127.0.0.1:${PORT}/?rec=1`);
  console.log(`测试报告:   http://127.0.0.1:${PORT}/tests.html`);
});
