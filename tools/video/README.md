# 演示视频流水线

一条命令生成整支片子，不打开剪辑软件。当前成片走的是**真人配音**这条路：

```bash
# A. 真人配音（当前成片）
python tools/video/transcribe.py media/vo/narration.m4a media/vo/asr.json small
node tools/video/align-real.js   # 转写 → 34 句台本逐句起止 → media/vo/align.json
node tools/video/cue-real.js     # 镜头边界 + 字幕 → timeline.json + srt
FG_FFMPEG=D:/tools/ffmpeg.exe node tools/video/build.js
                                 # 出片 → media/FinGuard-演示视频.mp4

# B. 系统 TTS（没有录音时用这条）
node tools/video/voice.js        # script.js → voice.ps1（UTF-16LE+BOM）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/video/voice.ps1
node tools/video/cue.js
FG_FFMPEG=D:/tools/ffmpeg.exe node tools/video/build.js
```

`ffmpeg` 在 PATH 里时可以省掉 `FG_FFMPEG`。两条路产出的 `timeline.json` 同构，
`build.js` 不区分来源。

## 分工

| 文件 | 职责 | 改它的时候要知道 |
|---|---|---|
| `script.js` | 旁白与分镜，**唯一事实来源** | 字幕、配音、运镜都从这生成；改字数就是改片长 |
| `transcribe.py` | 录音 → 带词级时间戳的转写 | 走 hf-mirror + 关掉 Xet，见下方坑 6 |
| `align-real.js` | 34 句台本 → 录音里的起止 | 单调 DP；相似度低于 55% 会标 ⚠ 让人工核一句 |
| `cue-real.js` | 镜头边界与字幕 | 换镜提前 0.25s；数字卡的三个数字跟着念到哪算哪 |
| `voice.js` / `cue.js` | TTS 版的分句与时间轴 | 超 26 字的句子按标点拆成 `S5-4-1.wav` |
| `cards.js` | 片头 / 片尾 / 数字卡的文字 | 用 `drawtext` 直接画进画面，不经过 libass |
| `build.js` | 运镜、混音、拼接、封字幕轨 | 只读 `timeline.json`，不自己算时长 |
| `scriptbook.js` | 配音台本 → `docs/配音台本.md` + `docs/配音台词.txt` | 不依赖 wav，按 4.2 字/秒估时长 |

## 录一段自己的配音

台词与录制约定由 `node tools/video/scriptbook.js` 从 `script.js` 生成。录制要点：

- **一条录完**，不用分镜分段 —— 对齐工具会自己找句界
- 句间停 0.3–0.5s，别连读（停顿就是换镜点）
- 念错重录整段，不要拼接（拼接处音量对不上，剪出来很假）
- 整段存成 `media/vo/narration.m4a`（16k 以上采样率，单声道足够）

录完跑 A 那条链。`align-real.js` 会把每句的起止时间算出来，`cue-real.js`
按「第一句开口的时间」定镜头边界，画面与运镜自动跟着新时长重排，不需要手工调。

## 三个已经踩过的坑

**1. ps1 必须是 UTF-16LE + BOM。**
用 UTF-8 写中文，PowerShell 5.1 会按 ANSI 解读，`Speak()` 要么只吐一两秒噪音，
要么整个脚本静默退出、什么都不生成。`voice.js` 里这一行不能改：

```js
fs.writeFileSync(p, Buffer.from('\uFEFF' + text, 'utf16le'));
```

**2. 字幕不能靠音量切。**
相邻两句之间也有 300ms 停顿，按音量谷底切分会让谷底落在句间而不是句内，
字幕边界比句子边界早半句。现在一句旁白对应一条 wav，时间轴取 wav 真实时长。

**3. ffmpeg 4.1 没有 `amix` 的 `normalize` 参数。**
用 `volume=N` 按支路补偿，不要写成 `amix=...:volume=N`——把 `volume` 放在
`amix` **之后**会让 ffmpeg 直接挂死（无输出、不退出）。同理 `apad` 后面接
`atrim=0:total` 也会挂，改用输出端的 `-t total` 截断。

**4. 字幕不烧进画面，改为 mp4 内嵌 `mov_text` 轨。**
ffmpeg 4.1 的 libass 在浅色画面上会把白色主色混成近透明，只剩一层毛边
（深色片头卡正常，说明是 libass 的颜色混合缺陷）。试过改 Style 白边、
改 `PlayRes`、改输出分辨率、改 `scale` 顺序，都无效。现在用
`-c:s mov_text` 内嵌独立字幕轨，播放器负责渲染，可开关、可换字体。
另有：`ass` 放进 `filter_complex` 两段式图时时间戳是错的，片头大字会一直压在
后面所有画面上——只在单条 `-vf` 链里用才对。

**5. 片头卡的文字用 `drawtext`，alpha 必须「到点回 0」。**
只写淡入、不写淡出，alpha 会一直停在 1，数字卡的三个数字会全部叠在画面中央
（实测重影成「1121」）。`cards.js` 里的 `win(s,e)` 就是这个窗口函数。

**6. whisper 的模型下不下来，是两件事叠在一起。**
`huggingface.co` 本身不通，得设 `HF_ENDPOINT=https://hf-mirror.com`；设了镜像
仍然会失败，因为 `huggingface_hub` 还会走 Xet 存储通道
（`cas-server.xethub.hf.co`），那条路返回 401。必须再设 `HF_HUB_DISABLE_XET=1`
强制走普通 HTTP。另外 newer `av` 的 `open()` 已经没有 `metadata_errors` 参数，
`faster-whisper` 直接 `TypeError` —— 所以 `transcribe.py` 先用 ffmpeg 解成
16k 单声道 f32，再把 numpy 数组喂进去，完全不经过 PyAV。

**7. `-shortest` 按三路流里最短的那路截断，而字幕轨通常最先结束。**
末句字幕在 171.7 秒收，音轨补到 177 秒，`-shortest` 于是把整片砍到 171.7 秒，
片尾卡片被截断（成片 2:51 而时间轴 2:57）。改成显式 `-t total`。
注意这是 `-shortest` 的语义，不是 bug——它本来就是为了「短的那路播完就停」。

## 语速档位实测

同一批文本，`SpeechSynthesizer.Rate` 对总时长的影响（单位：秒）：

| Rate | 旁白总长 | 听感 |
|---|---|---|
| 3 | 142 | 自然，适合无人声需求的正式汇报 |
| 6 | 126 | 偏快 |
| 7 | 104 | 快 |
| 8 | 95 | 赶 |

当前采用 `Rate=3`，旁白总长 142 秒，TTS 版成片 2 分 47 秒。
真人配音版是 2 分 57 秒（录音 170.35 秒 + 片头 3 秒留白 + 片尾 4.8 秒）。
赛制上限 5 分钟，两种版本都留了 2 分多钟余量——现场答辩时可用 1.5 倍速播，观感仍然从容。

## 换一版片子

改 `script.js` 的 `lines` 就直接改了片长。估算：一句 20 字约 5.5 秒（含停顿）。
只想改字幕不动配音，改完 `script.js` 后从第 2 步开始跑即可。
