/**
 * 配音台本生成：script.js → docs/配音台本.md + docs/配音台词.txt
 *
 *   node tools/video/scriptbook.js
 *
 * 为什么不复用 cue.js：cue.js 要读 37 段 wav 才能算时间轴，而台本是给
 * 「还没录音」的人看的。这里只按字数估时长（4.2 字/秒，实测 Rate=3 的语速），
 * 录完真音后跑一遍 cue.js，时间轴自然会按真实时长重算。
 */
const fs = require('fs');
const path = require('path');
const { SHOTS } = require('./script');

const ROOT = path.resolve(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const CPS = 4.2;      // 字/秒
const GAP = 0.42;     // 句间停顿

/** 中文字数：汉字 + 数字字母都算一个单位，标点不算 */
const count = s => (s.match(/[\u4e00-\u9fa5A-Za-z0-9]/g) || []).length;
const secs = s => count(s) / CPS + GAP;
const mmss = s => {
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m ? `${m} 分 ${String(r).padStart(2, '0')} 秒` : `${r} 秒`;
};

const LABEL = {
  cover: '片头大字卡',
  end: '片尾金句卡',
  stats: '数字卡（121 / 11 / 0）',
};

const rows = [];
let total = 0;
for (const s of SHOTS) {
  const lines = s.lines || [];
  const chars = lines.reduce((a, l) => a + count(l), 0);
  const dur = lines.reduce((a, l) => a + secs(l), 0) + (lines.length ? 0 : (s.dur || 0));
  total += dur;
  rows.push({ id: s.id, kind: s.kind, screen: LABEL[s.kind] || s.file, n: lines.length, chars, dur, lines });
}

/* ---------------- 台本 MD ---------------- */
const md = [];
md.push('# FinGuard 演示视频 · 配音台本');
md.push('');
md.push('> 这份台本给「自己配音」用。台词与 `tools/video/script.js` 完全同源，' +
  '改台词请改那个文件，再跑 `node tools/video/scriptbook.js` 重新生成本台本。');
md.push('');
md.push('## 怎么录');
md.push('');
md.push('**1. 按镜头分段录，一段一个文件。** 命名 `S1.wav` … `S10.wav`，放在 `media/vo/` 下。');
md.push('片头 S0 和片尾 S10 没有旁白，不用录。所以实际要录 **9 段**。');
md.push('');
md.push('**2. 每句之间停 0.3–0.5 秒。** 不要连读。这个停顿是剪辑点，停得太短我没法把句子切开对齐画面。');
md.push('每段开头也留半秒静音。');
md.push('');
md.push('**3. 念错就整段重录，不要拼接。** 拼接的地方音量和对不上，剪出来很假。');
md.push('');
md.push('**4. 语速参考 4.2 字/秒**，比平时说话略慢一点。整片旁白约 ' +
  mmss(total) + '，加上片头片尾约 ' + mmss(total + 16) + '，赛制上限 5 分钟。');
md.push('');
md.push('## 录音清单');
md.push('');
md.push('| 文件 | 画面 | 句数 | 字数 | 建议时长 |');
md.push('|---|---|---|---|---|');
for (const r of rows) {
  if (!r.n) continue;
  md.push(`| \`${r.id}.wav\` | ${r.screen} | ${r.n} | ${r.chars} | ${mmss(r.dur)} |`);
}
md.push('');
md.push('## 逐句台词');
md.push('');

for (const r of rows) {
  md.push(`### ${r.id} · ${r.screen}`);
  md.push('');
  if (!r.n) {
    md.push('（无旁白。纯画面，靠音乐和字幕卡过渡。）');
    md.push('');
    continue;
  }
  r.lines.forEach((l, i) => {
    md.push(`**${r.id}-${i + 1}**　${l}`);
    md.push(`<sub>${count(l)} 字 · 约 ${secs(l).toFixed(1)} 秒</sub>`);
    md.push('');
  });
}

md.push('---');
md.push('');
md.push('## 录完之后');
md.push('');
md.push('把 `S1.wav` … `S9.wav` 放进 `media/vo/`，告诉我「录好了」，我会做三件事：');
md.push('');
md.push('1. 用静音检测找出每句话的真实边界，和台本逐句对齐（对不上会报出来，不会硬套）');
md.push('2. 按你的实际语速重算时间轴，重排字幕');
md.push('3. 重新渲染画面并混音，出新的 `FinGuard-演示视频.mp4`');
md.push('');
md.push('画面不用重录，截图和运镜都会按新时长自动重算。');

fs.writeFileSync(path.join(DOCS, '配音台本.md'), md.join('\n') + '\n', 'utf8');

/* ---------------- 纯台词 TXT ---------------- */
const txt = [];
txt.push('FinGuard 演示视频 · 配音台词');
txt.push('================================');
txt.push('');
txt.push('按镜头分段念。每段开头留半秒静音，句间停 0.3–0.5 秒。');
txt.push('念错整段重录，不要拼接。语速比平时略慢（约 4.2 字/秒）。');
txt.push('');
for (const r of rows) {
  if (!r.n) continue;
  txt.push('');
  txt.push(`---------- ${r.id}.wav  |  ${r.screen}  |  ${r.n} 句  ----------`);
  txt.push('');
  r.lines.forEach((l, i) => {
    txt.push(`[${r.id}-${i + 1}] ${l}`);
    txt.push('');
  });
}
txt.push('');
txt.push('---------- 完 ----------');

fs.writeFileSync(path.join(DOCS, '配音台词.txt'), txt.join('\n'), 'utf8');

console.log('配音台本 → docs/配音台本.md');
console.log('纯台词   → docs/配音台词.txt');
console.log(`镜头 ${rows.length} 个，需录 ${rows.filter(r => r.n).length} 段，` +
  `旁白 ${rows.reduce((a, r) => a + r.n, 0)} 句，估时 ${mmss(total)}`);
