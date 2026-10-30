/**
 * 分镜预演（dry run）
 * ------------------------------------------------------------
 * 在没有图形界面的环境里，先确认"每一步都能被点到、每个等待条件都会满足"。
 * 它检查的是流程可达性，不是画面效果——画面只能靠真人录。
 *
 * 做法：用 jsdom 加载真实的 index.html（含 recorder.js），
 * 把 recorder 里的 sleep 换成 0、getBoundingClientRect 换成固定坐标，
 * 然后逐步调 REC_RUN(step)，看是否抛错、DOM 是否真的变化了。
 *
 *   node tools/dryrun.js
 */
const fs = require('fs');
const path = require('path');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('⚠ 未安装 jsdom，跳过预演。请在临时目录 npm i jsdom 后，用 NODE_PATH 指过去。');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// 外部脚本改内联，保证文档顺序执行
for (const f of ['src/engine.js', 'src/data.js']) {
  const tag = new RegExp('<script src="' + f.replace(/[./]/g, m => '\\' + m) + '"></script>');
  if (!tag.test(html)) { console.error('✗ 找不到脚本标签: ' + f); process.exit(1); }
  html = html.replace(tag, '<script>' + fs.readFileSync(path.join(ROOT, f), 'utf8') + '<\/script>');
}
// 录制器是运行时动态插入的，预演时直接内联到最后
html = html.replace('</body>', '<script>' + fs.readFileSync(path.join(ROOT, 'src/recorder.js'), 'utf8') + '<\/script></body>');
// 录制器由 location.search 触发加载，预演时直接改地址
const URL_ = 'http://localhost/?rec=1';

const errors = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: URL_,
  beforeParse(win) {
    win.confirm = () => true;
    // 固定布局：每个元素 120×32，避免 jsdom 全 0 导致的坐标退化
    const proto = win.Element.prototype;
    proto.getBoundingClientRect = function () {
      const i = [...this.ownerDocument.querySelectorAll('*')].indexOf(this);
      return { x: 20 + (i % 8) * 130, y: 40 + (i % 30) * 40, left: 20 + (i % 8) * 130, top: 40 + (i % 30) * 40, width: 120, height: 32, right: 0, bottom: 0, toJSON() {} };
    };
    proto.scrollIntoView = function () {};
    // jsdom 不实现命中测试：直接返回"光标的坐标上应该是什么"，
    // 语义上等价——真实浏览器里这步用来确认按钮没被遮挡。
    win.document.elementFromPoint = function (x, y) {
      const all = [...this.querySelectorAll('button,a,.chip,[onclick],#inp')];
      let best = null, bd = Infinity;
      for (const el of all) {
        const r = el.getBoundingClientRect();
        const d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
        if (d < bd) { bd = d; best = el; }
      }
      return bd < 200 ? best : null;
    };
    // setTimeout 默认归零：预演不需要真实节奏。
    // 但 UI.send 用「两次 rAF + setTimeout(90)」来保证首帧绘制，
    // 若 rAF 仍是真实帧率，归零的 setTimeout 会先跑而 rAF 永不触发——
    // 所以 rAF 也一并同步化，保持与 setTimeout 相同的"立即执行"语义。
    win.setTimeout = (fn) => { try { fn(); } catch (e) { errors.push(e.message); } return 0; };
    win.requestAnimationFrame = (fn) => { try { fn(Date.now()); } catch (e) { errors.push(e.message); } return 0; };
    win.cancelAnimationFrame = () => {};
    // fetch 打到进程内，不真的走网络
    win.fetch = async (url, opt) => {
      const body = opt && opt.body ? JSON.parse(opt.body) : {};
      if (String(url).includes('/api/shot')) return { ok: true, json: async () => ({ file: 'dryrun-' + (body.label || '') + '.json' }) };
      return { ok: true, json: async () => ({ at: Date.now() }) };
    };
    win.addEventListener('error', e => errors.push('window.onerror: ' + e.message));
  },
});

const win = dom.window;
win.__REC_NOSHOT__ = true;   // 预演不截图，避免 fake timer 造成的微任务乱序
const sleep = ms => new Promise(r => setTimeout(r, Math.min(ms, 1)));

