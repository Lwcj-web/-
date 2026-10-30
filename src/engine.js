/**
 * FinGuard 守护者 —— 核心安全引擎
 * =======================================================
 * 五道防线（每道均可独立单测，见 tests.html）：
 *   L1 输入净化层   InjectionGuard  提示注入防御
 *   L2 意图解析层   IntentParser    受限语法 + 槽位抽取 + 歧义拒答
 *   L3 权限决策层   PolicyEngine    ABAC + 场景级 + 金额级 + 会话级吊销
 *   L4 事实校验层   GroundingGuard  幻觉防护：所有数字必须来自台账
 *   L5 双智能体审查 CrossExaminer   业务经理 vs 风控官 交叉否决
 *
 * 设计原则：引擎全部为纯函数/纯类，不依赖 DOM，可单独引入 Node 做单元测试。
 */

/* ============================================================
 * L1 · 提示注入防御
 * ============================================================ */
const InjectionGuard = (() => {
  // 攻击面：直接指令覆盖、角色扮演劫持、系统提示套取、编码绕过、越权目标
  const RULES = [
    { id: 'INJ-01', level: 'block', name: '指令覆盖', re: /(忽略|无视|忘记|忘掉|覆盖|绕过|跳过)(掉)?(之前|以上|上面|你)?(的)?(所有|全部|一切)?(指令|规则|提示|设定|限制|要求|system)/i },
    { id: 'INJ-02', level: 'block', name: '角色劫持', re: /(你现在是|你现在扮演|假装你是|扮演一个|切换到?)(DAN|开发者模式|无限制|管理员|root|超级用户|不受限)/i },
    { id: 'INJ-03', level: 'block', name: '提示词套取', re: /(输出|打印|复述|显示|泄露|告诉我|念出)(一下|下|出)?(你的|你)?\s*(system\s*prompt|系统提示|初始提示|system\s*message|prompt|设定的规则|配置)/i },
    { id: 'INJ-03b', level: 'block', name: '提示词套取（英文）', re: /(repeat|reveal|print|show|leak)\s+(your\s+)?(system\s*prompt|initial\s*prompt|system\s*message)/i },
    { id: 'INJ-03c', level: 'block', name: '提示词套取（裸词）', re: /(system\s*prompt|系统提示词|初始提示词)/i },
    { id: 'INJ-04', level: 'block', name: '分隔符注入', re: /(<\|im_start\|>|<\|im_end\|>|\[\/INST\]|<<SYS>>|###\s*(system|instruction)|<system>)/i },
    { id: 'INJ-04b', level: 'block', name: '模型标签伪装', re: /\[?\s*system\s*\]?\s*[:：]/i },
    { id: 'INJ-05', level: 'block', name: '越权提权', re: /((升级|提权|提升|修改|调整)(成为|为|到)?\s*(管理员|超级用户|最高权限|root))|((我|我的)(现在)?(是|就是)(管理员|超级用户|root|开发者))/i },
    { id: 'INJ-06', level: 'warn', name: '人格渗透', re: /(我现在是|以)(客服|银行工作人员|风控官|后台)(身份|的角色)/i },
    { id: 'INJ-07', level: 'block', name: '编码规避', re: /(base64|rot13|十六进制|unicode\s*转义)(解码|编码|转换)?.*(指令|规则|执行)/i },
  ];
  // 零宽字符 / 同形字夹带
  const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
  // 关键动词被拆散（转-账 / 转 账）
  const SPLIT_ATTACK = /(转|汇|付)[\s\-_·。、]*(账|款|钱)/;

  function inspect(raw) {
    const hits = [];
    let text = String(raw ?? '');

    const zw = (text.match(ZERO_WIDTH) || []).length;
    if (zw > 0) hits.push({ id: 'INJ-08', level: 'block', name: '零宽字符夹带', detail: `检测到 ${zw} 个不可见字符` });
    text = text.replace(ZERO_WIDTH, '');

    for (const r of RULES) {
      // 含英文关键词的规则需忽略大小写
      const re = r.id === 'INJ-03' ? new RegExp(r.re.source, 'i') : r.re;
      const m = text.match(re);
      if (m) hits.push({ id: r.id, level: r.level, name: r.name, detail: `命中片段「${m[0].slice(0, 24)}」` });
    }
    if (SPLIT_ATTACK.test(text) && hits.length) {
      hits.push({ id: 'INJ-09', level: 'warn', name: '分词规避', detail: '关键动词被字符分隔' });
    }
    // 超长输入 & 控制字符
    if (text.length > 500) hits.push({ id: 'INJ-10', level: 'warn', name: '超长输入', detail: `${text.length} 字符，超 500 上限` });
    if (/[\x00-\x08\x0E-\x1F]/.test(text)) hits.push({ id: 'INJ-11', level: 'block', name: '控制字符', detail: '含不可打印控制符' });

    return {
      clean: text, hits,
      verdict: hits.some(h => h.level === 'block') ? 'block' : hits.length ? 'warn' : 'pass'
    };
  }
  return { inspect, RULES };
})();

/* ============================================================
 * L2 · 意图解析（受限语法，未知即拒答，不做自由发挥）
 * ============================================================ */
const IntentParser = (() => {
  // 别名映射表：同义说法 -> 规范意图
  // 判定顺序即优先级：越具体的业务越靠前，避免被泛词抢走
  const ALIAS = {
    goal: ['心愿', '攒钱', '存钱计划', '存一笔', '储蓄计划', '目标储蓄', '攒够'],
    budget: ['预算', '超支', '还有多少额度', '花超', '控制花销', '设个预算'],
    bill: ['账单', '消费分析', '花了多少', '支出统计', '钱花哪', '流水分析'],
    transfer: ['转账', '转钱', '汇款', '打钱', '转一笔', '转给', '付款给'],
    wealth: ['理财', '基金', '申购', '买入产品', '投资收益', '买点稳健'],
    redeem: ['赎回', '取出', '卖掉', '取回'],
    card: ['卡', '挂失', '额度', '限额', '冻结', '解冻', '解锁', '办卡', '申卡', '开卡'],
    sub: ['订阅', '代扣', '续费', '自动扣款'],
    scene: ['生日', '纪念日', '联动', '惊喜', '妈妈生日'],
  };
  // 槽位抽取器
  const EXT = {
    amount: t => {
      // 万/千 可省略「元」；块/元 为显式单位；手机号中的数字不得被误当金额
      const cleaned = t.replace(/1[3-9]\d{9}/g, '「手机号」');
      const m = cleaned.match(/(\d+(?:\.\d+)?)\s*(万|千|k)(?![a-z])/i)
             || cleaned.match(/(\d+(?:\.\d+)?)\s*(块钱|块|元)/)
             || cleaned.match(/(?:转|给|付|打)\D{0,8}?(\d+(?:\.\d+)?)(?![0-9.])/);
      if (!m) return null;
      let v = parseFloat(m[1]);
      const u = (m[2] || '').toLowerCase();
      if (u === '万') v *= 10000;
      if (u === '千' || u === 'k') v *= 1000;
      return Math.round(v * 100) / 100;
    },
    payee: t => {
      // 手机号优先，其次「给/向/转给 + 姓名」，最后「姓名 + 转/汇/付 + 数字」
      const phone = t.match(/1[3-9]\d{9}/);
      if (phone) return phone[0];
      const m = t.match(/(?:给|向|转给|打给)\s*([\u4e00-\u9fa5]{2,4}?)(?=[转汇付款]|\s|\d|$)/)
             || t.match(/([\u4e00-\u9fa5]{2,4}?)(?:转|汇|付)\s*\d/);
      return m ? m[1] : null;
    },
    phone: t => (t.match(/1[3-9]\d{9}/) || [null])[0],
    cycle: t => /每月|每个月|月月/.test(t) ? 'monthly' : /每周/.test(t) ? 'weekly' : /每年|年年/.test(t) ? 'yearly' : null,
    day: t => {
      const m = t.match(/(\d{1,2})\s*[号日]|每月\s*(\d{1,2})/);
      return m ? parseInt(m[1] || m[2], 10) : null;
    },
    product: t => {
      const m = t.match(/「([^」]{2,12})」/) || t.match(/买(?:入)?\s*([\u4e00-\u9fa5]{2,10})(?:基金|产品|理财)/);
      return m ? m[1] : null;
    },
    subName: t => (t.match(/取消\s*(?:订阅)?\s*([\u4e00-\u9fa5]{2,8})/) || [null])[0],
    aim: t => {
      // 「为 X 攒钱 / 为 X 存钱」——X 截到「攒/存」之前，且不允许吞掉后面紧跟的「钱」字
      const m = t.match(/为\s*([\u4e00-\u9fa5]{2,10}?)\s*(?=攒|存)/);
      return m ? m[1] : null;
    },
    budgetCat: t => {
      const m = t.match(/(餐饮|交通|购物|娱乐|居住|数码|医疗|学习)/);
      return m ? m[1] : null;
    },
  };

  function detect(text) {
    // 转账类意图优先判定：出现「转 X 给某人 / 给某人转 X」句式即视为转账
    if (/(给|向|转给|打给)\s*[\u4e00-\u9fa5]{2,4}.{0,6}(转|汇|付|打)\s*\d/.test(text)
        || /(给|向|转给|打给)\s*[\u4e00-\u9fa5]{2,4}.{0,4}\d+(?:\.\d+)?\s*(块|元|万|千|k)/i.test(text)
        || /转\s*\d+(?:\.\d+)?\s*(块|元|万|千)?\s*(给|到)/.test(text)
        || /(转|汇|付|打)\s*\d+(?:\.\d+)?\s*(块|元)?\s*给/.test(text)) return 'transfer';
    for (const [intent, words] of Object.entries(ALIAS)) {
      if (words.some(w => text.includes(w))) return intent;
    }
    return null;
  }

  function parse(raw, ctx) {
    const text = raw.trim();
    const intent = detect(text);
    if (!intent) {
      return { ok: false, reason: 'UNKNOWN_INTENT', intent: null, slots: {}, missing: [],
        hint: '未能识别业务意图。我只会执行转账、账单、预算、储蓄计划、理财、卡片、订阅、跨场景联动这几类操作。' };
    }

    const slots = {};
    const missing = [];

    if (intent === 'transfer') {
      slots.payee = EXT.payee(text);
      slots.amount = EXT.amount(text);
      slots.cycle = EXT.cycle(text);
      slots.day = EXT.day(text);
      // 歧义：一句话里出现两个「给 X」，且都不是修饰词
      const pairs = [...text.matchAll(/给\s*([\u4e00-\u9fa5]{2,5}?)(?=[和与、]|[转汇付款打]|\s|\d|$)/g)];
      const names = [...new Set(pairs.map(p => p[1]).filter(n => !/^(我|你|他|她|自己)$/.test(n)))];
      // 兜底：显式的「A 和 B」「A 与 B」「A、B」并列结构
      const pair = text.match(/([\u4e00-\u9fa5]{2,4})[和与、]([\u4e00-\u9fa5]{2,4})(?=[转汇付款打])/);
      if (pair) { names.push(pair[1], pair[2]); }
      const valid = [...new Set(names)].filter(n => n.length >= 2);
      if (valid.length > 1) {
        return { ok: false, reason: 'AMBIGUOUS_PAYEE', intent, slots, hint: `你提到了「${valid.join('」「')}」多个收款对象，请明确转给其中一位。` };
      }
      if (!slots.payee) missing.push('收款人');
      if (!slots.amount) missing.push('金额');
      if (slots.amount && slots.amount > 1e6) {
        return { ok: false, reason: 'AMOUNT_OUT_OF_RANGE', intent, slots, hint: '单笔金额超过 100 万元上限，请至柜台办理。' };
      }
    }
    if (intent === 'redeem' || intent === 'wealth') { slots.product = EXT.product(text); slots.amount = EXT.amount(text); }
    if (intent === 'card') {
      if (/挂失/.test(text)) slots.cardOp = 'lost';
      else if (/冻结/.test(text)) slots.cardOp = 'freeze';
      else if (/解冻|解锁/.test(text)) slots.cardOp = 'unfreeze';
      else if (/额度|限额/.test(text)) { slots.cardOp = 'limit'; slots.amount = EXT.amount(text); }
      else if (/办卡|申卡|申请.*卡|开.*卡/.test(text)) slots.cardOp = 'apply';
      else slots.cardOp = 'list';
    }
    if (intent === 'sub') {
      slots.subOp = /取消|关闭/.test(text) ? 'cancel' : 'list';
      slots.subName = EXT.subName(text);
    }
    if (intent === 'goal') {
      // 意图编码：只有出现明确动词时才进入写操作，否则一律按「查看计划」处理。
      // 理财里「取出」与储蓄的「存钱」是反方向，不能靠猜。
      slots.planOp = /取出|取出全部|提前支取|解约/.test(text) ? 'withdraw'
        : /(每月|每个月|月月|每周).{0,6}(攒|存|转入)/.test(text) ? 'create'
        : /存|攒/.test(text) && /\d/.test(text) ? 'create'
        : 'list';
      slots.aim = EXT.aim(text);
      slots.cycle = EXT.cycle(text);
      if (slots.planOp === 'create') {
        slots.amount = EXT.amount(text);
        // 「每月 800 元」只说金额不说目标，是真实用户最常见的半句话。
        // 这类缺口不能丢一个 undefined 给上层，必须明确告诉用户还缺什么。
        if (!slots.amount) missing.push('每期金额（例如「每月 800 元」）');
        if (!slots.aim) missing.push('储蓄目标（例如「为换新笔记本攒钱」）');
      }
      if (slots.planOp === 'withdraw') slots.amount = EXT.amount(text);
    }
    if (intent === 'budget') {
      // 「预算 餐饮 2000」「看看我的预算」「这月是不是超支了」
      const num = text.match(/(\d+(?:\.\d+)?)\s*(?:块|元)?/);
      slots.budgetOp = num ? 'set' : 'list';
      slots.cat = EXT.budgetCat(text) || '餐饮';
      if (num) slots.amount = parseFloat(num[1]);
    }

    return { ok: true, intent, slots, missing, ctx };
  }
  return { parse, detect };
})();

/* ============================================================
 * L3 · 权限分级引擎（ABAC：主体 × 资源 × 操作 × 环境）
 * ============================================================ */
const PolicyEngine = (() => {
  // 场景等级：R0 只读 / R1 低危写 / R2 资金变动（需二次认证）/ R3 高额或不可逆（强认证 + 人工复核）
  const SCENE_LEVEL = {
    bill:'R0', subList:'R0', cardList:'R0', wealthView:'R0', scene:'R0',
    budgetList:'R0', budgetSet:'R1', goalList:'R0',
    subCancel:'R1', cardLimit:'R1', unfreeze:'R1', freeze:'R1',
    transfer:'R2', schedule:'R2', redeem:'R2', buy:'R2',
    goalCreate:'R2', goalWithdraw:'R2',
    cardLost:'R3', cardApply:'R3',
  };
  // 角色能力矩阵
  const ROLE_CAPS = {
    owner:   { level: 3, maxAmount: 200000 },
    family:  { level: 2, maxAmount: 5000 },
    readonly:{ level: 0, maxAmount: 0 },
  };
  const LV = { R0:0, R1:1, R2:2, R3:3 };

  function evaluate(subject, action, ctx) {
    const level = SCENE_LEVEL[action.scene] || 'R2';
    const cap = ROLE_CAPS[subject.role] || ROLE_CAPS.readonly;
    const reasons = [];

    // 1. 场景等级 vs 角色天花板
    if (LV[level] > cap.level) {
      return { decision:'deny', level, code:'POL-ROLE-CEILING',
        reason:`角色「${ROLE_CN[subject.role]}」最高可执行 R${cap.level} 级操作，本次为 ${level} 级，超出授权边界。` };
    }
    // 2. 单笔金额上限
    if ((action.amount || 0) > cap.maxAmount) {
      return { decision:'deny', level, code:'POL-AMOUNT-CEILING',
        reason:`单笔 ${(action.amount).toLocaleString('zh-CN')} 元超出角色「${ROLE_CN[subject.role]}」的 ${cap.maxAmount.toLocaleString('zh-CN')} 元授权额度。` };
    }
    // 3. 会话熔断
    if (ctx.sessionRevoked) {
      return { decision:'deny', level, code:'POL-SESSION-REVOKED', reason:'会话已被主动熔断，需重新认证。' };
    }
    // 4. 日累计限额
    if (ctx.dayTransferred + (action.amount || 0) > 50000) {
      reasons.push({ code:'POL-DAILY-AGG', text:`今日累计转出将达 ${(ctx.dayTransferred + action.amount).toLocaleString('zh-CN')} 元，超过 5 万元日限额` });
    }
    // 5. R2 及以上必须二次认证，不可直接放行
    if (LV[level] >= 2) {
      reasons.push({ code:'POL-STEPUP', text:`${level} 级资金操作，需二次认证` });
      return { decision:'stepup', level, code: LV[level] === 3 ? 'POL-STEPUP-R3' : 'POL-STEPUP-R2', reasons,
        reason: reasons.map(r => r.text).join('；') };
    }
    return { decision:'allow', level, code:'POL-PASS', reasons, reason:'权限校验通过' };
  }
  const ROLE_CN = { owner:'户主', family:'家庭成员', readonly:'只读访客' };
  return { evaluate, SCENE_LEVEL, ROLE_CAPS };
})();

/* ============================================================
 * L4 · 幻觉防护（Grounding：所有事实性数字必须可溯源到台账）
 * ============================================================ */
const GroundingGuard = (() => {
  /**
   * 生成式回复中的每个数字，必须能在「证据集」中找到来源。
   * 任一数字溯源失败 -> 降级为模板化回答 + 标注 uncertainty，绝不编造。
   */
  function numbersIn(s) {
    // 先去掉千分位逗号（如 12,000 → 12000），避免一个数字被拆成两个
    const clean = String(s).replace(/(\d),(?=\d)/g, '$1');
    return (clean.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  }
  function verify(text, evidence, tol = 0.01) {
    const claims = numbersIn(text);
    const pool = evidence.map(Number);
    const unsupported = [];
    for (const c of claims) {
      // 允许：直接命中 / 四舍五入到 0.01 / 比例换算（如百分比与整数）
      const hit = pool.some(p => Math.abs(p - c) <= tol
        || Math.abs(Math.round(p) - Math.round(c)) === 0
        || Math.abs(p - c) / Math.max(Math.abs(p), 1) < 1e-6);
      if (!hit) unsupported.push(c);
    }
    return { ok: unsupported.length === 0, unsupported, total: claims.length };
  }
  /**
   * 模板化回复：数值只能通过占位符注入，杜绝模型自由生成数字
   * tpl('本月共支出 {A} 元，其中 {B} 占比 {C}%', {A: sum, B: top, C: pct})
   */
  function fill(tpl, values) {
    const evidence = [];
    const out = tpl.replace(/\{(\w+)\}/g, (_, k) => {
      const v = values[k];
      if (v === undefined || v === null) throw new Error(`模板缺参数 ${k}`);
      evidence.push(v);
      return typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('zh-CN') : v.toFixed(2)) : v;
    });
    return { text: out, evidence };
  }
  return { verify, fill, numbersIn };
})();

/* ============================================================
 * L5 · 双智能体交叉审查
 * ============================================================ */
const CrossExaminer = (() => {
  // 风控官规则：与业务经理诉求独立，可独立否决
  function riskOfficer(action, ctx, tx) {
    const findings = [];
    const owner = ctx.beneficiary || {};
    if (action.scene === 'transfer' || action.scene === 'schedule') {
      const isNew = !tx.contacts.some(c => c.name === action.payee);
      const h = new Date().getHours();
      const noteHit = /安全账户|公检法|保证金|解冻|刷单|退税|快递理赔|验证资金|配合调查/.test((action.note || '') + (action.payee || ''));

      if (noteHit) findings.push({ id: 'R-01', sev: 'block', t: '收款方命中涉诈话术库' });
      if (isNew && (action.amount || 0) >= 3000) findings.push({ id: 'R-02', sev: 'stepup', t: `首次向「${action.payee}」付款且金额 ${action.amount} 元` });
      if ((action.amount || 0) >= 20000) findings.push({ id: 'R-03', sev: 'stepup', t: '单笔超 2 万元大额保护' });
      if (h >= 0 && h < 6 && (action.amount || 0) >= 1000) findings.push({ id: 'R-04', sev: 'stepup', t: '凌晨时段（00:00–06:00）大额操作' });
      // 老年人深夜向新账户转出 —— 冒充公检法 / 婚恋诈骗的典型组合特征
      if (owner.isElder && isNew && (action.amount || 0) >= 2000)
        findings.push({ id: 'R-05', sev: 'block', t: '老年账户向陌生账户大额转出（高危组合特征）' });
    }
    if (action.scene === 'buy') {
      const maxRisk = { owner: 3, family: 2, readonly: 0 }[ctx.subject.role] || 1;
      if ((action.productRisk || 0) > (ctx.riskLevel || 1))
        findings.push({ id: 'R-06', sev: 'block', t: `产品风险 R${action.productRisk} 高于你的风险测评等级 C${ctx.riskLevel}（适当性管理要求）` });
    }
    if (action.scene === 'redeem' && ctx.holdingDays < 7)
      findings.push({ id: 'R-07', sev: 'warn', t: '持有不足 7 天，赎回将收取 1.5% 惩罚性费用' });

    // 储蓄计划的「提前支取」等价于赎回，同样按持有天数计费；
    // 但扣款方从基金公司变成银行自己，费率写进产品协议而不是隐含。
    if (action.scene === 'goalWithdraw' && (ctx.goalHoldDays ?? 99) < 90)
      findings.push({ id: 'R-08', sev: 'warn', t: '储蓄计划持有不足 90 天，提前支取将按 0.3% 收取违约金' });

    // 预算上调本身不是资金操作，但一月内连续三次以上上调，
    // 本质是「用放宽规则来掩盖超支」，风控官要提出来。
    if (action.scene === 'budgetSet' && (ctx.budgetRaiseCount || 0) >= 2)
      findings.push({ id: 'R-09', sev: 'warn', t: '本月已两次上调预算，建议先看支出结构再调整额度' });

    return {
      role: '风控官',
      verdict: findings.some(f => f.sev === 'block') ? 'VETO' : findings.length ? 'CONDITIONAL' : 'PASS',
      findings,
    };
  }
  // 业务经理：负责业务诉求与体验，不得覆盖风控结论
  function businessManager(action, ctx) {
    const notes = [];
    if (ctx.lowBalance) notes.push('本次操作后余额低于 1000 元，建议保留应急资金');
    if (action.scene === 'transfer' && action.amount > 50000) notes.push('大额转账，建议柜台或视频柜员复核');
    return { role: '业务经理', verdict: notes.length ? 'NOTE' : 'PASS', findings: notes };
  }
  function cross(action, ctx, tx) {
    const r = riskOfficer(action, ctx, tx);
    const b = businessManager(action, ctx);
    // 合议：风控官一票否决，业务经理仅可附注
    const verdict = r.verdict === 'VETO' ? 'VETO'
      : r.verdict === 'CONDITIONAL' ? 'CONDITIONAL'
      : b.verdict === 'NOTE' ? 'NOTE' : 'PASS';
    return { verdict, risk: r, biz: b, ts: Date.now() };
  }
  return { cross, riskOfficer, businessManager };
})();

/* ============================================================
 * 审计日志（不可变追加 + 哈希链）
 * ============================================================ */
const AuditLog = (() => {
  let prev = 'GENESIS';
  const chain = [];
  // 轻量哈希（演示用：djb2 + 长度混淆；生产应替换为 SHA-256）
  function h(s) {
    let x = 5381;
    for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0;
    return x.toString(16).padStart(8, '0');
  }
  function append(evt) {
    const rec = { seq: chain.length + 1, ts: Date.now(), prev, ...evt };
    rec.hash = h(JSON.stringify({ ...rec, hash: undefined }));
    prev = rec.hash;
    chain.push(rec);
    return rec;
  }
  function verifyChain() {
    let p = 'GENESIS';
    for (const r of chain) {
      const expect = h(JSON.stringify({ ...r, hash: undefined }));
      if (r.prev !== p || r.hash !== expect) return { ok: false, seq: r.seq };
      p = r.hash;
    }
    return { ok: true, count: chain.length };
  }
  return { append, verifyChain, get chain() { return chain; } };
})();

/* ============================================================
 * 编排器：把五层串成一条可审计管线
 * ============================================================ */
function runPipeline(rawInput, ctx, tx) {
  const trace = { input: rawInput, layers: [], ts: Date.now() };

  // L1
  const g = InjectionGuard.inspect(rawInput);
  trace.layers.push({ layer: 'L1 注入防御', verdict: g.verdict, detail: g.hits });
  AuditLog.append({ type: 'L1', verdict: g.verdict, hits: g.hits.map(h => h.id) });
  if (g.verdict === 'block') {
    trace.final = { decision: 'DENY', at: 'L1' };
    return trace;
  }

  // L2
  const p = IntentParser.parse(g.clean, ctx);
  trace.layers.push({ layer: 'L2 意图解析', verdict: p.ok ? 'pass' : 'block', detail: p.ok ? { intent: p.intent, slots: p.slots } : { reason: p.reason, hint: p.hint } });
  AuditLog.append({ type: 'L2', verdict: p.ok ? 'pass' : 'block', reason: p.reason });
  if (!p.ok) { trace.final = { decision: 'CLARIFY', at: 'L2', reason: p.reason }; return trace; }

  // 槽位完整性校验：缺关键槽位必须在 L2 拦下，不得进入执行链路
  if (p.missing && p.missing.length) {
    trace.layers.push({ layer: 'L2 意图解析', verdict: 'clarify',
      detail: { intent: p.intent, slots: p.slots, reason: 'MISSING_SLOT', hint: `还需要你补充：${p.missing.join('、')}。` } });
    AuditLog.append({ type: 'L2', verdict: 'clarify', reason: 'MISSING_SLOT', missing: p.missing });
    trace.final = { decision: 'CLARIFY', at: 'L2', reason: 'MISSING_SLOT' };
    return trace;
  }

  // 构造动作（场景编码与 PolicyEngine.SCENE_LEVEL 的键保持一致）
  const CARD_SCENE = { lost:'cardLost', freeze:'freeze', unfreeze:'unfreeze', limit:'cardLimit', apply:'cardApply', list:'cardList' };
  const scene = p.intent === 'transfer' ? (p.slots.cycle ? 'schedule' : 'transfer')
    : p.intent === 'wealth' ? (p.slots.amount ? 'buy' : 'wealthView')
    : p.intent === 'card' ? CARD_SCENE[p.slots.cardOp || 'list']
    : p.intent === 'sub' ? (p.slots.subOp === 'cancel' ? 'subCancel' : 'subList')
    : p.intent === 'goal' ? (p.slots.planOp === 'list' ? 'goalList' : p.slots.planOp === 'withdraw' ? 'goalWithdraw' : 'goalCreate')
    : p.intent === 'budget' ? (p.slots.budgetOp === 'set' ? 'budgetSet' : 'budgetList')
    : p.intent;
  // 备注：句子里「备注/用途/说明：」之后的内容，或「安全账户」等话术片段
  const noteMatch = g.clean.match(/(?:备注|用途|说明|理由)\s*[:：]?\s*([^\n，。]{0,24})/);
  const action = { scene, note: noteMatch ? noteMatch[1].trim() : '', ...p.slots };

  // L3
    const policy = PolicyEngine.evaluate(ctx.subject, action, ctx);
    trace.layers.push({ layer: 'L3 权限分级', verdict: policy.decision, detail: policy });
    AuditLog.append({ type: 'L3', verdict: policy.decision, code: policy.code, level: policy.level });
  if (policy.decision === 'deny') { trace.final = { decision: 'DENY', at: 'L3', reason: policy.reason }; return trace; }

  // L5（资金类才需交叉审查）
  if (['transfer', 'schedule', 'buy', 'redeem', 'cardLost', 'goalCreate', 'goalWithdraw', 'budgetSet'].includes(scene)) {
    // R-07 需要持仓时长：取台账第一笔持仓（与赎回执行器取同一笔）计算持有天数
    const holdingDays = tx.holdings && tx.holdings[0] ? (Date.now() - tx.holdings[0].boughtAt) / 864e5 : 99;
    // R-08 同理，取第一个储蓄计划
    const plan = tx.goals && tx.goals[0];
    const goalHoldDays = plan ? (Date.now() - plan.openedAt) / 864e5 : 99;
    const cx = CrossExaminer.cross(action, { ...ctx, holdingDays, goalHoldDays }, tx);
    trace.layers.push({ layer: 'L5 双智能体审查', verdict: cx.verdict, detail: cx });
    AuditLog.append({ type: 'L5', verdict: cx.verdict, findings: cx.risk.findings.map(f => f.id) });
    trace.cross = cx;
    if (cx.verdict === 'VETO') { trace.final = { decision: 'DENY', at: 'L5', reason: cx.risk.findings.find(f => f.sev === 'block').t }; return trace; }
    if (cx.verdict === 'CONDITIONAL' && policy.decision === 'allow') { trace.final = { decision: 'STEPUP', at: 'L5' }; return trace; }
  }

  trace.final = { decision: policy.decision === 'stepup' ? 'STEPUP' : 'ALLOW', at: 'ok' };
  return trace;
}

/* 浏览器挂到 window，Node 走 module.exports（便于跑单测） */
const __ENGINE__ = { InjectionGuard, IntentParser, PolicyEngine, GroundingGuard, CrossExaminer, AuditLog, runPipeline };
if (typeof window !== 'undefined') Object.assign(window, __ENGINE__);
if (typeof module !== 'undefined' && module.exports) module.exports = __ENGINE__;
// Node 测试环境：直接挂到 global，便于 testcases.js 免 import 使用
if (typeof global !== 'undefined' && typeof window === 'undefined') Object.assign(global, __ENGINE__);
