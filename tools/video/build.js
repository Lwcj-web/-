/**
 * 视频总装：时间轴 → 逐镜运镜 → 与旁白合成 mp4
 *
 * 两条产时间轴的路径，输出格式相同（timeline.json）：
 *   A. TTS 版：voice.js → voice.ps1 → cue.js
 *   B. 真人配音版：把录音和逐句对齐结果放进 media/vo/ → cue-real.js
 *
 *   node tools/video/cue.js        （或 cue-real.js）
 *   node tools/video/build.js
 *
 * 时间轴只有一份事实来源：timeline.json。这里不再自己算时长——
 * 之前 build.js 和 cue.js 各算一遍，字幕和画面差了一帧就对不上。
 *
 * ffmpeg 不在 PATH 时用 FG_FFMPEG 指定：
 *   FG_FFMPEG=D:/tools/ffmpeg.exe node tools/video/build.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SHOTS } = require('./script');
const { cardFilter } = require('./cards');

const ROOT = path.resolve(__dirname, '..', '..');
const SCR = path.join(ROOT, 'media', 'screens');
const VO = path.join(ROOT, 'media', 'vo');
const TMP = path.join(ROOT, 'media', '.build');
const OUT = path.join(ROOT, 'media', 'FinGuard-演示视频.mp4');
const FFMPEG = process.env.FG_FFMPEG || 'ffmpeg';
const W = 1920, H = 1080;

/* ---------------- 0. 时间轴 ---------------- */
function loadTimeline() {
  const f = path.join(VO, 'timeline.json');
  if (!fs.existsSync(f)) {
    console.error('缺少时间轴：' + path.relative(ROOT, f) + '\n先跑 node tools/video/cue.js');
    process.exit(1);
  }
  const tl = JSON.parse(fs.readFileSync(f, 'utf8'));
  const byId = {};
  SHOTS.forEach(s => { byId[s.id] = s; });
  const single = !!tl.audio;   // 真人配音：整段一条音轨，镜头行不带 file
  tl.shots.forEach(s => {
    const shot = byId[s.id];
    if (!shot) { console.error('timeline 里的 ' + s.id + ' 在 script.js 中不存在，请重跑时间轴'); process.exit(1); }
    s.shot = shot;
    if (single) return;
    // file 由 cue.js 给定（长句拆段后每行对应自己的 wav），这里不重算
    s.lines.forEach((l, i) => {
      if (!l.file) { console.error(s.id + ' 第 ' + (i + 1) + ' 条字幕缺 file 字段，请重跑 cue.js'); process.exit(1); }
      if (!fs.existsSync(l.file)) { console.error('缺少配音：' + path.relative(ROOT, l.file)); process.exit(1); }
    });
  });
  if (single) {
    const a = path.join(ROOT, tl.audio.file);
    if (!fs.existsSync(a)) { console.error('缺少配音：' + path.relative(ROOT, a)); process.exit(1); }
    tl.audio.abs = a;
  }
  return tl;
}

const run = (args, label) => {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) { console.error('无法启动 ffmpeg：' + r.error.message + '\n用 FG_FFMPEG 指定路径'); process.exit(1); }
  if (r.status !== 0) {
    console.error('ffmpeg 失败：' + label + '\n' + (r.stderr || '').split('\n').slice(-12).join('\n'));
    process.exit(1);
  }
};

/* ---------------- 1. 字幕 ---------------- */
const assTime = s => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
};

function esc(s) { return s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}'); }

