/**
 * 答辩 PPT 逐页截图（CDP，走真实浏览器渲染，不改 PPT 本身）
 *
 *   node tools/shoot-ppt.js        # → media/screens/ppt/01.png …
 *
 * 用途：把 13 页幻灯片导成图片，方便在手机/文档里预览，或核对排版是否溢出。
 * 依赖本机 Edge（headless）+ Node 18 内置 WebSocket，不需要额外安装。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EDGE = process.env.FG_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'media', 'screens', 'ppt');
const PORT = 9398;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1400,820', '--force-device-scale-factor=1',
    `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });
  await sleep(2600);

  let list;
  for (let i = 0; i < 25; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; }
    catch { await sleep(400); }
  }
  const tgt = list.find(x => x.type === 'page');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 820, deviceScaleFactor: 1, mobile: false });

  const URL_ = 'file:///' + path.join(ROOT, 'docs', '答辩PPT.html').replace(/\\/g, '/');
  await send('Page.navigate', { url: URL_ });
  await sleep(1800);

  // 关掉缩放与提示条，按 1280×720 的版面原样裁切
  await ev(`(()=>{
    const d=document.getElementById('deck');
    d.style.transform='none'; d.style.position='absolute'; d.style.left='0'; d.style.top='0';
    document.getElementById('hint').style.display='none';
    document.getElementById('bar').style.display='none';
    document.body.style.background='#fff';
    return document.querySelectorAll('.slide').length;
  })()`);

  const n = await ev('document.querySelectorAll(".slide").length');
  for (let i = 0; i < n; i++) {
    await ev(`(()=>{const s=document.querySelectorAll('.slide');s.forEach((el,k)=>el.classList.toggle('on',k===${i}));return 1})()`);
    await sleep(420);
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 } });
    const buf = Buffer.from(r.result.data, 'base64');
    const f = String(i + 1).padStart(2, '0') + '.png';
    fs.writeFileSync(path.join(OUT, f), buf);
    console.log('  ✓ ' + f + '  ' + (buf.length / 1024).toFixed(0) + 'KB');
  }

  ws.close();
  proc.kill();
  console.log('共 ' + n + ' 页 → media/screens/ppt/');
})().catch(e => { console.error(e); process.exit(1); });
