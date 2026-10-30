/**
 * 时间轴（真人配音版）
 * ------------------------------------------------------------
 * 与 cue.js 的区别：cue.js 按 TTS 逐句 wav 拼时间轴；这里是「一条完整录音
 * + 逐句起点」，配音是用户自己念的整段音频，不再拆成一句一个文件。
 *
 * 输入
 *   media/vo/narration.m4a   用户录制的整段配音
 *   media/vo/align.json      每句台本在音频里的起止（由对齐工具产出）
 * 输出
 *   media/vo/timeline.json   与 cue.js 同构，多了 audio 字段
 *   media/FinGuard-演示视频.srt
 *
 *   node tools/video/cue-real.js
 */
const fs = require('fs');
const path = require('path');
const { SHOTS } = require('./script');

const ROOT = path.resolve(__dirname, '..', '..');
const VO = path.join(ROOT, 'media', 'vo');
const LEAD = 3.0;        // 片头留白：录音第 0 秒就在说话，先给封面留三秒
const CUT_AHEAD = 0.25;  // 换镜提前量：切在句子开口前，观感才跟得上
const MAXCHARS = 26;     // 单条字幕上限

const align = JSON.parse(fs.readFileSync(path.join(VO, 'align.json'), 'utf8'));
const AUDIO = path.join(VO, 'narration.m4a');

/** 超长句只在句中标点处拆，拆出来的每一行仍是完整的一句话 */
function wrap(text) {
  if (text.length <= MAXCHARS) return [text];
  const parts = text.match(/[^，、：；]+[，、：；]?/g) || [text];
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > MAXCHARS && buf) { out.push(buf); buf = p; }
    else buf += p;
  }
  if (buf) out.push(buf);
  return out;
}

/* ---------- 1. 按镜头归拢台本行 ---------- */
const byShot = {};
align.lines.forEach((l) => {
  (byShot[l.shot] = byShot[l.shot] || []).push(l);
});

/* ---------- 2. 镜头边界 ---------- */
const shots = [];
let prevStart = -Infinity;
for (const s of SHOTS) {
  const ls = byShot[s.id] || [];
  let start;
  if (!ls.length) start = 0;                         // 片头从 0 开始
  else start = ls[0].t0 + LEAD - CUT_AHEAD;
  start = Math.max(start, prevStart + 2.4);          // 任何镜头不短于 2.4 秒
  shots.push({ id: s.id, kind: s.kind, def: s, start: +start.toFixed(3), lines: ls });
  prevStart = start;
}

/* ---------- 3. 片尾从收声后起 ---------- */
const lastLine = align.lines[align.lines.length - 1];
const endCard = shots.find((s) => s.kind === 'end');
endCard.start = +(lastLine.t1 + LEAD + 0.55).toFixed(3);
endCard.dur = 4.8;

/* ---------- 4. 镜头时长 ---------- */
shots.forEach((s, i) => {
  if (s.kind === 'end') return;
  const next = shots[i + 1];
  s.dur = +(next.start - s.start).toFixed(3);
});

/* ---------- 5. 字幕行 ---------- */
const flat = [];
shots.forEach((s) => {
  // 先留一份「台本句」原样，字幕会被拆成多行，之后算数字卡要靠它
  s.raw = s.lines.slice();
  const out = [];
  s.lines.forEach((l) => {
    const rows = wrap(l.text);
    const w = rows.map((r) => r.replace(/[，。、：；？！\s]/g, '').length);
    const sum = w.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    rows.forEach((r, k) => {
      const a = l.t0 + (l.t1 - l.t0) * (acc / sum);
      acc += w[k];
      const b = l.t0 + (l.t1 - l.t0) * (acc / sum);
      out.push({ text: r, at: +(a + LEAD).toFixed(2), end: +(b + LEAD).toFixed(2) });
    });
  });
  // 相邻条目不留重叠，也不留 0 长度
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (next) out[i].end = +Math.min(out[i].end, next.at - 0.06).toFixed(2);
    if (out[i].end - out[i].at < 0.4) out[i].end = +(out[i].at + 0.4).toFixed(2);
    flat.push(out[i]);
  }
  s.lines = out;
});

/* ---------- 6. 数字卡的三个数字跟着旁白走 ---------- */
const statShot = shots.find((s) => s.kind === 'stats');
if (statShot && statShot.raw.length) {
  // 三个数字都念在第一句里（"121 条断言，11 个缺陷，零依赖"），
  // 按这一句的起止三等分，比按整镜时长平分准得多。
  // 注意取 raw（台本句）而不是 lines（字幕行）——长句会被拆成两行。
  const a = statShot.raw[0].t0 + LEAD;
  const b = statShot.raw[0].t1 + LEAD;
  const step = (b - a) / 3;
  const shotEnd = +(statShot.start + statShot.dur).toFixed(2);
  statShot.def.markWindows = [0, 1, 2].map((i) => ({
    s: +(a + step * i).toFixed(2),
    e: i === 2 ? shotEnd : +(a + step * (i + 1)).toFixed(2),
  }));
  // 收尾那句金句压成大字号留在画面上
  const last = statShot.raw[statShot.raw.length - 1];
  statShot.def.quoteWindow = {
    s: +(last.t0 + LEAD).toFixed(2),
    e: shotEnd,
    text: last.text,
  };
}

/* ---------- 7. 写文件 ---------- */
const total = +(endCard.start + endCard.dur).toFixed(2);
const timeline = {
  total,
  audio: { file: path.relative(ROOT, AUDIO).replace(/\\/g, '/'), offset: LEAD },
  lead: LEAD,
  shots: shots.map((s) => ({
    id: s.id, kind: s.kind, start: s.start, dur: s.dur,
    ...(s.def.markWindows ? { markWindows: s.def.markWindows } : {}),
    ...(s.def.quoteWindow ? { quoteWindow: s.def.quoteWindow } : {}),
    lines: s.lines.map((l) => ({ text: l.text, at: l.at, end: l.end })),
  })),
};
fs.writeFileSync(path.join(VO, 'timeline.json'), JSON.stringify(timeline, null, 1), 'utf8');

const ts = (s) => new Date(Math.round(s * 1000)).toISOString().substr(11, 12).replace('.', ',');
const srt = flat.map((l, i) => `${i + 1}\n${ts(l.at)} --> ${ts(l.end)}\n${l.text}\n`).join('\n');
fs.writeFileSync(path.join(ROOT, 'media', 'FinGuard-演示视频.srt'), srt, 'utf8');

console.log(`镜头 ${shots.length} 个 · 字幕 ${flat.length} 条 · 总时长 ${total.toFixed(1)}s ` +
  `(${Math.floor(total / 60)} 分 ${Math.round(total % 60)} 秒)`);
shots.forEach((s) => {
  console.log(`  ${s.id.padEnd(4)}${s.start.toFixed(1).padStart(7)}s  ${s.dur.toFixed(1).padStart(5)}s  ` +
    (s.lines[0] ? s.lines[0].text.slice(0, 26) : ''));
});
