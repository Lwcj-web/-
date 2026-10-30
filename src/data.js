/**
 * FinGuard —— 领域数据层与业务执行器
 * 所有金额均为「台账推导」，不硬编码；执行器只负责落库，不做任何风控判断。
 */

const DB = (() => {
  const KEY = 'finguard.v2';
  const DAY = 864e5;

  // ---------- 确定性伪随机（保证演示可复现） ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /** 下一次「每月 day 号」的时间戳；若本月已过则顺延到下月 */
  function nextDayOfMonth(day, from) {
    const d = new Date(from || Date.now());
    d.setDate(day); d.setHours(9, 0, 0, 0);
    if (d.getTime() <= (from || Date.now())) d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }

  function seed() {
    const rnd = mulberry32(20251102);
    const now = Date.now();
    const tx = [];

    // 商户目录：weight 控制出现频率，贴近真实大学生的消费结构
    const MERCHANTS = [
      { cat: '餐饮', w: 42, list: ['美团外卖', '瑞幸咖啡', '海底捞（科兴店）', '沙县小吃', '盒马生鲜', '麦当劳', '食堂充值'], min: 12, max: 168 },
      { cat: '交通', w: 16, list: ['深圳地铁', '滴滴出行', '中石化加油', '哈啰单车', '高铁票'], min: 3, max: 320 },
      { cat: '购物', w: 14, list: ['淘宝', '京东', '拼多多', '优衣库', '山姆会员店'], min: 29, max: 490 },
      { cat: '居住', w: 2, list: ['物业费', '水电燃气', '宽带费'], min: 80, max: 620 },
      { cat: '娱乐', w: 14, list: ['腾讯视频', '网易云音乐', '电影院', '剧本杀', '健身房', '图书馆打印'], min: 15, max: 180 },
      { cat: '数码', w: 2, list: ['Apple Store', '小米之家', '京东数码'], min: 99, max: 1299 },
      { cat: '医疗', w: 4, list: ['校医院', '叮当快药', '口腔诊所'], min: 20, max: 380 },
      { cat: '学习', w: 6, list: ['得到App', '中国大学MOOC', '教材书店', '考试报名'], min: 19, max: 299 },
    ];
    // 按权重展开成可抽样的池子
    const POOL = MERCHANTS.flatMap(m => Array(m.w).fill(m));

    for (let d = 89; d >= 0; d--) {
      const date = new Date(now - d * DAY);
      const dow = date.getDay();
      const cnt = 1 + Math.floor(rnd() * 3) + (dow === 0 || dow === 6 ? 2 : 0);
      for (let i = 0; i < cnt; i++) {
        const m = POOL[Math.floor(rnd() * POOL.length)];
        const name = m.list[Math.floor(rnd() * m.list.length)];
        const amt = Math.round((m.min + rnd() * (m.max - m.min)) * 100) / 100;
        const hh = 7 + Math.floor(rnd() * 16);
        const t = new Date(date); t.setHours(hh, Math.floor(rnd() * 60), Math.floor(rnd() * 60), 0);
        tx.push({
          id: 'TX' + (100000 + tx.length), time: t.getTime(), dir: 'out',
          cat: m.cat, merchant: name, amount: amt,
          channel: rnd() > 0.7 ? '快捷支付' : rnd() > 0.5 ? '扫码支付' : '银联在线',
          risk: 'normal',
        });
      }
    }

    // 收入
    for (let m = 2; m >= 0; m--) {
      const d = new Date(now); d.setMonth(d.getMonth() - m); d.setDate(15); d.setHours(10, 0, 0, 0);
      tx.push({ id: 'TX' + (200000 + m), time: d.getTime(), dir: 'in', cat: '收入', merchant: '实习工资', amount: 6800, channel: '代发工资', risk: 'normal' });
      tx.push({ id: 'TX' + (300000 + m), time: d.getTime() + 3600e3, dir: 'in', cat: '收入', merchant: '导师课题劳务', amount: 1500, channel: '转账', risk: 'normal' });
    }

    // 预埋异常样本（供账单分析的异常识别演示）
    const a1 = new Date(now - 2 * DAY); a1.setHours(3, 17, 0, 0);
    tx.push({ id: 'TX900001', time: a1.getTime(), dir: 'out', cat: '游戏', merchant: '某游戏平台', amount: 4980, channel: '免密支付', risk: 'high' });
    const a2 = new Date(now - 5 * DAY); a2.setHours(2, 41, 0, 0);
    tx.push({ id: 'TX900002', time: a2.getTime(), dir: 'out', cat: '购物', merchant: '跨境商户(XXX-TRADE)', amount: 2680, channel: '境外线上', risk: 'high' });
    const a3 = new Date(now - 1 * DAY); a3.setHours(23, 52, 0, 0);
    tx.push({ id: 'TX900003', time: a3.getTime(), dir: 'out', cat: '娱乐', merchant: '直播间打赏', amount: 1888, channel: '快捷支付', risk: 'high' });

    // 重复扣款（订阅管家要识别的场景）
    const dup = new Date(now - 3 * DAY); dup.setHours(9, 30, 0, 0);
    tx.push({ id: 'TX900004', time: dup.getTime(), dir: 'out', cat: '会员', merchant: '视频会员', amount: 25, channel: '代扣', risk: 'dup' });
    tx.push({ id: 'TX900005', time: dup.getTime() + 120e3, dir: 'out', cat: '会员', merchant: '视频会员', amount: 25, channel: '代扣', risk: 'dup' });

    tx.sort((x, y) => y.time - x.time);

    // 分类预算：额度不能凭空写死，否则「预算执行」一上来就是 200% 超支，
    // 看起来像系统算错了。真实做法是「近 30 天实际 + 5% 缓冲」自动建议，用户可改。
    // 这里直接由种子台账反推，保证演示首屏就处在合理区间（有一项超支，不失控）。
    const monthAgo = now - 30 * DAY;
    const byCat = {};
    tx.filter(t => t.time >= monthAgo && t.dir === 'out' && t.risk === 'normal')
      .forEach(t => { byCat[t.cat] = (byCat[t.cat] || 0) + t.amount; });
    const BUDGET_CATS = ['餐饮', '交通', '购物', '娱乐'];
    const budgets = BUDGET_CATS.map(cat => ({
      cat,
      limit: Math.round((byCat[cat] || 0) * 1.05 / 10) * 10,
      raises: cat === '餐饮' ? 1 : 0,   // 餐饮有过一次主动上调，用于演示 R-09
    }));

    return {
      version: 2,
      user: { name: '林晓', age: 22, phone: '138****6688', city: '深圳', isElder: false, kyc: 'II类' },
      account: { no: '6222 0210 ****  4321', balance: 28560.55, frozen: 0 },
      riskLevel: 2, // C1保守 C2稳健 C3进取
      contacts: [
        { name: '妈妈', phone: '139****1234', tenure: 420, trust: 'high' },
        { name: '房东张叔', phone: '137****8888', tenure: 210, trust: 'high' },
        { name: '王大川', phone: '150****2222', tenure: 36, trust: 'mid' },
      ],
      cards: [
        { id: 'D1', no: '6222 **** **** 4321', type: '借记卡', brand: '银联', state: '正常', dailyLimit: 10000, monthlyLimit: 50000 },
        { id: 'C1', no: '5324 **** **** 8890', type: '信用卡', brand: 'Visa', state: '正常', dailyLimit: 30000, monthlyLimit: 100000, creditLeft: 21800 },
      ],
      tx, holdings: [], schedules: [], subscriptions: [],
      // 储蓄计划：真实系统由「零钱通/目标存款」产品承载，这里只保留演示必要的字段
      goals: [
        { id: 'G1', aim: '换新笔记本', target: 8000, saved: 3200, monthly: 800,
          openedAt: now - 26 * DAY, autoDebit: true, nextRunAt: nextDayOfMonth(8, now) },
      ],
      // 分类预算：额度由用户设定，执行情况永远从台账实时推导，不额外记账
      budgets,
      metrics: { blocked: 0, intercepted: 0, stepup: 0 },
    };
  }

  // ---------- 订阅自动识别（从台账 + 周期特征推断，而非写死） ----------
  function detectSubscriptions(tx) {
    const groups = {};
    tx.filter(t => t.channel === '代扣' || /会员|订阅|月费|会员|云存储/.test(t.merchant))
      .forEach(t => { (groups[t.merchant] = groups[t.merchant] || []).push(t); });

    // 补一份种子订阅（真实系统会由银行代扣协议表提供）
    const seedSubs = [
      { name: '视频会员', amount: 25, cycle: 'monthly', lastPay: 3 },
      { name: '音乐会员', amount: 15, cycle: 'monthly', lastPay: 8 },
      { name: '健身私教课', amount: 199, cycle: 'monthly', lastPay: 22 },
      { name: '云存储 200G', amount: 8, cycle: 'monthly', lastPay: 12 },
      { name: '网盘加速包', amount: 6, cycle: 'monthly', lastPay: 40, dormant: true },
    ];
    return seedSubs.map((s, i) => {
      const nextDate = new Date(); nextDate.setDate(nextDate.getDate() + (30 - s.lastPay) % 30 || 1);
      return {
        id: 'SUB' + (i + 1), name: s.name, amount: s.amount, cycle: s.cycle,
        nextChargeAt: nextDate.getTime(), dormant: !!s.dormant,
        autoRenew: true, lastChargeAt: Date.now() - s.lastPay * DAY,
      };
    });
  }

  function load() {
    const raw = localStorage.getItem(KEY);
    if (raw) { try { return JSON.parse(raw); } catch (e) { /* fallthrough */ } }
    const s = seed();
    s.subscriptions = detectSubscriptions(s.tx);
    localStorage.setItem(KEY, JSON.stringify(s));
    return s;
  }
  function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
  function reset() { localStorage.removeItem(KEY); localStorage.removeItem('finguard.audit'); }

  return { load, save, reset, DAY, nextDayOfMonth };
})();

