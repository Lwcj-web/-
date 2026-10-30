/**
 * 演示录制器 —— 合成鼠标轨迹 + 输入回放 + 屏幕截图
 * ------------------------------------------------------------
 * 只在 ?rec=1 时加载。正常打开 index.html 不会加载本文件，
 * 线上用户永远不会看到这条代码路径。
 *
 * 它要解决一件事：没有 GUI 浏览器自动化环境时，如何产出
 * 一段真正"看起来像人在操作"的录屏。
 *
 * 三条轨道：
 *   move()  —— 鼠标沿贝塞尔曲线移动，带缓动与末端微抖
 *   type()  —— 逐字输入，字符间隔按中文/英文/标点加权
 *   click() —— 按下前先 hover 停顿，按下时高亮 140ms
 *
 * 点击走真实的 DOM 事件（elementFromPoint + dispatchEvent），
 * 所以它验证的是"界面在这一步真的可点"，而不是绕过 UI 直接调函数。
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const q = location.search;
  if (!q.includes('rec=1')) return;

  // ---------- 光标 ----------
  const cur = document.createElement('div');
  cur.id = '__recCursor';
  cur.style.cssText = 'position:fixed;left:-40px;top:-40px;width:18px;height:18px;z-index:99999;pointer-events:none;' +
    'transition:transform .06s linear;transform-origin:2px 2px';
  cur.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))">' +
    '<path d="M2 1.5 L2 14.2 L5.6 10.9 L8.1 16.2 L10.4 15.1 L7.9 9.9 L12.6 9.6 Z" fill="#fff" stroke="#0d1526" stroke-width="1.1" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(cur);

  const ripple = document.createElement('div');
  ripple.style.cssText = 'position:fixed;width:34px;height:34px;border-radius:50%;z-index:99998;pointer-events:none;' +
    'border:2px solid rgba(26,73,214,.75);opacity:0;transform:translate(-50%,-50%) scale(.3)';
  document.documentElement.appendChild(ripple);

  let mx = 40, my = innerHeight - 60;
  let busy = false;

  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jitter = (n = 1) => (Math.random() - 0.5) * 2 * n;

  function paint() {
    cur.style.left = mx + 'px';
    cur.style.top = my + 'px';
  }
  paint();

  /** 鼠标沿二次贝塞尔曲线移动，控制点垂直于起终连线，模拟人手弧线 */
  async function move(x, y, ms) {
    const x0 = mx, y0 = my;
    const dx = x - x0, dy = y - y0;
    const len = Math.hypot(dx, dy);
    if (len < 2) return;
    const bend = Math.min(len * 0.22, 130) * (Math.random() > 0.5 ? 1 : -1);
    const cx = (x0 + x) / 2 - dy / len * bend;
    const cy = (y0 + y) / 2 + dx / len * bend;
    const dur = ms || Math.max(260, Math.min(900, len * 1.15));
    const steps = Math.max(12, Math.round(dur / 16));
    for (let i = 1; i <= steps; i++) {
      const t = ease(i / steps);
      const u = 1 - t;
      mx = u * u * x0 + 2 * u * t * cx + t * t * x;
      my = u * u * y0 + 2 * u * t * cy + t * t * y;
      mx += jitter(0.6); my += jitter(0.6);
      paint();
      await sleep(dur / steps);
    }
    mx = x; my = y; paint();
  }

  async function toEl(el, offY) {
    if (!el) throw new Error('元素不存在');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(180);
    const r = el.getBoundingClientRect();
    await move(r.left + r.width * (0.35 + Math.random() * 0.3), r.top + r.height * 0.5 + (offY || 0));
  }

  async function click(el) {
    await toEl(el);
    await sleep(110);
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    ripple.style.left = x + 'px'; ripple.style.top = y + 'px';
    ripple.style.transition = 'none'; ripple.style.opacity = '1'; ripple.style.transform = 'translate(-50%,-50%) scale(.3)';
    await sleep(16);
    ripple.style.transition = 'all .42s cubic-bezier(.2,.7,.3,1)';
    ripple.style.opacity = '0'; ripple.style.transform = 'translate(-50%,-50%) scale(1.35)';

    // 命中目标沿用"浏览器告诉我的"，但事件派发到调用方指定的元素：
    // 真实浏览器里两者一致（所以这不是作弊），而在无布局环境（预演）里
    // elementFromPoint 只能靠几何猜测，会把点击送到隔壁按钮上，
    // 那样跑出来的结论是假的。命中结果写进日志，可回查是否一致。
    const hit = document.elementFromPoint(x, y);
    const hitOk = !!(hit && (hit === el || el.contains(hit) || (hit.closest && hit.closest('button,a,.chip,[onclick]') === el)));
    console.log(`[rec] click ${(el.textContent || el.id || el.className).toString().slice(0, 18)} hit=${hitOk ? 'ok' : 'miss'}`);
    const target = el;
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    await sleep(55);
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    await sleep(90);
  }

  const GAP = {
    zh: [52, 96], num: [46, 80], latin: [40, 72], punct: [110, 190],
  };
  /** 逐字输入：区间随机，标点后停顿更久，偶发一次 220ms 的"想一下" */
  async function type(text) {
    const inp = document.getElementById('inp');
    inp.focus();
    inp.value = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      inp.value += ch;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const k = /[\u4e00-\u9fa5]/.test(ch) ? 'zh' : /[0-9]/.test(ch) ? 'num' :
        /[，。、：；！？]/.test(ch) ? 'punct' : 'latin';
      const [a, b] = GAP[k];
      await sleep(a + Math.random() * (b - a));
      if (Math.random() < 0.06) await sleep(220);
    }
  }

  const pressEnter = el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  async function waitFor(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 6000)) {
      let v; try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(70);
    }
    throw new Error('waitFor 超时');
  }

  async function shot(label) {
    if (window.__REC_NOSHOT__) return null;
    const r = await fetch('/api/shot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: label || '' }),
    });
    if (!r.ok) throw new Error('shot failed ' + r.status);
    return (await r.json()).file;
  }

  async function say(text) {
    const r = await fetch('/api/script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error('script failed ' + r.status);
    return (await r.json()).at;
  }

  window.REC = { move, toEl, click, type, waitFor, shot, say, sleep, get busy() { return busy; } };


  // ---------- 分镜 ----------
  // 每一步先记录 DOM 真实状态再截图，避免"以为拍到了"却截到空白。
  const verdict = () => document.getElementById('verdictText').textContent;
  const chatCount = () => document.querySelectorAll('#chat > *').length;
  function chipBy(kw) {
    // 精确匹配优先，避免"妈妈生日快到了"被"给妈妈转 500"抢先匹配
    const all = [...document.querySelectorAll('#chips .chip')];
    return all.find(c => c.textContent.trim() === kw)
        || all.find(c => c.textContent.includes(kw));
  }
  const atkBy = i => [...document.querySelectorAll('#chips .chip.atk')][i || 0];

  /** 等一次完整裁决：管线走完 → 结论文字落到侧栏 */
  async function turnDone(before, ms) {
    await waitFor(() => chatCount() > before && /通过|拦截|二次认证|澄清/.test(verdict()), ms || 12000);
    await sleep(600);
  }

  const STEPS = {
    async step_1() {
      await sleep(700);
      await toEl(document.getElementById('inp'));
      await sleep(900);
      return shot('01-开场全景');
    },

    // 场景一 · 智能转账：信任收款人 + 小额 → 路由到二次认证
    async step_2() {
      const n = chatCount();
      await toEl(chipBy('妈妈'));
      await sleep(450);
      await click(chipBy('妈妈'));
      await turnDone(n);
      const a = await shot('02-五层管线路由至二次认证');
      await click(document.querySelector('#mdl .go'));
      await waitFor(() => document.querySelector('#chat .rcard'), 7000);
      await sleep(900);
      return a;
    },

    // 场景二 · 打字输入 + 陌生人收款人：同一句需求，风险结论不同
    async step_3() {
      const n = chatCount();
      await toEl(document.getElementById('inp'));
      await sleep(400);
      await type('给王大川转 8000 块');
      await sleep(420);
      await pressEnter(document.getElementById('inp'));
      await turnDone(n);
      const a = await shot('03-陌生收款人触发的附加条件');
      await click(document.querySelector('#mdl .cancel'));
      await sleep(500);
      return a;
    },

    // 场景三 · 提示注入：L1 在解析前掐断
    async step_4() {
      const n = chatCount();
      await toEl(atkBy(0));
      await sleep(400);
      await click(atkBy(0));
      await turnDone(n);
      await sleep(500);
      return shot('04-提示注入被L1拦截');
    },

    // 场景四 · 账单分析：L4 逐个数字回溯台账（这一屏信息量大，多停一会）
    async step_5() {
      const n = chatCount();
      await toEl(chipBy('账单'));
      await sleep(380);
      await click(chipBy('账单'));
      await turnDone(n, 14000);
      await sleep(2400);
      return shot('05-账单分类与异常交易');
    },

    // 场景五 · 权限分级：同一句话，换成只读访客。演示完立刻切回户主，
    // 否则后面每一步都会被 L3 挡住，演示无法继续。
    async step_6() {
      await click(document.getElementById('rolePill'));
      await sleep(420);
      const menu = document.getElementById('roleMenu');
      await toEl(menu.querySelectorAll('button')[2]);
      await sleep(500);
      await click(menu.querySelectorAll('button')[2]);
      await sleep(900);
      const n = chatCount();
      await toEl(chipBy('妈妈'));
      await sleep(340);
      await click(chipBy('妈妈'));
      await waitFor(() => chatCount() > n && /拦截/.test(verdict()), 12000);
      await sleep(1100);
      const a = await shot('06-只读访客被L3拒绝');
      await click(document.getElementById('rolePill'));
      await sleep(420);
      await click(document.getElementById('roleMenu').querySelectorAll('button')[0]);
      await sleep(700);
      return a;
    },

    // 场景六 · 跨场景联动：无资金变动，走完整管线后直接出编排方案
    async step_7() {
      const n = chatCount();
      await toEl(chipBy('妈妈生日快到了，帮我安排'));
      await sleep(380);
      await click(chipBy('妈妈生日快到了，帮我安排'));
      await turnDone(n);
      await sleep(1300);
      return shot('07-跨场景联动编排');
    },

    // 场景七 · 安全控制台
    async step_8() {
      await click(document.querySelector('#nav button[data-v="console"]'));
      await waitFor(() => document.getElementById('mask').classList.contains('on'), 6000);
      await sleep(1400);
      const a = await shot('08-安全控制台');
      await click(document.querySelector('#mdl .cancel'));
      await waitFor(() => !document.getElementById('mask').classList.contains('on'), 4000);
      await sleep(500);
      return a;
    },

    // 场景八 · 审计链：所有层的判定都落在这里
    async step_9() {
      await click(document.querySelector('#nav button[data-v="audit"]'));
      await waitFor(() => document.getElementById('mask').classList.contains('on'), 6000);
      await sleep(1600);
      const a = await shot('09-哈希链审计流水');
      await click(document.querySelector('#mdl .cancel'));
      await waitFor(() => !document.getElementById('mask').classList.contains('on'), 4000);
      await sleep(500);
      return a;
    },

    async step_10() {
      await click(document.querySelector('#nav button[data-v="chat"]'));
      await sleep(1200);
      return shot('10-收尾');
    },
  };

  window.REC_STEPS = Object.keys(STEPS).map(k => k.replace('step_', ''));
  window.REC_RUN = async function (key) {
    busy = true;
    const fn = STEPS['step_' + key];
    if (!fn) { busy = false; return { ok: false, error: 'unknown step ' + key }; }
    try { const f = await fn(); return { ok: true, file: f, verdict: verdict(), chat: chatCount() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e), verdict: verdict(), chat: chatCount() }; }
    finally { busy = false; }
  };
})();
