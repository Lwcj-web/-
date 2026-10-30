/**
 * 旁白切句与时间轴（不合成视频）
 * ------------------------------------------------------------
 * 之前一版按"音量谷底"切字幕，结果因为相邻两句的停顿也有 300ms，
 * 谷底落在句间而不是句内，字幕边界比句子边界早了半句。教训记在这里。
 *
 * 现在的规则：
 *   每句旁白 = 一条 wav = 一条字幕（超长句在标点处拆成两条，但共用一个 wav 时间轴）。
 *   时间轴以 wav 的真实时长为准，句间停顿由脚本给，不靠猜。
 *
 *   node tools/video/cue.js
 */
const fs = require('fs');
const path = require('path');
const { SHOTS } = require('./script');

const ROOT = path.resolve(__dirname, '..', '..');
const VO = path.join(ROOT, 'media', 'vo');
const GAP = 0.42;          // 句间停顿（秒）
const MAXCHARS = 26;       // 单条字幕上限，超过就在标点处再拆一行

function wavDur(file) {
  const b = fs.readFileSync(file);
  let off = 12, dataOff = 44, dataLen = b.length - 44;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  const sr = b.readUInt32LE(24), ch = b.readUInt16LE(22), bits = b.readUInt16LE(34);
  const n = Math.floor(dataLen / (bits / 8) / ch);
  const w = new Int16Array(n);
  for (let i = 0; i < n; i++) w[i] = b.readInt16LE(dataOff + i * 2);
  // 头尾静音（阈值 0.01 的 10ms 帧）
  const fl = Math.round(sr * 0.01);
  let first = -1, last = -1;
  for (let i = 0; i + fl <= n; i += fl) {
    let s = 0;
    for (let j = 0; j < fl; j++) { const x = w[i + j] / 32768; s += x * x; }
    if (Math.sqrt(s / fl) > 0.01) { if (first < 0) first = i; last = i; }
  }
  const lead = first > 0 ? first / sr : 0;
  const tail = last > 0 ? (n - last - fl) / sr : 0;
  return { start: lead, dur: Math.max(0.3, n / sr - lead - tail), total: n / sr };
}

/** 超长句只在句中标点处拆，保证拆出来的每一行都仍是一句完整的话 */
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

function build() {
  const shots = [];
  const lines = [];
  let t = 0;
  /** 一句旁白 → 一条 wav 路径。超长句拆分后，第 k 行对应第 k 个分段音频 */
  const segFile = (id, i, k, rows) => {
    const n = k + 1;
    const p = path.join(VO, `${id}-${i}${n}.wav`);   // S5-4-1.wav
    if (fs.existsSync(p)) return p;
    return rows.length === 1 ? path.join(VO, `${id}-${i}.wav`) : null;
  };

  for (const shot of SHOTS) {
    const seg = { id: shot.id, kind: shot.kind, start: t, lines: [] };
    shot.lines.forEach((text, i) => {
      const whole = path.join(VO, `${shot.id}-${i}.wav`);
      const rows = wrap(text);

      // 情况 A：整句一条 wav —— 按字数比例把 wav 时间轴分配给各行
      if (fs.existsSync(whole)) {
        const w = wavDur(whole);
        const weight = rows.map(r => r.replace(/[，。、：；？！\s]/g, '').length);
        const sum = weight.reduce((a, b) => a + b, 0) || 1;
        let acc = 0;
        rows.forEach((r, k) => {
          const a = acc / sum, b2 = (acc + weight[k]) / sum;
          acc += weight[k];
          seg.lines.push({
            text: r,
            at: +(t + w.start + w.dur * a).toFixed(2),
            end: +(t + w.start + w.dur * b2).toFixed(2),
            file: whole,
          });
        });
        lines.push(seg.lines.slice(-rows.length));
        t += w.total + GAP;
        return;
      }

      // 情况 B：没有整句 wav，退化为分段合成（voice.ps1 会按行分别出 wav）
      if (rows.length === 1) throw new Error('缺少配音 ' + whole);
      let acc = 0;
      rows.forEach((r, k) => {
        const f = segFile(shot.id, i, k, rows);
        if (!f || !fs.existsSync(f)) throw new Error('缺少配音 ' + f);
        const w = wavDur(f);
        seg.lines.push({ text: r, at: +(t + acc + w.start).toFixed(2), end: +(t + acc + w.start + w.dur).toFixed(2), file: f });
        acc += w.total + 0.18;
      });
      t += acc + GAP - 0.18;
    });
    // 镜头时长 = 最后一句话说完 + 收尾留白
    seg.dur = Math.max(t - seg.start + 0.5, shot.dur || 0);
    t = seg.start + seg.dur;
    shots.push(seg);
  }
  const total = t;
  fs.writeFileSync(path.join(VO, 'timeline.json'),
    JSON.stringify({ shots, total: +total.toFixed(2) }, null, 1), 'utf8');

  const flat = [];
  shots.forEach(s => s.lines.forEach(l => flat.push(l)));
  const ts = s => new Date(Math.round(s * 1000)).toISOString().substr(11, 12).replace('.', ',');
  const srt = flat.map((l, i) => `${i + 1}\n${ts(l.at)} --> ${ts(l.end)}\n${l.text}\n`).join('\n');
  fs.writeFileSync(path.join(ROOT, 'media', 'FinGuard-演示视频.srt'), srt, 'utf8');

  console.log('镜头 ' + shots.length + ' 个，字幕 ' + flat.length + ' 条，总时长 ' +
    total.toFixed(1) + ' 秒（' + Math.floor(total / 60) + ' 分 ' + Math.round(total % 60) + ' 秒）');
  for (const s of shots) {
    const mm = String(Math.floor(s.start / 60)).padStart(2, '0');
    const ss = String(Math.round(s.start % 60)).padStart(2, '0');
    console.log('  ' + s.id.padEnd(4) + mm + ':' + ss + '  ' + s.dur.toFixed(1).padStart(5) + 's  ' +
      s.lines.map(l => l.text).join('').slice(0, 40));
  }
}

build();