/** 大标题拆两行居中，靠 pos 钉在画面黄金分割处（Alignment 用 7 = 左上基准，自己算坐标） */
function writeAss(clips, file) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Microsoft YaHei,46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,3,1,2,120,120,56,1
Style: Big,Microsoft YaHei,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,2,0,1,0,0,7,0,0,0,1
Style: Sub,Microsoft YaHei,40,&H00B0BEC5,&H00B0BEC5,&H00000000,&H00000000,0,0,0,0,100,100,3,0,1,0,0,7,0,0,0,1
Style: Quote,Microsoft YaHei,62,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,1,0,1,0,0,7,0,0,0,1
Style: Stat,Microsoft YaHei,150,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
Style: StatCap,Microsoft YaHei,38,&H00B0BEC5,&H00B0BEC5,&H00000000,&H00000000,0,0,0,0,100,100,4,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = [];
  const push = (s, e, style, text) =>
    lines.push(`Dialogue: 0,${assTime(s)},${assTime(e)},${style},,0,0,0,,${text}`);

  for (const c of clips) {
    const t0 = c.start, t1 = c.start + c.dur;

    if (c.kind === 'cover' || c.kind === 'end') {
      // 标题两行逐行浮现，副标题最后出现；留 0.4s 让观众看完再切
      const titles = c.shot.title || [];
      const per = (c.dur - 2.2) / Math.max(titles.length, 1);
      const yBase = c.kind === 'cover' ? 300 : 340;
      titles.forEach((t, i) => {
        const s = t0 + 0.5 + per * i;
        const e = t1 - 1.4;
        const y = yBase + i * 130;
        push(s, e, 'Big', `{\\pos(${W / 2},${y})\\fad(420,320)}${esc(t)}`);
      });
      if (c.shot.sub) {
        const y = yBase + titles.length * 130 + 60;
        push(t0 + 0.5 + per * Math.max(titles.length - 1, 1) + 0.4, t1 - 1.4,
          'Sub', `{\\pos(${W / 2},${y})\\fad(500,300)}${esc(c.shot.sub)}`);
      }
      continue;
    }

    if (c.kind === 'stats') {
      // 三个数字依次砸出来，各自配一句注释；数字期间不叠字幕，避免两套文字打架
      const marks = [
        { n: '121', cap: '条断言：单元 64 · 端到端 31 · DOM 26' },
        { n: '11', cap: '个开发过程中自己抓出来的缺陷' },
        { n: '0', cap: '个运行时依赖：无框架、无 CDN、无构建' },
      ];
      const step = c.dur / marks.length;
      marks.forEach((m, i) => {
        const s = t0 + step * i;
        const e = Math.min(t0 + step * (i + 1) + 0.15, t1);
        push(s + 0.12, e, 'Stat', `{\\pos(${W / 2},430)\\fad(260,180)\\fscx85\\fscy85\\t(0,320,\\fscx100\\fscy100)}${m.n}`);
        push(s + 0.24, e, 'StatCap', `{\\pos(${W / 2},640)\\fad(300,180)}${esc(m.cap)}`);
      });
      // 最后一句旁白「规则在表里，防护是空的」压在画面底部，用 Quote 而不是 Caption
      const last = c.lines[c.lines.length - 1];
      if (last) {
        push(last.at - 0.05, Math.min(last.end + 0.5, t1), 'Quote',
          `{\\pos(${W / 2},830)\\fad(320,260)}${esc(last.text)}`);
      }
      continue;
    }

    for (const l of c.lines) {
      push(l.at, Math.min(l.end - 0.04, t1), 'Caption', esc(l.text));
    }
  }

  fs.writeFileSync(file, head + lines.join('\n') + '\n', 'utf8');
  return lines.length;
}

