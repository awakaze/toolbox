# Toolbox 小工具集

存放各种实用小工具的仓库，每个工具一个独立文件夹，互不依赖。

## 工具列表

| 工具 | 说明 | 语言 | 依赖 |
|---|---|---|---|
| [firefly-music-parser](./firefly-music-parser) | 为 Firefly 博客主题本地音乐模式一键解析音频标签、封面、歌词并生成配置 | Python | requests, mutagen（ffmpeg 可选） |
| [moe-icp-ids](./moe-icp-ids) | 从萌ICP 分页抓取可认领的萌号（备案号），去重排序后导出文本 | Python | requests |
| [trae-checkin](./trae-checkin) | Trae CN（TraeWork）每日自动签到领积分，支持本机登录态自动解密、多账号与通知推送 | Python | pycryptodome（可选，纯标准库可跑） |

## 目录约定

```
toolbox/
├── README.md            本文件：工具索引
├── CLAUDE.md            AI 代理：工程约定与提交规范
├── CONTEXT.md           领域词汇表（术语）
├── .gitignore           通用忽略规则
├── docs/
│   └── adr/             架构决策记录
└── <工具名>/
    ├── README.md        该工具的完整使用文档
    ├── requirements.txt 该工具的依赖（Python 项目）
    └── ...              源码
```

- 每个工具文件夹自包含：独立 README、独立依赖文件，进对应目录即可运行
- 新增工具后在上方表格登记一行

## 快速开始

```bash
git clone <仓库地址>
cd toolbox

# 以 firefly-music-parser 为例
cd firefly-music-parser
pip install -r requirements.txt
python3 music_parser.py --help
```

## License

MIT