(async () => {
  await sleep(30);
  const steps = win.eval('typeof REC_STEPS !== "undefined" ? REC_STEPS : null');
  if (!steps) { console.error('✗ 录制器未加载'); process.exit(1); }

  let pass = 0, fail = 0;
  const modalOn = () => win.document.getElementById('mask').classList.contains('on');
  // CTX 是内联脚本顶层的 let，window 上取不到，用同一上下文 eval 读
  const ctxSnap = () => win.eval('({ role: CTX.subject.role, day: CTX.dayTransferred })');
  // 每步的"应该发生什么"——只验证 ok 会漏掉走错分支的情况，
  // 比如本该演示跨场景联动，却落到了二次认证弹窗。
  const EXPECT = {
    '01': { chat: 'same', modal: false, verdict: '等待请求' },
    '02': { chat: 'grow', modal: true,  verdict: '二次认证', cards: 1, role: '户主 · R3 级' },
    '03': { chat: 'grow', modal: true,  verdict: '二次认证' },
    '04': { chat: 'grow', modal: false, verdict: '拦截 · L1', block: true },
    '05': { chat: 'grow', modal: false, verdict: '通过', cards: 2 },
    '06': { chat: 'grow', modal: false, verdict: '拦截 · L3', block: true, role: '户主 · R3 级' },
    '07': { chat: 'grow', modal: false, verdict: '通过', cards: 1 },
    '08': { chat: 'same', modal: true,  verdict: '通过' },
    '09': { chat: 'same', modal: true,  verdict: '通过' },
    '10': { chat: 'same', modal: false, verdict: '通过' },
  };

  for (const key of steps) {
    const k = String(key).padStart(2, '0');
    const chatBefore = win.document.querySelectorAll('#chat > *').length;
    let r, modalSeen = false;
    // 弹窗在步骤中间打开、结尾又关掉（如"确认后取消"），
    // 用 MutationObserver 记录它是否真的出现过。
    const mo = new win.MutationObserver(() => { if (modalOn()) modalSeen = true; });
    mo.observe(win.document.getElementById('mask'), { attributes: true, attributeFilter: ['class'] });

    // 分镜之间可能夹着"切主体"这类不产生对话的动作，因此用状态快照判断。
    const snap = () => ({
      chat: win.document.querySelectorAll('#chat > *').length,
      verdict: win.document.getElementById('verdictText').textContent,
      role: win.document.getElementById('rolePill').textContent,
      modal: modalOn(),
      cards: win.document.querySelectorAll('#chat .rcard').length,
      blocked: win.document.querySelectorAll('#chat .bubble.block').length,
    });
    const before = snap();
    try { r = await win.eval('REC_RUN("' + key + '")'); }
    catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
    mo.disconnect();
    const after = snap();
    const mdVisible = modalSeen || after.modal;

    const exp = EXPECT[k];
    const bad = [];
    if (!(r && r.ok)) bad.push('执行异常 ' + (r && r.error));
    if (exp) {
      if (exp.chat === 'grow' && after.chat <= before.chat) bad.push(`对话未增长 ${before.chat}→${after.chat}`);
      if (exp.chat === 'same' && after.chat !== before.chat) bad.push(`对话意外变化 ${before.chat}→${after.chat}`);
      if (exp.modal !== mdVisible) bad.push(`弹窗 ${mdVisible}（期望 ${exp.modal}）`);
      if (!after.verdict.includes(exp.verdict)) bad.push(`裁决 "${after.verdict}" 不含 "${exp.verdict}"`);
      if (exp.cards && after.cards - before.cards < exp.cards) bad.push(`结果卡片 +${after.cards - before.cards}（期望 ≥${exp.cards}）`);
      if (exp.block && after.blocked <= before.blocked) bad.push('未产生拦截提示');
      if (exp.role && after.role !== exp.role) bad.push(`主体 "${after.role}"（期望 "${exp.role}"）`);
    }
    bad.length ? fail++ : pass++;
    const cs = ctxSnap();
    console.log(`${bad.length ? '✗' : '✓'} step_${k}  对话 ${before.chat}→${after.chat}  卡片 +${after.cards - before.cards}  裁决=${after.verdict}  CTX=${cs.role}/¥${cs.day}${mdVisible ? '  [弹窗]' : ''}${bad.length ? '\n     ← ' + bad.join('；') : ''}`);
  }

  if (errors.length) {
    console.log('\n运行期捕获的异常：');
    [...new Set(errors)].slice(0, 10).forEach(e => console.log('  · ' + e));
  }
  console.log(`\n预演：${steps.length} 步，通过 ${pass}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
