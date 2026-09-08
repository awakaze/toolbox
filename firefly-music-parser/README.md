# Firefly Music Parser

为 [Firefly](https://github.com/CuteLeaf/Firefly) 博客主题的本地音乐模式一键生成所需的全部资源。

只需把音频文件（或整个目录）丢给脚本，即可自动完成：

| 功能 | 来源 |
|---|---|
| 歌名 / 艺术家 / 专辑 / 时长 | 音频文件的 ID3 / FLAC 标签（缺失时回退解析文件名 `艺术家 - 歌名.mp3`） |
| 封面图片 | 音频内嵌封面，导出为 jpg 并缩放（依赖 ffmpeg，可选） |
| 音频压缩 | 超过 20MB 的音频自动转码为 320kbps mp3（依赖 ffmpeg；压缩后仍超 20MB 会提示） |
| 同步歌词（LRC） | 网易云音乐公开接口，智能匹配（歌名相似度 + 歌手 + 时长） |
| 播放列表配置 | 生成与 `musicConfig.ts` 格式一致的 TS 片段，直接粘贴即用 |

## 安装

```bash
git clone <你的仓库地址>
cd firefly-music-parser
pip install -r requirements.txt
```

可选依赖：[ffmpeg](https://ffmpeg.org/download.html)（用于封面缩放和音频压缩；未安装时封面保存原图、大音频原样复制）。

## 使用

**推荐用法（零参数）**：把音频文件放进脚本目录下的 `music/` 文件夹，直接运行：

```bash
python3 music_parser.py
```

脚本自动读取 `music/` 里的所有音频，结果输出到 `music/output/`（与源音频同处一个文件夹）。

也可以自定义输入输出：

```bash
# 单个文件（歌词默认原语言）
python3 music_parser.py "歌曲.mp3"

# 指定目录 + 指定输出位置
python3 music_parser.py ~/Music/ -o my-output

# 歌词仅中文翻译（英文歌显示中文，无翻译时回退原语言）
python3 music_parser.py --lyric-lang trans

# 歌词原文 + 翻译合并显示
python3 music_parser.py --lyric-lang merge

# 跳过歌词下载（只要标签和封面）
python3 music_parser.py --no-lrc
```

### 全部参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `input` | 脚本目录下的 `music/` | 音频文件或包含音频的目录（递归扫描 mp3/flac/m4a/ogg/wav/opus） |
| `-o, --output` | 输入目录下的 `output/` | 输出目录 |
| `--size` | `500` | 封面边长像素，`0` 为原始尺寸 |
| `--lyric-lang` | `orig` | 歌词语言：`orig` 原语言 / `trans` 仅翻译 / `merge` 原文+翻译合并 |
| `--no-lrc` | - | 跳过歌词下载 |

## 输出结构

默认输入输出都在 `music/` 文件夹内：

```
music/                    ← 你放音频的地方
├── 歌曲A.mp3              输入（保持原样）
├── 歌曲B.flac
└── output/               ← 解析结果
    ├── assets/music/                          复制到 Firefly 的 public/ 下
    │   ├── 艺术家 - 歌名.mp3                   音频（重命名整理）
    │   ├── cover/
    │   │   └── 艺术家 - 歌名.jpg               封面
    │   └── lrc/
    │       └── 艺术家 - 歌名.lrc               歌词
    ├── musicConfig.local.ts                   粘贴进 src/config/musicConfig.ts
    └── playlist.json                          同内容 JSON 版本
```

再次运行会自动跳过 `output/` 目录，只处理新放入的音频。

## 接入 Firefly 三步

1. 复制资源：`cp -r music/output/assets/ <你的Firefly>/public/`
2. 打开 `music/output/musicConfig.local.ts`，把 `local: { ... }` 整块替换进 `src/config/musicConfig.ts`
3. 确认 `mode: "local"`，构建生效

## 说明

- **大文件处理**：超过 20MB 的音频自动转码为 320kbps mp3（无损 flac 常见场景）；压缩后仍超过 20MB（说明时长超过 8 分钟左右）会输出警告，文件仍正常输出，介意体积可手动截取或用 `ffmpeg -b:a 192k` 进一步压低码率
- 歌词使用网易云音乐的公开接口，无需账号或 key；已内置请求间隔避免风控，批量处理大曲库建议分批
- 未匹配到歌词 / 无内嵌封面的歌曲会跳过对应字段，不影响播放（`cover`、`lrc` 均为可选项）
- 仅适合个人博客等非商业用途，歌词版权归原平台及作者所有

## License

MIT
