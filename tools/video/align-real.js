/**
 * 把台本句子对到录音上（Word 级单调对齐）
 * ------------------------------------------------------------
 *   node tools/video/transcribe.py 的产物 media/vo/asr.json
 *        ↓  本脚本
 *   media/vo/align.json  每句台本的起止时间
 *        ↓
 *   node tools/video/cue-real.js   算镜头边界与字幕
 *
 * 做法：把转写摊成「字符序列」，每个字符带起止时间；再把 34 句台本切到这条
 * 序列上——每句对应一段连续字符，不允许交叉、不允许回头。
 * 代价 = 字符重合度不足 + 长度偏离，跑一次单调 DL。
 *
 * 为什么单调约束是必须的：whisper 会把「竖线」写成「纯线」、「台账」写成
 * 「台帐」，单看某一处匹配不上；但只要允许回头，DP 就会在局部贪心地错位。
 * 加上单调约束之后，跳过一个字意味着整体位移，代价远大于认错这一个字，
 * 于是全局最优自然落在正确位置。
 *
 *   node tools/video/align-real.js
 */
const fs = require('fs');
const path = require('path');
const { SHOTS } = require('./script');

const ROOT = path.resolve(__dirname, '..', '..');
const VO = path.join(ROOT, 'media', 'vo');

const asr = JSON.parse(fs.readFileSync(path.join(VO, 'asr.json'), 'utf8'));

/* ---------- 1. 词 → 字符序列（每个字符带时间） ---------- */
const PUNCT = /[\s，。、：；？！,.:;?!·—…「」『』（）()《》\-]/;
const chars = [];
for (const w of asr.words) {
  const cs = [...w.w].filter((c) => !PUNCT.test(c));
  if (!cs.length) continue;
  const step = (w.end - w.start) / cs.length;
  cs.forEach((c, i) => {
    chars.push({ c, s: w.start + step * i, e: w.start + step * (i + 1) });
  });
}
const CS = chars.map((x) => x.c).join('');
const norm = (s) => [...s].filter((c) => !PUNCT.test(c));
console.log(`转写 ${CS.length} 字，覆盖 ${chars[0].s.toFixed(2)}–${chars[chars.length - 1].e.toFixed(2)}s`);

/* ---------- 2. 台本 ---------- */
const LINES = [];
SHOTS.forEach((s) => { if (s.lines) s.lines.forEach((t) => LINES.push({ shot: s.id, text: t, cs: norm(t) })); });
const M = LINES.length;
const N = CS.length;

/* ---------- 3. 字符多重集重合度 ---------- */
function sim(a, b) {
  const cnt = new Map();
  for (const c of a) cnt.set(c, (cnt.get(c) || 0) + 1);
  let hit = 0;
  for (const c of b) {
    const n = cnt.get(c) || 0;
    if (n > 0) { hit++; cnt.set(c, n - 1); }
  }
  return hit / Math.max(a.length, b.length);
}

/* ---------- 4. 单调 DP ---------- */
const INF = Infinity;
const dp = Array.from({ length: M + 1 }, () => new Float64Array(N + 1).fill(INF));
const from = Array.from({ length: M + 1 }, () => new Int32Array(N + 1).fill(-1));
dp[0][0] = 0;

for (let k = 1; k <= M; k++) {
  const len = LINES[k - 1].cs.length;
  const lo = Math.max(4, Math.round(len * 0.45));
  const hi = Math.round(len * 2.0) + 6;
  // 后面每一句至少要留多少字
  const need = LINES.slice(k).reduce((a, x) => a + Math.max(3, Math.round(x.cs.length * 0.45)), 0);
  for (let i = 0; i <= N; i++) {
    if (dp[k - 1][i] === INF) continue;
    for (let j = i + lo; j <= Math.min(N, i + hi); j++) {
      if (N - j < need) break;
      const seg = CS.slice(i, j);
      const cost = dp[k - 1][i] + (1 - sim(LINES[k - 1].cs, seg)) * 6
        + (Math.abs(seg.length - len) / len) * 1.4;
      if (cost < dp[k][j]) { dp[k][j] = cost; from[k][j] = i; }
    }
  }
}

if (dp[M][N] === INF) { console.error('无可行解：转写字数与台本差距过大，先确认录音是否照稿念'); process.exit(1); }

/* ---------- 5. 回溯 ---------- */
let j = N;
const spans = new Array(M);
for (let k = M; k >= 1; k--) { const i = from[k][j]; spans[k - 1] = [i, j]; j = i; }

const out = [];
let warn = 0;
spans.forEach(([i, j2], k) => {
  const L = LINES[k];
  const seg = CS.slice(i, j2);
  const s = sim(L.cs, seg);
  if (s < 0.55) warn++;
  out.push({
    shot: L.shot, text: L.text,
    t0: +chars[i].s.toFixed(3), t1: +chars[j2 - 1].e.toFixed(3),
  });
  console.log(
    `${String(k + 1).padStart(2)} ${L.shot.padEnd(3)} ` +
    `${chars[i].s.toFixed(2).padStart(7)}→${chars[j2 - 1].e.toFixed(2).padStart(7)} ` +
    `相似 ${(s * 100).toFixed(0)}%${s < 0.55 ? '  ⚠' : ''}  ${L.text.slice(0, 20)}`
  );
});

fs.writeFileSync(path.join(VO, 'align.json'), JSON.stringify({
  total: asr.duration, source: 'faster-whisper', lines: out,
}, null, 1), 'utf8');

console.log(`\n${M} 句，可疑 ${warn} 句 → media/vo/align.json`);
if (warn) {
  console.log('相似度低的句子请人工核对一句；确认无误可以继续跑 cue-real.js。');
}
