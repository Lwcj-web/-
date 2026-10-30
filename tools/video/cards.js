/**
 * 大字卡渲染：把片头 / 片尾 / 数字卡的文字直接画进画面。
 *
 * 为什么不用 ASS：ffmpeg 4.1 的 libass 在浅色底上会把白色主色混成近透明
 * （见 build.js 里的说明），所以字幕走独立 mov_text 轨；而片头片尾这种
 * 「文字就是画面」的卡，改用 drawtext 直接烧，和字幕互不干扰。
 *
 * 为什么在 JS 里算 alpha 而不是用 enable='between()'：
 *   所有文字在 t=0 就全部提交，靠每个字自己的 alpha 表达式控制出现与消失，
 *   整段只需一条 -vf，不必拼接 n 段 enable 区间。
 */
const W = 1920, H = 1080;
const FONT = process.env.FG_FONT || 'C\\:/Windows/Fonts/msyh.ttc';
const FONT_B = process.env.FG_FONT_BOLD || 'C\\:/Windows/Fonts/msyhbd.ttc';
const FONT_M = process.env.FG_FONT_MONO || 'C\\:/Windows/Fonts/consola.ttf';

/** drawtext 的 text 里这几个字符必须转义，否则滤镜图直接被解析坏 */
const q = s => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/'/g, '\u2019')
  .replace(/:/g, '\\:')
  .replace(/%/g, '\\%')
  .replace(/,/g, '\\,')
  .replace(/\[/g, '\\[')
  .replace(/\]/g, '\\]');

/** 从 t0 淡入到 1，之后一直保持 1 */
const fadeIn = (t0, d = 0.45) =>
  `if(lt(t,${t0.toFixed(2)}),0,if(lt(t,${(t0 + d).toFixed(2)}),(t-${t0.toFixed(2)})/${d},1))`;

/**
 * 在 [s,e) 内可见：淡入 0.3s → 停留 → 最后 0.2s 淡出 → 之后为 0。
 * 关键点是「之后为 0」。若只写淡入，alpha 会一直停在 1，
 * 三个数字会同时留在画面上叠成一团（实测过）。
 */
const win = (s, e) =>
  `if(lt(t,${s.toFixed(2)}),0,` +
  `if(lt(t,${(s + 0.30).toFixed(2)}),(t-${s.toFixed(2)})/0.30,` +
  `if(lt(t,${(e - 0.20).toFixed(2)}),1,` +
  `if(lt(t,${e.toFixed(2)}),(${e.toFixed(2)}-t)/0.20,0))))`;

/** 一张 drawtext */
const txt = ({ text, font = FONT, size, x, y, color = '0xf8fafc', alpha }) =>
  `drawtext=fontfile='${font}':text='${q(text)}':fontsize=${size}:fontcolor=${color}` +
  `:x=${x}:y=${y}:alpha='${alpha}'`;

/** 中文按「字宽≈字号」估宽，用于居中；英文数字按 0.56 估 */
const width = (s, size) =>
  [...s].reduce((w, c) => w + (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(c) ? size : size * 0.56), 0);
const center = (s, size) => Math.round((W - width(s, size)) / 2);

/* ---------------- 片头 ---------------- */
function titleCard(c) {
  const D = c.dur;
  const titles = c.shot.title || [];
  const size = 92;
  const yBase = 250;
  const out = [];

  titles.forEach((t, i) => {
    const t0 = 0.5 + i * 0.75;
    out.push(txt({
      text: t, font: FONT_B, size, x: center(t, size),
      y: yBase + i * (size + 52), alpha: fadeIn(t0),
    }));
  });

  if (c.shot.sub) {
    const s = 34;
    const t0 = 0.5 + titles.length * 0.75 + 0.2;
    out.push(txt({
      text: c.shot.sub, size: s, x: center(c.shot.sub, s),
      y: yBase + titles.length * (size + 52) + 56,
      color: '0x94a3b8', alpha: `0.92*${fadeIn(t0, 0.5)}`,
    }));
  }

  // 左下角一条细线 + 品牌字，压住空荡的下半屏
  out.push(txt({
    text: 'FinGuard · 五道闸门 · 全程可审计', size: 22, x: 168, y: 916,
    color: '0x64748b', alpha: fadeIn(0.9),
  }));
  out.push(`drawbox=x=168:y=948:w=340:h=2:color=0x1e293b:t=fill:enable='gte(t,0.4)'`);
  out.push(txt({ text: '●', size: 15, x: 168, y: 972, color: '0x10b981', alpha: fadeIn(0.8) }));

  out.push(`fade=t=out:st=${(D - 0.55).toFixed(2)}:d=0.55`);
  return out.join(',');
}

