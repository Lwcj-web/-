/**
 * 截取文档用图（CDP 真实视口，不用 --screenshot，避免 virtual-time 吞掉动画）。
 *
 *   node tools/shoot.js            # 输出到 media/screens
 *
 * 依赖：本机 Edge（headless）+ Node 18+（内置 WebSocket，无需 npm 安装）。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EDGE = process.env.FG_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'media', 'screens');
const PORT = 9397;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1440,900', '--force-device-scale-factor=2', `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });
  await sleep(2600);
  let list;
  for (let i = 0; i < 25; i++) { try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; } catch { await sleep(400); } }
  const tgt = list.find(x => x.type === 'page');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return 'THROW: ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0];
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const buf = Buffer.from(r.result.data, 'base64');
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log('  ✓', name, (buf.length / 1024).toFixed(0) + 'KB');
  };
  const URL_ = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html';
  const fresh = async () => {
    await send('Page.navigate', { url: URL_ });
    await sleep(1400);
    await ev(`try{localStorage.removeItem('finguard.v2');localStorage.removeItem('finguard.audit')}catch(e){}`);
    await send('Page.navigate', { url: URL_ });
    await sleep(1600);
  };

  await send('Page.enable'); await send('Runtime.enable');

  await fresh();
  await shot('01-首页.png');

  await ev(`UI.send('分析一下这个月的账单')`);
  await sleep(2400);
  await shot('02-账单分析.png');

  await fresh();
  await ev(`document.getElementById('inp').value='给妈妈转 500 块，备注生日'`);
  await sleep(200);
  await shot('02b-输入态.png');
  await ev(`UI.send('给妈妈转 500 块，备注生日')`);
  await sleep(2000);
  await shot('03-二次认证.png');

  await fresh();
  await ev(`UI.send('看看我的预算')`);
  await sleep(2200);
  await shot('04-预算执行.png');

  await fresh();
  await ev(`UI.showConsole()`);
  await sleep(600);
  await shot('05-安全控制台.png');

  // 矮屏：验证快捷指令收成一行、输入框仍在首屏
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 620, deviceScaleFactor: 2, mobile: false });
  await sleep(700);
  await fresh();
  await shot('06-矮屏适配.png');

  ws.close(); proc.kill(); process.exit(0);
})();
