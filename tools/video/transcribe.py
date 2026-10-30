#!/usr/bin/env python
"""用 faster-whisper 转写真人配音，输出带词级时间戳的 JSON。

    pip install faster-whisper
    python tools/video/transcribe.py media/vo/narration.m4a media/vo/asr.json small

为什么要转写：配音是照稿念的，但「第几句在第几秒」必须靠识别才能确定。
系统自带的 SAPI 桌面识别器错误率太高，只够认出几个数字；whisper 的 small
模型在这段 170 秒中文上，34 句台本有 30 句相似度超过 85%。

两个坑：
1. 模型权重默认从 huggingface.co 下，国内不通。设 HF_ENDPOINT 到镜像。
   huggingface_hub 还会走 Xet 存储通道（cas-server.xethub.hf.co），同样不通，
   必须 HF_HUB_DISABLE_XET=1 强制走普通 HTTP。
2. faster-whisper 用 PyAV 解码音频，新版 av 的 open() 已经没有
   metadata_errors 参数，会直接 TypeError。这里绕开它：先让 ffmpeg 解成
   16k 单声道 f32，再把 numpy 数组喂给 transcribe()。
"""
import json
import os
import subprocess
import sys
import tempfile

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

import numpy as np
from faster_whisper import WhisperModel

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def decode(path):
    """用 ffmpeg 解成 16k 单声道 f32，避免 PyAV 版本不兼容"""
    fd, tmp = tempfile.mkstemp(suffix=".f32")
    os.close(fd)
    ff = os.environ.get("FG_FFMPEG", "ffmpeg")
    subprocess.run(
        [ff, "-hide_banner", "-loglevel", "error", "-y", "-i", path,
         "-ac", "1", "-ar", "16000", "-f", "f32le", tmp],
        check=True,
    )
    audio = np.fromfile(tmp, dtype=np.float32)
    os.remove(tmp)
    return audio


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    audio_path = sys.argv[1]
    out_path = sys.argv[2]
    size = sys.argv[3] if len(sys.argv) > 3 else "small"

    prompt_file = os.path.join(ROOT, "docs", "配音台词.txt")
    prompt = ""
    if os.path.exists(prompt_file):
        with open(prompt_file, encoding="utf-8") as f:
            # 纯台词文件里带分组标题，去掉之后只留正文，识别更稳
            rows = [r.split("]", 1)[-1].strip() for r in f if r.startswith("[S")]
        prompt = " ".join(r for r in rows if r)

    audio = decode(audio_path)
    model = WhisperModel(size, device="cpu", compute_type="int8",
                         download_root=os.path.join(ROOT, "media", ".models"))
    segments, info = model.transcribe(
        audio, language="zh", beam_size=5, word_timestamps=True,
        initial_prompt=prompt, condition_on_previous_text=False, vad_filter=False,
    )

    segs, words = [], []
    for s in segments:
        segs.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()})
        for w in (s.words or []):
            words.append({"start": round(w.start, 3), "end": round(w.end, 3), "w": w.word})

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"duration": info.duration, "language": info.language,
                   "segments": segs, "words": words}, f, ensure_ascii=False, indent=1)
    print(f"分段 {len(segs)} · 词 {len(words)} · 时长 {info.duration:.2f}s → {out_path}")


if __name__ == "__main__":
    main()
