/**
 * 旁白脚本生成：script.js → media/vo/*.wav
 *
 *   node tools/video/voice.js
 *   powershell -NoProfile -ExecutionPolicy Bypass -File tools/video/voice.ps1
 *
 * 两个坑记在这里，改动前先读：
 *
 * 1. ps1 必须写成 UTF-16LE 且带 BOM。用 UTF-8 写，PowerShell 5.1 会按 ANSI
 *    解读中文，Speak() 要么只吐一两秒噪音，要么整个脚本静默退出、什么都不生成。
 *
 * 2. 超过 SUBCHARS 字的句子要拆成几段分别合成（S5-4-1.wav / S5-4-2.wav），
 *    字幕才不会在长句里追不上嘴。整句版的 wav 仍然保留，供只想要全句时使用。
 */
const fs = require('fs');
const path = require('path');
const { SHOTS } = require('./script.js');

const OUT = path.resolve(__dirname, '..', '..', 'media', 'vo');
const SUBCHARS = 26;   // 与 cue.js 的 MAXCHARS 保持一致
const RATE = 3;        // System.Speech 语速档位（-10~10），3 实测约 3.6 字/秒

/** 与 cue.js 的 wrap() 必须完全一致，否则字幕行与音频段对不上 */
function wrap(text) {
  if (text.length <= SUBCHARS) return [text];
  const parts = text.match(/[^，、：；]+[，、：；]?/g) || [text];
  const out = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > SUBCHARS && buf) { out.push(buf); buf = p; }
    else buf += p;
  }
  if (buf) out.push(buf);
  return out;
}

const items = [];
for (const shot of SHOTS) {
  shot.lines.forEach((text, i) => {
    const rows = wrap(text);
    if (rows.length === 1) {
      items.push({ id: `${shot.id}-${i}`, text });
    } else {
      rows.forEach((r, k) => items.push({ id: `${shot.id}-${i}-${k + 1}`, text: r }));
    }
  });
}

const q = s => s.replace(/"/g, '`"');

const L = [];
L.push('# FinGuard 演示视频旁白合成（由 tools/video/voice.js 生成，勿手改）');
L.push('$ErrorActionPreference = "Stop"');
L.push('');
L.push('$out = "' + OUT.replace(/\\/g, '\\\\') + '"');
L.push('if (-not (Test-Path -LiteralPath $out)) { $null = New-Item -ItemType Directory -Path $out -Force }');
L.push('');
L.push('Add-Type -AssemblyName System.Speech');
L.push('$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer');
L.push('$synth.SelectVoice("Microsoft Huihui Desktop")');
L.push('$synth.Rate = ' + RATE);
L.push('$synth.Volume = 100');
L.push('$list = @(');
L.push(items.map(it => '  @{ id = "' + it.id + '"; text = "' + q(it.text) + '" }').join(',\r\n'));
L.push(')');
L.push('');
L.push('foreach ($it in $list) {');
L.push('  $p = Join-Path $out ($it.id + ".wav")');
L.push('  $synth.SetOutputToWaveFile($p)');
L.push('  $synth.Speak($it.text)');
L.push('  $synth.SetOutputToNull()');
L.push('  Write-Output ($it.id + "  " + [math]::Round((Get-Item -LiteralPath $p).Length / 44.1) + "ms")');
L.push('}');
L.push('$synth.Dispose()');
L.push('Write-Output ("DONE " + $list.Count)');

const text = '\uFEFF' + L.join('\r\n') + '\r\n';
fs.writeFileSync(path.join(__dirname, 'voice.ps1'), Buffer.from(text, 'utf16le'));
fs.writeFileSync(path.join(__dirname, 'vo_list.json'), JSON.stringify(items, null, 1), 'utf8');
console.log('生成 ' + items.length + ' 段旁白 → tools/video/voice.ps1（Rate=' + RATE + '）');