/* ---------------- 片尾 ----------------
 * 和片头一样是两行字，但结构不同：第一行是别人，第二行是我们。
 * 所以第一行压暗（0x94a3b8 灰），第二行用品牌绿 + 更大字号——
 * 观众看到第一行以为要收尾了，第二行才是真正的钉子。
 */
function endCard(c) {
  const D = c.dur;
  const titles = c.shot.title || [];
  const size = 62;
  const out = [];
  const y0 = 340;

  // 上面一行：细横线，把两行字包成一个 quote block
  out.push(`drawbox=x=${W / 2 - 60}:y=290:w=120:h=3:color=0x10b981:t=fill:enable='gte(t,0.3)'`);

  titles.forEach((t, i) => {
    const t0 = 0.6 + i * 0.85;
    const first = i === 0;
    const s = first ? size : size + 14;
    out.push(txt({
      text: t, font: first ? FONT : FONT_B, size: s, x: center(t, s),
      y: y0 + i * (size + 78),
      color: first ? '0x94a3b8' : '0x10b981',
      alpha: fadeIn(t0, 0.5),
    }));
  });

  if (c.shot.sub) {
    const s = 24;
    out.push(txt({
      text: c.shot.sub, size: s, x: center(c.shot.sub, s),
      y: y0 + titles.length * (size + 78) + 40,
      color: '0x475569', alpha: fadeIn(1.9, 0.5),
    }));
  }

  out.push(`fade=t=out:st=${(D - 0.9).toFixed(2)}:d=0.9`);
  return out.join(',');
}

/* ---------------- 数字卡 ----------------
 * 真人配音版里，三个数字的出现时机由旁白决定（都念在第一句里），
 * 时间轴通过 markWindows 传进来；没有就用老的平均切法兜底。
 */
function statsCard(c) {
  const D = c.dur;
  const marks = c.shot.marks || [];
  const NS = 190, CS = 36;   // 数字 / 注释字号
  const out = [];

  let wins;
  if (Array.isArray(c.markWindows) && c.markWindows.length === marks.length) {
    // 绝对时间 → 相对本镜
    wins = c.markWindows.map((w) => ({ s: w.s - c.start, e: w.e - c.start }));
  } else {
    const cuts = marks.length === 3
      ? [0, D * 0.34, D * 0.52, D - 0.08]
      : marks.map((_, i) => (D * i) / Math.max(marks.length, 1)).concat(D - 0.08);
    wins = marks.map((_, i) => ({ s: cuts[i] + 0.10, e: cuts[i + 1] }));
  }

  marks.forEach((m, i) => {
    const { s, e } = wins[i];
    out.push(txt({ text: m.n, font: FONT_B, size: NS, x: center(m.n, NS), y: 372, alpha: win(s, e) }));
    out.push(txt({ text: m.cap, size: CS, color: '0x94a3b8', x: center(m.cap, CS), y: 634, alpha: win(s + 0.12, e) }));
  });

  // 收尾金句：第三个数字演完，把它压成大字号留在画面上，收住整支片
  if (c.quoteWindow) {
    const qs = c.quoteWindow.s - c.start;
    const qe = c.quoteWindow.e - c.start;
    const size = 56;
    out.push(txt({
      text: c.quoteWindow.text, font: FONT_B, size,
      x: center(c.quoteWindow.text, size), y: 810,
      color: '0xe2e8f0', alpha: win(Math.max(0, qs), qe),
    }));
  }
  return out.join(',');
}

/** 三类卡片的完整 filter 链（深底噪点 → 文字） */
function cardFilter(c) {
  const bg = 'noise=alls=5:allf=t+u';
  const body =
    c.kind === 'cover' ? titleCard(c) :
    c.kind === 'end' ? endCard(c) :
    statsCard(c);
  return `${bg},format=yuv420p,${body}`;
}

module.exports = { cardFilter, FONT, FONT_B, FONT_M, W, H };