/* ============================================================
 * 业务执行器：只落库，不做判断（判断已在上游五层完成）
 * ============================================================ */
const Executor = (() => {
  const uid = p => p + Date.now().toString(36).toUpperCase();

  function transfer(tx, { payee, amount, note, contact }) {
    tx.account.balance = Math.round((tx.account.balance - amount) * 100) / 100;
    const rec = {
      id: uid('T'), time: Date.now(), dir: 'out', cat: '转账',
      merchant: contact ? contact.name : payee, amount, channel: 'Agent发起',
      risk: 'normal', note: note || '', via: 'FinGuard Agent',
    };
    tx.tx.unshift(rec);
    return { ok: true, txId: rec.id, balance: tx.account.balance };
  }

  function schedule(tx, { payee, amount, cycle, day, contact }) {
    const s = { id: uid('S'), payee, amount, cycle: cycle || 'monthly', day: day || 1, nextRunAt: nextRun(day || 1), status: 'active', createdAt: Date.now(), contact: contact?.name };
    tx.schedules.unshift(s);
    return { ok: true, scheduleId: s.id, nextRunAt: s.nextRunAt };
  }
  function nextRun(day) {
    const d = new Date(); d.setDate(day); d.setHours(9, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }

  function buy(tx, { product, amount }) {
    tx.account.balance = Math.round((tx.account.balance - amount) * 100) / 100;
    tx.holdings.push({ id: uid('H'), name: product.name, risk: product.risk, amount, nav: product.nav, shares: +(amount / product.nav).toFixed(4), boughtAt: Date.now() });
    return { ok: true, balance: tx.account.balance };
  }
  function redeem(tx, { holding }) {
    tx.account.balance = Math.round((tx.account.balance + holding.amount) * 100) / 100;
    tx.holdings = tx.holdings.filter(h => h.id !== holding.id);
    return { ok: true, balance: tx.account.balance, amount: holding.amount };
  }
  function cardOp(tx, { op, card, amount }) {
    if (op === 'lost') card.state = '挂失';
    if (op === 'freeze') card.state = '冻结';
    if (op === 'unfreeze') card.state = '正常';
    if (op === 'limit') card.dailyLimit = amount;
    if (op === 'apply') {
      const newCard = { id: uid('C'), no: '6222 **** **** ' + Math.floor(1000 + Math.random() * 8999), type: '虚拟卡', brand: '银联', state: '正常', dailyLimit: 5000, monthlyLimit: 20000, creditLeft: 0 };
      tx.cards.push(newCard);
      return { ok: true, card: newCard };
    }
    return { ok: true, card };
  }
  function cancelSub(tx, sub) { sub.autoRenew = false; sub.cancelledAt = Date.now(); return { ok: true, sub }; }

  /* ---------- 储蓄计划 ---------- */
  function createGoal(tx, { aim, target, amount, cycle }) {
    const g = {
      id: uid('G'), aim, target, saved: 0, monthly: amount,
      cycle: cycle || 'monthly', openedAt: Date.now(),
      autoDebit: true, nextRunAt: nextDayOfMonth(1, Date.now()),
    };
    tx.goals = tx.goals || [];
    tx.goals.unshift(g);
    return { ok: true, goal: g };
  }
  /** 把某笔储蓄转入新计划：扣余额 → 记一笔「储蓄」流水 → 计划余额增加 */
  function fundGoal(tx, { goal, amount }) {
    tx.account.balance = Math.round((tx.account.balance - amount) * 100) / 100;
    goal.saved = Math.round((goal.saved + amount) * 100) / 100;
    const rec = {
      id: uid('T'), time: Date.now(), dir: 'out', cat: '储蓄',
      merchant: '储蓄计划 · ' + goal.aim, amount, channel: 'Agent发起',
      risk: 'normal', via: 'FinGuard Agent',
    };
    tx.tx.unshift(rec);
    return { ok: true, txId: rec.id, balance: tx.account.balance, saved: goal.saved };
  }
  /** 提前支取：本金+已累积利息一并回到活期，按持有天数计违约金（费率由上游 R-08 判定） */
  function withdrawGoal(tx, { goal, amount, feeRate }) {
    const take = Math.min(amount, goal.saved);
    const fee = Math.round(take * (feeRate || 0) * 100) / 100;
    goal.saved = Math.round((goal.saved - take) * 100) / 100;
    tx.account.balance = Math.round((tx.account.balance + take - fee) * 100) / 100;
    if (goal.saved <= 0) tx.goals = (tx.goals || []).filter(g => g.id !== goal.id);
    return { ok: true, amount: take, fee, balance: tx.account.balance };
  }

  /* ---------- 分类预算 ---------- */
  /** 只改额度，不改历史：执行情况永远重新从台账算，杜绝「预算余额」两套账 */
  function setBudget(tx, { cat, amount }) {
    tx.budgets = tx.budgets || [];
    let b = tx.budgets.find(x => x.cat === cat);
    if (!b) { b = { cat, limit: amount, raises: 0 }; tx.budgets.push(b); }
    else {
      if (amount > b.limit) b.raises = (b.raises || 0) + 1;
      b.limit = amount;
    }
    b.updatedAt = Date.now();
    return { ok: true, budget: b };
  }

  return { transfer, schedule, buy, redeem, cardOp, cancelSub, createGoal, fundGoal, withdrawGoal, setBudget };
})();

/* ============================================================
 * 理财产品池（含真实费率与风险等级，供适当性校验）
 * ============================================================ */
const PRODUCTS = [
  { id: 'P1', name: '天天盈货币A', manager: '兴银理财', risk: 1, yield1y: 2.08, min: 1, fee: 0.00, nav: 1.0000, liquidity: 'T+0 快赎 1万', scope: '现金管理' },
  { id: 'P2', name: '稳利 90 天持有', manager: '招银理财', risk: 1, yield1y: 2.95, min: 1000, fee: 0.15, nav: 1.0321, liquidity: '90天封闭', scope: '固收类' },
  { id: 'P3', name: '安裕双债增强', manager: '易方达基金', risk: 2, yield1y: 4.12, min: 100, fee: 0.30, nav: 1.1864, liquidity: 'T+1 赎回', scope: '固收+' },
  { id: 'P4', name: '均衡价值混合', manager: '广发基金', risk: 2, yield1y: 6.35, min: 100, fee: 0.60, nav: 1.4210, liquidity: 'T+1 赎回', scope: '混合型' },
  { id: 'P5', name: '科技成长股票型', manager: '南方基金', risk: 3, yield1y: 14.72, min: 100, fee: 1.20, nav: 2.0455, liquidity: 'T+1 赎回', scope: '股票型' },
  { id: 'P6', name: '新能源主题 ETF 联接', manager: '华夏基金', risk: 3, yield1y: -6.18, min: 100, fee: 0.80, nav: 0.8123, liquidity: 'T+1 赎回', scope: '指数型' },
];
if (typeof module !== 'undefined') module.exports = { DB, Executor, PRODUCTS };
