#!/usr/bin/env python3
"""
Firefly 本地音乐一键解析脚本
============================
从本地音频文件自动提取 Firefly 音乐播放器所需的全部信息：
  1. ID3 标签   → 歌名 / 艺术家 / 专辑 / 时长
  2. 内嵌封面   → 导出为 jpg（可缩放，依赖 ffmpeg）
  3. 网易云 API → 搜索匹配歌曲并下载 LRC 同步歌词（含翻译合并）

默认行为（零参数）:
    读取脚本同目录下 music/ 文件夹里的所有音频，
    解析结果输出到 music/output/（与源音频同在一个 music/ 文件夹内）

音频超过 20MB 时自动用 ffmpeg 转码为 320kbps mp3 压缩；
压缩后仍超过 20MB 会输出警告（时长过长的音频浏览器加载较慢）。

用法:
    python3 music_parser.py                      # 默认: music/ → music/output/
    python3 music_parser.py <文件或目录> [-o 目录] # 自定义输入输出
    python3 music_parser.py --lyric-lang merge    # 歌词原文+翻译合并

歌词语言 (--lyric-lang):
    orig    原语言，即歌曲本身的语言（默认）
    trans   仅翻译歌词（如英文歌显示中文）；无翻译时回退原语言
    merge   原文 + 翻译合并显示，如 "Hello (你好)"

输出 (music/output/):
    assets/music/            音频 + cover/ 封面 + lrc/ 歌词（复制到 Firefly 的 public/ 下）
    musicConfig.local.ts     可直接粘贴进 musicConfig.ts 的配置片段
    playlist.json            同内容 JSON 版本

依赖:
    pip install requests mutagen
    ffmpeg（可选，用于封面缩放；没有则保存原始封面）
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import requests
from mutagen import File as MutagenFile
from mutagen.flac import FLAC
from mutagen.id3 import ID3
from mutagen.mp3 import MP3

try:  # Python 3.13+ 移除了 telnetlib 等，ratio 计算用标准库 difflib
    from difflib import SequenceMatcher
except ImportError:  # pragma: no cover
    SequenceMatcher = None

UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://music.163.com/",
}
SEARCH_API = "https://music.163.com/api/search/get/web"
LYRIC_API = "https://music.163.com/api/song/lyric"
AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".ogg", ".wav", ".opus"}


# ────────────────────── 工具函数 ──────────────────────

def similarity(a: str, b: str) -> float:
    """字符串相似度 0~1"""
    if not a or not b:
        return 0.0
    if SequenceMatcher:
        return SequenceMatcher(None, a.lower(), b.lower()).ratio()
    a, b = a.lower(), b.lower()
    return 1.0 if a == b else 0.0


def sanitize(name: str) -> str:
    """清理文件名中的非法字符"""
    return re.sub(r'[\\/:*?"<>|]+', "_", name).strip()


def parse_filename(path: Path) -> tuple[str, str]:
    """从文件名回退解析 '艺术家 - 歌名' 格式"""
    stem = path.stem
    # 去掉常见前缀：[扫码关注xxx]、(Live)、序号等
    stem = re.sub(r"^[\s\[\(（]?[\d]+[\s\]）\)]?[-_. ]+", "", stem).strip()
    if " - " in stem:
        artist, _, title = stem.partition(" - ")
        return artist.strip(), title.strip()
    return "", stem


# ────────────────────── 元数据提取 ──────────────────────

def extract_metadata(path: Path) -> dict:
    """提取 ID3/FLAC 标签，返回 {title, artist, album, duration}"""
    meta = {"title": "", "artist": "", "album": "", "duration": 0.0}
    try:
        audio = MutagenFile(path, easy=True)
        if audio is None:
            raise ValueError("unsupported")
        meta["title"] = str(audio.get("title", [""])[0] or "")
        meta["artist"] = str(audio.get("artist", [""])[0] or "")
        meta["album"] = str(audio.get("album", [""])[0] or "")
        if audio.info:
            meta["duration"] = float(audio.info.length or 0)
    except Exception:
        pass

    # 标签缺失时回退到文件名
    if not meta["title"] or not meta["artist"]:
        f_artist, f_title = parse_filename(path)
        meta["title"] = meta["title"] or f_title
        meta["artist"] = meta["artist"] or f_artist
    return meta


def extract_cover(path: Path, out_path: Path, size: int | None) -> bool:
    """提取内嵌封面，成功返回 True"""
    raw = None
    try:
        if path.suffix.lower() == ".mp3" or (path.with_suffix(".mp3").exists()):
            audio = MP3(path)
            tags = audio.tags if isinstance(audio.tags, ID3) else None
            if tags:
                for key in ("APIC:cover", "APIC:", "APIC:front"):
                    if key in tags:
                        raw = tags[key].data
                        break
                if raw is None:  # 任意 APIC 帧
                    for tag in tags.values():
                        if getattr(tag, "data", None) and tag.__class__.__name__ == "APIC":
                            raw = tag.data
                            break
        elif path.suffix.lower() == ".flac":
            pics = FLAC(path).pictures
            if pics:
                raw = pics[0].data
        else:  # m4a 等
            audio = MutagenFile(path)
            for tag in (audio.tags or {}).values() if audio else []:
                data = getattr(tag, "data", None)
                if data and len(data) > 1000:  # 启发式：大块二进制即封面
                    raw = data
                    break
    except Exception:
        raw = None

    if not raw:
        return False

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(raw)

    # 用 ffmpeg 缩放（可选）
    if size and shutil.which("ffmpeg"):
        tmp = out_path.with_suffix(".tmp.jpg")
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(out_path),
                 "-vf", f"scale={size}:{size}:force_original_aspect_ratio=increase,"
                        f"crop={size}:{size}", str(tmp)],
                check=True, capture_output=True,
            )
            tmp.replace(out_path)
        except subprocess.CalledProcessError:
            tmp.unlink(missing_ok=True)
    return True


# ────────────────────── 网易云歌词 ──────────────────────

def netease_search(title: str, artist: str, limit: int = 10) -> list[dict]:
    """搜索网易云歌曲，返回候选列表"""
    query = f"{title} {artist}".strip()
    try:
        resp = requests.get(
            SEARCH_API,
            params={"s": query, "type": 1, "offset": 0, "total": "true", "limit": limit},
            headers=UA, timeout=15,
        )
        resp.raise_for_status()
        songs = resp.json().get("result", {}).get("songs", [])
        return songs or []
    except Exception as e:
        print(f"    ! 搜索失败: {e}")
        return []


def pick_best(candidates: list[dict], title: str, artist: str, duration: float) -> dict | None:
    """按 歌名相似度 + 歌手匹配 + 时长接近 选出最佳候选"""
    best, best_score = None, -1.0
    for song in candidates:
        s_title = song.get("name", "")
        s_artists = "/".join(a["name"] for a in song.get("artists", []))
        s_duration = song.get("duration", 0) / 1000.0

        score = similarity(title, s_title) * 0.5

        # 歌手匹配：任一歌手名出现在对方字符串里即可
        artist_names = [a.strip().lower() for a in re.split(r"[,/&]", artist) if a.strip()]
        s_names = [a.strip().lower() for a in re.split(r"[,/&]", s_artists) if a.strip()]
        if any(an in sn or sn in an for an in artist_names for sn in s_names):
            score += 0.3

        # 时长接近度（±3 秒内满分）
        if duration > 0 and s_duration > 0:
            diff = abs(duration - s_duration)
            score += max(0.0, 0.2 * (1 - diff / 15.0)) if diff < 15 else 0.0

        if score > best_score:
            best_score, best = score, song
    return best if best_score >= 0.4 else None


def fetch_lrc(song_id: int, lyric_lang: str) -> str | None:
    """下载歌词。lyric_lang: "orig" 原语言 / "trans" 仅翻译 / "merge" 原文+翻译合并"""
    try:
        resp = requests.get(
            LYRIC_API,
            params={"os": "pc", "id": song_id, "lv": -1, "tv": -1, "kv": -1, "rv": -1},
            headers=UA, timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        lrc = (data.get("lrc") or {}).get("lyric", "")
        trans = (data.get("tlyric") or {}).get("lyric", "")

        if lyric_lang == "trans":
            # 仅翻译：没有翻译时回退原语言并提示
            if trans:
                return trans
            if lrc:
                print("  歌词: 无翻译版本，回退原语言")
            return lrc or None
        if lyric_lang == "merge" and trans:
            return merge_translation(lrc, trans)
        return lrc or None
    except Exception as e:
        print(f"    ! 歌词下载失败: {e}")
        return None


def parse_lrc_time_line(line: str) -> tuple[float, str] | None:
    """解析一行 LRC，返回 (时间秒, 文本)"""
    m = re.match(r"^((?:\[\d{2}:\d{2}(?:\.\d{1,3})?\])+)(.*)$", line.strip())
    if not m:
        return None
    times = re.findall(r"\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]", m.group(1))
    text = m.group(2).strip()
    secs = [int(t[0]) * 60 + int(t[1]) + (int(t[2].ljust(3, "0")) / 1000 if t[2] else 0)
            for t in times]
    return (secs[0], text) if text else None


def merge_translation(lrc: str, trans: str) -> str:
    """把翻译行按时间戳合并到原文行后面（Firefly 原生 LRC 单行展示友好）"""
    trans_map: dict[float, str] = {}
    for line in trans.splitlines():
        parsed = parse_lrc_time_line(line)
        if parsed:
            trans_map[round(parsed[0], 2)] = parsed[1]

    out = []
    for line in lrc.splitlines():
        parsed = parse_lrc_time_line(line)
        if parsed:
            t = trans_map.pop(round(parsed[0], 2), "")
            if t:
                line = f"{line.rstrip()} ({t})"
        out.append(line)
    return "\n".join(out)


# ────────────────────── 主流程 ──────────────────────

def process_file(path: Path, out_dir: Path, size: int | None,
                 want_lrc: bool, lyric_lang: str = "orig", keep_ext: bool = True) -> dict | None:
    """处理单个音频文件，返回 Firefly 播放列表条目"""
    print(f"\n▶ {path.name}")

    # 1. 元数据
    meta = extract_metadata(path)
    title = meta["title"] or path.stem
    artist = meta["artist"] or "未知艺术家"
    print(f"  标签: {title} - {artist}  [{meta['album'] or '未知专辑'}] "
          f"{int(meta['duration'] // 60)}:{int(meta['duration'] % 60):02d}")

    safe_name = sanitize(f"{artist} - {title}") or sanitize(path.stem)

    # 2. 复制音频（输出结构 assets/music/，与文档一致）
    #    超过 20MB 时用 ffmpeg 转码为 320kbps mp3 压缩
    music_dir = out_dir / "assets" / "music"
    music_dir.mkdir(parents=True, exist_ok=True)
    compress_threshold = 20 * 1024 * 1024  # 20MB
    need_compress = path.stat().st_size > compress_threshold

    if need_compress and shutil.which("ffmpeg"):
        music_dest = music_dir / f"{safe_name}.mp3"
        tmp = music_dest.with_suffix(".tmp.mp3")
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path),
                 "-codec:a", "libmp3lame", "-b:a", "320k", str(tmp)],
                check=True, capture_output=True,
            )
            tmp.replace(music_dest)
            size_mb = music_dest.stat().st_size / 1024 / 1024
            print(f"  音频: {music_dest.relative_to(out_dir)} "
                  f"({path.stat().st_size // 1024 // 1024}MB → {size_mb:.1f}MB, 320kbps 压缩)")
            if music_dest.stat().st_size > compress_threshold:
                print(f"    ⚠ 压缩后仍超过 20MB（{size_mb:.1f}MB），"
                      f"音频时长过长，浏览器加载可能较慢，建议自行截取或降低码率")
        except subprocess.CalledProcessError:
            tmp.unlink(missing_ok=True)
            # 转码失败则回退为原样复制
            music_dest = music_dir / (safe_name + path.suffix)
            if path.resolve() != music_dest.resolve():
                shutil.copy2(path, music_dest)
            print(f"  音频: {music_dest.relative_to(out_dir)} "
                  f"(压缩失败，保留原文件 {path.stat().st_size // 1024 // 1024}MB)")
    else:
        if need_compress:
            print("    ⚠ 超过 20MB 且未安装 ffmpeg，无法压缩，将原样复制")
        music_dest = music_dir / (safe_name + path.suffix if keep_ext else ".mp3")
        if path.resolve() != music_dest.resolve():
            shutil.copy2(path, music_dest)
        print(f"  音频: {music_dest.relative_to(out_dir)}")

    # 3. 封面
    cover_rel = ""
    cover_dir = out_dir / "assets" / "music" / "cover"
    cover_path = cover_dir / f"{safe_name}.jpg"
    if extract_cover(path, cover_path, size):
        cover_rel = f"/assets/music/cover/{cover_path.name}"
        print(f"  封面: {cover_path.name} ({cover_path.stat().st_size // 1024}KB)")
    else:
        print("  封面: 未找到内嵌封面")

    # 4. 歌词
    lrc_rel = ""
    if want_lrc:
        lrc_dir = out_dir / "assets" / "music" / "lrc"
        lrc_dir.mkdir(parents=True, exist_ok=True)
        lrc_path = lrc_dir / f"{safe_name}.lrc"
        if lrc_path.exists():
            lrc_rel = f"/assets/music/lrc/{lrc_path.name}"
            print(f"  歌词: 已存在，跳过下载 ({lrc_path.name})")
        else:
            candidates = netease_search(title, artist)
            if not candidates:
                # 搜索失败/无结果时，仅用歌名再试一次
                candidates = netease_search(title, "")
            best = pick_best(candidates, title, artist, meta["duration"]) if candidates else None
            if best:
                s_artists = "/".join(a["name"] for a in best.get("artists", []))
                print(f"  匹配: {best['name']} - {s_artists} (id={best['id']})")
                lrc = fetch_lrc(best["id"], lyric_lang)
                if lrc and len(lrc.splitlines()) > 4:
                    lrc_path.write_text(lrc, encoding="utf-8")
                    lrc_rel = f"/assets/music/lrc/{lrc_path.name}"
                    print(f"  歌词: 已下载 ({len(lrc.splitlines())} 行)")
                else:
                    print("  歌词: 网易云无此歌歌词")
                time.sleep(0.5)  # 限速，避免触发风控
            else:
                print("  歌词: 未找到匹配歌曲")

    return {
        "name": title,
        "artist": artist,
        "url": f"/assets/music/{music_dest.name}",
        "cover": cover_rel,
        "lrc": lrc_rel,
    }


def main():
    # 默认: 脚本所在目录下的 music/ 为输入，music/output/ 为输出
    script_dir = Path(__file__).resolve().parent
    default_music_dir = script_dir / "music"

    parser = argparse.ArgumentParser(
        description="Firefly 本地音乐一键解析（默认读取脚本旁的 music/ 文件夹）"
    )
    parser.add_argument("input", nargs="?", default=str(default_music_dir),
                        help="音频文件或目录 (默认: 脚本目录下的 music/)")
    parser.add_argument("-o", "--output", default=None,
                        help="输出目录 (默认: 输入目录下的 output/)")
    parser.add_argument("--size", type=int, default=500, help="封面边长像素，0=原始尺寸 (默认 500)")
    parser.add_argument("--no-lrc", action="store_true", help="跳过歌词下载")
    parser.add_argument(
        "--lyric-lang",
        choices=["orig", "trans", "merge"],
        default="orig",
        help="歌词语言: orig=原语言(默认), trans=仅翻译(无翻译时回退原语言), "
             "merge=原文+翻译合并",
    )
    parser.add_argument("--no-zip", action="store_true", help="（已废弃）脚本不再打包 zip，保留参数仅为兼容")
    args = parser.parse_args()

    src = Path(args.input).expanduser().resolve()
    if not src.exists():
        if src == default_music_dir:
            sys.exit(f"错误: 未找到 {src}\n请先在脚本目录下创建 music/ 文件夹并放入音频文件")
        sys.exit(f"错误: 路径不存在 {src}")

    # 输出目录：默认在输入目录下的 output/（与音频源文件同处一个 music/ 文件夹）
    out_dir = Path(args.output).expanduser().resolve() if args.output else src / "output"

    if src.is_file():
        files = [src]
    else:
        # 扫描输入目录，排除输出目录自身
        out_dir.mkdir(parents=True, exist_ok=True)
        out_resolved = out_dir.resolve()
        files = sorted(
            p for p in src.rglob("*")
            if p.suffix.lower() in AUDIO_EXTS
            and out_resolved not in p.resolve().parents
            and p.resolve() != out_resolved
        )
    if not files:
        sys.exit(f"错误: 未找到音频文件 ({' '.join(AUDIO_EXTS)})")

    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"共 {len(files)} 个文件")
    print(f"输入: {src}")
    print(f"输出: {out_dir}")

    playlist = []
    for f in files:
        try:
            entry = process_file(f, out_dir, args.size or None,
                                 not args.no_lrc, args.lyric_lang)
            if entry:
                playlist.append(entry)
        except KeyboardInterrupt:
            print("\n已中断")
            break
        except Exception as e:
            print(f"    ! 处理失败: {e}")

    # 生成 musicConfig.local.ts（与文档格式一致，可直接粘贴进 musicConfig.ts）
    ts_entries = []
    for e in playlist:
        # 无论字段是否有值，均输出全部字段（与文档格式完全一致，缺失用空字符串占位）
        lines = [
            "\t\t{",
            f"\t\t\tname: {json.dumps(e['name'], ensure_ascii=False)},",
            f"\t\t\tartist: {json.dumps(e['artist'], ensure_ascii=False)},",
            f"\t\t\turl: {json.dumps(e['url'], ensure_ascii=False)},",
            f"\t\t\tcover: {json.dumps(e.get('cover') or '', ensure_ascii=False)},",
            f"\t\t\tlrc: {json.dumps(e.get('lrc') or '', ensure_ascii=False)},",
            "\t\t},",
        ]
        ts_entries.append("\n".join(lines))

    ts_content = (
        "// 由 music_parser.py 自动生成，粘贴到 src/config/musicConfig.ts\n"
        "// 替换 local 字段即可（mode 需为 \"local\"）\n"
        "local: {\n"
        "\tplaylist: [\n"
        + "\n".join(ts_entries)
        + "\n\t],\n"
        "},\n"
    )
    ts_path = out_dir / "musicConfig.local.ts"
    ts_path.write_text(ts_content, encoding="utf-8")

    # 生成 playlist.json（编程用，可选）
    result_path = out_dir / "playlist.json"
    result_path.write_text(
        json.dumps(playlist, ensure_ascii=False, indent="\t") + "\n", encoding="utf-8"
    )

    print(f"\n{'=' * 60}")
    print(f"完成! {len(playlist)}/{len(files)} 首解析成功")
    print(f"\n输出位置: {out_dir}/")
    print(f"  assets/music/              → 复制到 Firefly 的 public/assets/music/")
    print(f"  musicConfig.local.ts       → 粘贴进 src/config/musicConfig.ts 的 local 字段")
    print(f"  playlist.json              同内容的 JSON 版本")


if __name__ == "__main__":
    main()