/* ---------------- 2. 音轨 ---------------- */
function buildAudio(clips, file, tl) {
  // 真人配音：整段录音一条轨，按 lead 统一延后、末尾补静音到片长。
  // 不裁句间停顿——那些停顿就是换镜的位置，裁掉画面会挤在一起。
  if (tl && tl.audio) {
    const off = Math.round((tl.audio.offset || 0) * 1000);
    run(['-y', '-loglevel', 'error', '-i', tl.audio.abs,
      '-af', `aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,adelay=${off},apad`,
      '-t', tl.total.toFixed(2), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', file], 'audio');
    return;
  }

  const args = ['-y', '-loglevel', 'error'];
  const filters = [];
  const labels = [];
  const parts = [];
  let idx = 0;
  for (const c of clips) {
    for (const l of c.lines) {
      args.push('-i', l.file);
      parts.push({ input: idx, at: l.at, end: l.end });
      idx++;
    }
  }
  if (!parts.length) {
    // 全片没有旁白时也要有一条静音轨，否则 concat 时 -map 1:a 会失败
    args.push('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono:d=${clips[clips.length - 1].start + clips[clips.length - 1].dur}`);
    filters.push(`[0:a]aformat=channel_layouts=mono[out]`);
  } else {
    parts.forEach((p, i) => {
      // wav 自带前后静音不裁，按真实起点落位即可——裁了反而和字幕错开
      // 增益放在每条支路上：ffmpeg 4.1 里 amix 之后的 volume 会让进程挂死（实测）
      filters.push(`[${p.input}:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,` +
        `adelay=${Math.round(p.at * 1000)},volume=${parts.length}[a${i}]`);
      labels.push(`[a${i}]`);
    });
    const total = clips[clips.length - 1].start + clips[clips.length - 1].dur;
    // 不用 atrim 收尾（apad + atrim 在 4.1 里同样会挂），改成输出端 -t 截断
    filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest,apad[out]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-t', total.toFixed(2),
      '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', file);
    run(args, 'audio');
    return;
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-ac', '1', '-ar', '48000',
    '-c:a', 'pcm_s16le', file);
  run(args, 'audio');
}

/* ---------------- 3. 单镜渲染 ----------------
 * 截图镜头只用 crop 做缓慢推近；片头 / 片尾 / 数字卡的文字由 cards.js 用
 * drawtext 直接画进画面。两边都不烧字幕。
 *
 * 字幕为什么不烧进画面：ffmpeg 4.1 的 libass 版本在「画面有亮部 + 浅色底」时
 * 会把主色（白色）混成接近透明，实测字幕只剩一层毛边。试过改 Style 白边、
 * 改 PlayRes、改分辨率都没用。改用独立字幕通道（见 main 里的 mov_text），
 * 播放器负责渲染字幕，画质与可读性都不再受 libass 版本影响。
 *
 * 另一个坑：zoompan 的 z 表达式里没有 t，只有帧号 in，写 t 直接报 Undefined constant。
 */
function renderShot(seg, i) {
  const out = path.join(TMP, `seg${String(i).padStart(2, '0')}.mp4`);
  const D = seg.dur.toFixed(3);
  const args = ['-y', '-loglevel', 'error'];
  let filter;

  if (seg.kind === 'shot') {
    const src = path.join(SCR, seg.shot.file);
    if (!fs.existsSync(src)) { console.error('缺少截图：' + path.relative(ROOT, src)); process.exit(1); }
    const cam = seg.shot.cam || { x: 0, y: 0, w: 1, h: 1 };
    const frames = Math.max(1, Math.round(Number(D) * 30));
    if (cam.w >= 0.98 && cam.h >= 0.98) {
      // cam:null = 整幅不动。整幅截图左右各有留白，任何推近都会切掉右侧的安全管线栏，
      // 而那一栏恰恰是旁白在讲的东西——所以零镜头不推，让它稳稳地待在画面上。
      args.push('-loop', '1', '-i', src);
      filter = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
        `setsar=1,format=yuv420p`;
    } else {
      // 有取景框时才推：zoompan 的输出尺寸设成取景框本身，再由 scale 放大回 1920×1080，
      // 推近是「绕取景框」而不是「绕整屏」，小字也保得住。
      const cw = Math.round(W * cam.w), chh = Math.round(H * cam.h);
      const cx = Math.round(W * cam.x), cy = Math.round(H * cam.y);
      const z = `1+0.038*in/${frames}`;
      args.push('-loop', '1', '-i', src);
      filter =
        `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,` +
        `zoompan=z='${z}':x=${cx}:y=${cy}:d=1:s=${cw}x${chh}:fps=30,` +
        `scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p`;
    }
    if (seg.shot.transition === 'blur') filter += `,gblur=sigma=2.5:enable='lt(t,0.5)'`;
    if (seg.shot.fadein) filter += `,fade=t=in:st=0:d=0.6`;
  } else {
    // 大字卡：深底 + 极轻的噪点（防投屏色带）+ drawtext 画的标题/数字
    args.push('-f', 'lavfi', '-i', `color=c=0x0b1220:s=${W}x${H}:r=30:d=${D}`);
    filter = cardFilter(seg);
  }

  args.push('-vf', filter,
    '-t', D, '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-g', '60', out);
  run(args, 'seg ' + seg.id);
  return out;
}

/* ---------------- 4. 总装 ---------------- */
function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const tl = loadTimeline();
  const clips = tl.shots;
  const total = tl.total || (clips[clips.length - 1].start + clips[clips.length - 1].dur);
  console.log('分镜 ' + clips.length + ' 个，总时长 ' + total.toFixed(1) + ' 秒（' +
    Math.floor(total / 60) + ' 分 ' + Math.round(total % 60) + ' 秒）');

  const srt = path.join(ROOT, 'media', 'FinGuard-演示视频.srt');
  const n = fs.readFileSync(srt, 'utf8').split('\n\n').filter(Boolean).length;
  console.log('字幕 ' + n + ' 条（独立字幕轨，取自 ' + path.relative(ROOT, srt) + '）');

  const audio = path.join(TMP, 'vo.wav');
  buildAudio(clips, audio, tl);

  const segs = clips.map((c, i) => {
    const f = renderShot(c, i);
    console.log('  ' + c.id.padEnd(4) + String(c.start.toFixed(1)).padStart(7) + 's  ' + c.dur.toFixed(1) + 's  → ' + path.basename(f));
    return f;
  });

  const list = path.join(TMP, 'list.txt');
  fs.writeFileSync(list, segs.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  // 字幕作为 mov_text 轨嵌进 mp4：播放器可开关，不受 libass 版本影响
  //
  // 收尾用 -t 而不是 -shortest：-shortest 会把三路流里最短的那路当基准，
  // 而字幕轨最后一条在 171.7 秒结束、音轨一直补到片尾，结果整片被砍掉 5 秒，
  // 片尾卡片直接被截断（成片 2:51 而时间轴 2:57）。显式给总时长最稳。
  run(['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
    '-i', audio, '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=chi', '-metadata:s:s:0', 'title=中文',
    '-movflags', '+faststart', '-t', total.toFixed(2), OUT], 'concat');

  const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
  console.log('完成：' + path.relative(ROOT, OUT) + '（' + mb + 'MB）');
}

main();
